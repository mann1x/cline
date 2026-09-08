import {
	type ApplyPatchExecutor,
	type ApplyPatchInput,
	computePatchChanges,
	createApplyPatchExecutor,
	createEditorExecutor,
	type EditFileInput,
	type EditorExecutor,
	PatchActionType,
	type ReadReceipts,
} from "@cline/core"
import type { AgentToolContext } from "@cline/shared"
import * as fs from "fs/promises"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import type { EditPreview } from "@/integrations/editor/EditPreview"
import { Logger } from "@/shared/services/Logger"

/**
 * How long an auto-approved edit's preview stays visible after the write, so the
 * user can watch the change land without stalling the agent loop for long.
 * Manually-approved edits don't need this: the preview is open while the user decides.
 */
const AUTO_APPROVE_PREVIEW_LINGER_MS = 1_500

/**
 * Upper bound on opening a diff preview. `vscode.diff` can stall on a busy or wedged
 * workbench; the preview is purely cosmetic, so a stall must never block the approval
 * ask or eat into the edit tool's own execution timeout — the edit proceeds without it.
 */
const PREVIEW_OPEN_TIMEOUT_MS = 5_000

export interface SdkDiffEditCoordinatorOptions {
	/** Workspace root used to resolve relative tool paths. */
	getCwd: () => Promise<string>
	/** When Background Edit is enabled, edits apply headlessly with no preview. */
	isBackgroundEditEnabled: () => boolean
	/** Injectable for tests. Defaults to the host-registered factory. */
	createEditPreview?: () => EditPreview
	/** Injectable for tests. Defaults to the SDK's disk-writing editor executor. */
	fallbackEditorExecutor?: EditorExecutor
	/**
	 * Record of what has been read, shared with the `read_files` executor.
	 * Without it the read-before-edit guard is off; with a *different* object
	 * it would refuse every edit, so there is one registry per controller.
	 */
	receipts?: ReadReceipts
	/** Injectable for tests. Defaults to the SDK's disk-writing apply_patch executor. */
	fallbackApplyPatchExecutor?: ApplyPatchExecutor
	/** Test seam: overrides the auto-approve preview linger. */
	autoApprovePreviewLingerMs?: number
	/** Test seam: overrides how long a preview open may take before the edit proceeds without it. */
	previewOpenTimeoutMs?: number
	/** Injectable for tests. Defaults to opening the file via the host's showTextDocument. */
	showEditedFile?: (absolutePath: string) => Promise<void>
}

interface DiffEditSession {
	/** Undefined once the preview has been displaced by a newer same-file preview. */
	preview: EditPreview | undefined
	absolutePath: string
	/** File to show after the write; differs from absolutePath for apply_patch moves. */
	revealPath: string
}

/**
 * Shows a read-only diff preview of SDK edit-tool changes (editor / apply_patch).
 *
 * The preview is a virtual-document diff — both sides are virtual, the real file is
 * never opened or modified by the preview — so opening it has no side effects,
 * rejecting an edit only closes a tab, and multiple previews (even of the same file)
 * can't interfere with each other. The actual write is always the SDK's default
 * disk-writing executor, which the overridden executors delegate to after closing
 * the preview; its results and error strings reach the model unchanged.
 *
 * Previews open at approval time (the SDK surfaces tool input only after the model's
 * stream completes, so the approval callback is the only pre-execution point with
 * full input; streaming-during-generation is not possible). Auto-approved edits get
 * a brief preview during execution instead.
 *
 * After a successful write, the edited file is opened in a regular editor tab just
 * before the preview closes, so the user is left looking at the file — the same
 * show-file-then-close-diff order the legacy DiffViewProvider used.
 */
export class SdkDiffEditCoordinator {
	private readonly sessions = new Map<string, DiffEditSession>()
	private readonly fallbackEditorExecutor: EditorExecutor
	private readonly fallbackApplyPatchExecutor: ApplyPatchExecutor
	private readonly autoApprovePreviewLingerMs: number
	private readonly previewOpenTimeoutMs: number

	constructor(private readonly options: SdkDiffEditCoordinatorOptions) {
		// Same registry the workspace reader records into, or the read-before-edit
		// guard never sees the reads it is meant to check.
		this.fallbackEditorExecutor = options.fallbackEditorExecutor ?? createEditorExecutor({ receipts: options.receipts })
		this.fallbackApplyPatchExecutor = options.fallbackApplyPatchExecutor ?? createApplyPatchExecutor()
		this.autoApprovePreviewLingerMs = options.autoApprovePreviewLingerMs ?? AUTO_APPROVE_PREVIEW_LINGER_MS
		this.previewOpenTimeoutMs = options.previewOpenTimeoutMs ?? PREVIEW_OPEN_TIMEOUT_MS
	}

	/**
	 * Opens the diff preview for an edit tool BEFORE its approval ask is shown, so the
	 * user decides while looking at the actual change. Never throws; on any failure the
	 * approval flow proceeds without a preview and the executor still applies the edit.
	 */
	async openForApproval(toolCallId: string, toolName: string, input: unknown): Promise<void> {
		if (this.options.isBackgroundEditEnabled() || this.sessions.has(toolCallId)) {
			return
		}
		try {
			if (toolName === "editor") {
				await this.openEditorPreview(toolCallId, input as EditFileInput)
			} else if (toolName === "apply_patch") {
				await this.openPatchPreview(toolCallId, input as ApplyPatchInput)
			}
		} catch (error) {
			Logger.warn(`[SdkDiffEditCoordinator] Failed to open diff preview for ${toolName}: ${error}`)
			await this.discardPreview(toolCallId)
		}
	}

	/**
	 * The `editor` tool executor override: delegate the write to the SDK's disk executor,
	 * with the preview visible around it. Auto-approved edits (no pre-approval preview)
	 * get a brief preview that lingers shortly after the write so the user sees it land.
	 */
	async executeEditorTool(input: EditFileInput, cwd: string, context: AgentToolContext): Promise<string> {
		const toolCallId = context.toolCallId ?? ""
		const hadPreApprovalPreview = this.sessions.has(toolCallId)
		try {
			if (!hadPreApprovalPreview && !this.options.isBackgroundEditEnabled()) {
				// Auto-approved (or hook-approved) edit: no preview was opened at approval
				// time, so show one now. Best-effort — never blocks the edit.
				try {
					await this.openEditorPreview(toolCallId, input)
				} catch (error) {
					Logger.warn(`[SdkDiffEditCoordinator] Failed to show auto-approve preview: ${error}`)
				}
			}
			const result = await this.fallbackEditorExecutor(input, cwd, context)
			if (!hadPreApprovalPreview && this.sessions.get(toolCallId)?.preview) {
				// Keep the auto-approve preview visible briefly after the write; an abort
				// just cuts the linger short (the edit has already been applied).
				await lingerDelay(this.autoApprovePreviewLingerMs, context.signal)
			}
			if (!context.signal?.aborted) {
				await this.showEditedFile(this.livePreviewRevealPath(toolCallId))
			}
			return result
		} finally {
			await this.discardPreview(toolCallId)
		}
	}

	/**
	 * The `apply_patch` tool executor override: manually-approved patches close their
	 * approval preview before applying; auto-approved patches show a brief preview
	 * around execution, matching the `editor` tool behavior.
	 */
	async executeApplyPatchTool(input: ApplyPatchInput, cwd: string, context: AgentToolContext): Promise<string> {
		const toolCallId = context.toolCallId ?? ""
		const hadPreApprovalPreview = this.sessions.has(toolCallId)
		// The pre-approval preview is discarded before the patch applies, so remember
		// which file it showed for the post-edit reveal.
		const preApprovalRevealPath = this.livePreviewRevealPath(toolCallId)
		try {
			if (hadPreApprovalPreview) {
				await this.discardPreview(toolCallId)
			} else if (!this.options.isBackgroundEditEnabled()) {
				try {
					await this.openPatchPreview(toolCallId, input)
				} catch (error) {
					Logger.warn(`[SdkDiffEditCoordinator] Failed to show auto-approve patch preview: ${error}`)
				}
			}

			const result = await this.fallbackApplyPatchExecutor(input, cwd, context)
			if (!hadPreApprovalPreview && this.sessions.get(toolCallId)?.preview) {
				await lingerDelay(this.autoApprovePreviewLingerMs, context.signal)
			}
			if (!context.signal?.aborted) {
				await this.showEditedFile(preApprovalRevealPath ?? this.livePreviewRevealPath(toolCallId))
			}
			return result
		} finally {
			await this.discardPreview(toolCallId)
		}
	}

	/**
	 * The reveal path for a tool call whose preview tab is still open. Undefined once
	 * the preview was superseded by a newer same-file preview (the newer diff should
	 * stay frontmost), failed to open, or was never opened (background edit).
	 */
	private livePreviewRevealPath(toolCallId: string): string | undefined {
		const session = this.sessions.get(toolCallId)
		return session?.preview ? session.revealPath : undefined
	}

	/**
	 * Opens the edited file in a regular editor tab after a successful write, so it
	 * stays visible once the preview diff tab closes — matching the legacy
	 * DiffViewProvider.saveChanges() flow (show the file, then close the diff).
	 * preserveFocus keeps the user's focus (e.g. the chat input) where it was.
	 * Callers skip the reveal when no live preview accompanied the edit (background
	 * edit, failed preview open, superseded by a newer same-file preview) and when
	 * the task was aborted mid-edit — the reveal accompanies the diff, not the write.
	 * Best-effort: a failure only loses the reveal, never the edit result.
	 */
	private async showEditedFile(absolutePath: string | undefined): Promise<void> {
		if (!absolutePath) {
			return
		}
		try {
			if (this.options.showEditedFile) {
				await this.options.showEditedFile(absolutePath)
			} else {
				await HostProvider.window.showTextDocument({
					path: absolutePath,
					options: { preserveFocus: true, preview: false },
				})
			}
		} catch (error) {
			Logger.warn(`[SdkDiffEditCoordinator] Failed to show edited file ${absolutePath}: ${error}`)
		}
	}

	/** Closes one preview (reject / abort / edit applied). Never throws; unknown ids are a no-op. */
	async discardPreview(toolCallId: string): Promise<void> {
		const session = this.sessions.get(toolCallId)
		this.sessions.delete(toolCallId)
		if (!session?.preview) {
			return
		}
		try {
			await session.preview.close()
		} catch (error) {
			Logger.warn(`[SdkDiffEditCoordinator] Failed to close diff preview: ${error}`)
		}
	}

	/** Closes every open preview. Called on turn end, task end, and controller dispose. */
	async discardAllPreviews(reason: string): Promise<void> {
		if (this.sessions.size === 0) {
			return
		}
		Logger.log(`[SdkDiffEditCoordinator] Closing ${this.sessions.size} diff preview(s): ${reason}`)
		for (const toolCallId of [...this.sessions.keys()]) {
			await this.discardPreview(toolCallId)
		}
	}

	private async openEditorPreview(toolCallId: string, input: EditFileInput): Promise<void> {
		if (typeof input?.path !== "string" || input.path.length === 0 || typeof input.new_text !== "string") {
			throw new Error("editor input missing path or new_text")
		}
		const cwd = await this.options.getCwd()
		const absolutePath = resolveEditPath(cwd, input.path)
		let originalContent: string | undefined
		try {
			originalContent = await fs.readFile(absolutePath, "utf-8")
		} catch {
			originalContent = undefined
		}
		if (input.insert_line != null && originalContent === undefined) {
			// The SDK's insert path requires an existing file; skip the preview and let
			// the executor produce its canonical error.
			throw new Error(`cannot insert into missing file ${absolutePath}`)
		}
		const editType = originalContent === undefined ? "create" : "modify"
		const newContent = computeNewEditorContent(originalContent ?? "", input, absolutePath, editType)

		await this.openPreview(toolCallId, {
			absolutePath,
			displayPath: input.path,
			editType,
			leftContent: originalContent ?? "",
			rightContent: newContent,
		})
	}

	private async openPatchPreview(toolCallId: string, input: ApplyPatchInput): Promise<void> {
		if (typeof input?.input !== "string" || input.input.length === 0) {
			return
		}
		const cwd = await this.options.getCwd()
		const { changes } = await computePatchChanges(input.input, cwd)
		// Preview the first file the patch creates or updates. Multi-file patches are
		// uncommon; any remaining files apply without a preview.
		const first = Object.entries(changes).find(
			([, change]) =>
				(change.type === PatchActionType.ADD || change.type === PatchActionType.UPDATE) &&
				change.newContent !== undefined,
		)
		if (!first) {
			return
		}
		const [filePath, change] = first
		await this.openPreview(toolCallId, {
			absolutePath: resolveEditPath(cwd, filePath),
			revealPath: resolveEditPath(cwd, change.movePath ?? filePath),
			displayPath: filePath,
			editType: change.type === PatchActionType.ADD ? "create" : "modify",
			leftContent: change.oldContent ?? "",
			rightContent: change.newContent ?? "",
		})
	}

	private async openPreview(
		toolCallId: string,
		content: {
			absolutePath: string
			revealPath?: string
			displayPath: string
			editType: "create" | "modify"
			leftContent: string
			rightContent: string
		},
	): Promise<void> {
		// A newer preview for the same file supersedes an older pending one (approvals
		// resolve sequentially, so the older edit is already decided — its executor only
		// needs the session entry, not the tab).
		for (const [id, session] of this.sessions) {
			if (session.preview && session.absolutePath === content.absolutePath) {
				try {
					await session.preview.close()
				} catch (error) {
					Logger.warn(`[SdkDiffEditCoordinator] Failed to close superseded preview: ${error}`)
				}
				session.preview = undefined
				Logger.log(`[SdkDiffEditCoordinator] Superseded pending preview ${id} for ${content.displayPath}`)
			}
		}

		const preview = this.createPreview()
		const fileName = path.basename(content.absolutePath)
		const title =
			content.editType === "create"
				? `${fileName}: New File (Preview)`
				: `${fileName}: Original ↔ Cline's Changes (Preview)`
		// The preview is cosmetic, so a vscode.diff call that rejects or stalls must never
		// block the approval ask or fail the edit: race the open against a timer and let
		// callers catch the failure and proceed without a preview.
		const opened = preview.open({
			title,
			absolutePath: content.absolutePath,
			displayPath: content.displayPath,
			leftContent: content.leftContent,
			rightContent: content.rightContent,
		})
		const failure = await Promise.race([
			opened.then(
				() => undefined,
				(error) => new Error(`diff preview failed to open: ${error}`),
			),
			delay(this.previewOpenTimeoutMs).then(
				() => new Error(`diff preview did not open within ${this.previewOpenTimeoutMs}ms`),
			),
		])
		if (failure) {
			// Whenever the open settles — a failed open may have partially opened a tab, a
			// stalled one may open late — close it so no orphaned tab lingers. (The session
			// is never registered on failure, so discardPreview couldn't reach it.)
			void opened.catch(() => {}).finally(() => preview.close().catch(() => {}))
			throw failure
		}
		this.sessions.set(toolCallId, {
			preview,
			absolutePath: content.absolutePath,
			revealPath: content.revealPath ?? content.absolutePath,
		})
	}

	private createPreview(): EditPreview {
		return this.options.createEditPreview?.() ?? HostProvider.get().createEditPreview()
	}
}

/** Mirrors the executor's detectLineEnding: one CRLF anywhere makes the file CRLF. */
function detectLineEnding(content: string): "\r\n" | "\n" {
	return content.includes("\r\n") ? "\r\n" : "\n"
}

/** Mirrors the executor's normalizeLineEndings, so LF input matches a CRLF file. */
function normalizeLineEndings(text: string, eol: "\r\n" | "\n"): string {
	return text.split(/\r\n|\n/).join(eol)
}

/** Mirrors the executor's LINE_NUMBER_GUTTER and its two helpers. */
const LINE_NUMBER_GUTTER = /^\s*\d+\s\|\s?/

function hasLineNumberGutter(text: string): boolean {
	const lines = text.split("\n").filter((line) => line.trim() !== "")
	return lines.length > 0 && lines.every((line) => LINE_NUMBER_GUTTER.test(line))
}

function stripLineNumberGutter(text: string): string {
	return text
		.split("\n")
		.map((line) => (line.trim() === "" ? line : line.replace(LINE_NUMBER_GUTTER, "")))
		.join("\n")
}

/** Mirrors the executor's unanchored-range guard (MAX_UNANCHORED_RANGE_LINES/SHARE). */
const MAX_UNANCHORED_RANGE_LINES = 60
const MAX_UNANCHORED_RANGE_SHARE = 0.5

function countOccurrences(haystack: string, needle: string): number {
	return needle.length === 0 ? 0 : haystack.split(needle).length - 1
}

function replaceNthOccurrence(content: string, oldStr: string, newStr: string, occurrence: number): string {
	let index = -1
	for (let n = 0; n < occurrence; n++) {
		index = content.indexOf(oldStr, index + (n === 0 ? 0 : 1))
		if (index < 0) {
			return content
		}
	}
	return content.slice(0, index) + newStr + content.slice(index + oldStr.length)
}

function assertLineInRange(line: number, lineCount: number, field: string): void {
	if (line < 1 || line > lineCount) {
		throw new Error(
			`Invalid ${field}: ${line}. The file has ${lineCount} line(s), so ${field} must be between 1 and ${lineCount}.`,
		)
	}
}

function assertColumnInRange(column: number, lineText: string, line: number, field: string): void {
	if (column < 1 || column > lineText.length) {
		throw new Error(
			`Invalid ${field}: ${column}. Line ${line} has ${lineText.length} character(s), so ${field} must be between 1 and ${lineText.length}.`,
		)
	}
}

/**
 * Computes the full proposed file content for an `editor` tool input, mirroring the
 * SDK executor's semantics (sdk/packages/core/src/extensions/tools/executors/editor.ts)
 * so the preview shows exactly what the executor will write. Inputs the SDK would
 * reject throw here too, and the preview is simply skipped.
 *
 * The branch order below is the executor's own, and it matters: when `start_line` is
 * present the executor replaces by line number and never looks at `old_text`, so a call
 * carrying both must not fall through to the match path.
 *
 * Measured: this function knew only `insert_line`, create and `old_text` while the
 * executor had grown line ranges, column ranges and column inserts. In a 58-minute
 * session 29 of 30 `editor` calls threw here — 20 "`old_text` is required" and 9 "text
 * not found" — so every edit applied with no diff preview at all. Line-range edits are
 * now the common shape, which is exactly the shape that was missing. `editor-preview-
 * mirror.test.ts` runs both implementations over the same inputs so the next divergence
 * fails a test instead of silently costing the preview.
 *
 * Like the executor, old/new text are normalized to the file's own line endings
 * before matching: reads strip "\r", so models emit LF-only text even for CRLF
 * files, and an exact match would fail on every multi-line old_text in a CRLF
 * file — silently skipping the preview while the executor applies the edit
 * (github.com/cline/cline/issues/13296).
 */
export function computeNewEditorContent(
	originalContent: string,
	input: EditFileInput,
	filePath: string,
	editType: "create" | "modify",
): string {
	const eol = detectLineEnding(originalContent)
	const lines = originalContent.split(/\r\n|\n/)

	if (input.insert_line != null) {
		if (input.start_line != null) {
			throw new Error(
				"`insert_line` adds text at a boundary and `start_line` replaces existing lines. Send one or the other.",
			)
		}
		if (input.insert_column != null) {
			assertLineInRange(input.insert_line, lines.length, "insert_line")
			const lineText = lines[input.insert_line - 1] ?? ""
			// One past the last character is the append position.
			if (input.insert_column < 1 || input.insert_column > lineText.length + 1) {
				throw new Error(
					`Invalid insert_column: ${input.insert_column}. Line ${input.insert_line} has ${lineText.length} character(s), so insert_column must be between 1 and ${lineText.length + 1}. Use ${lineText.length + 1} to append at the end of the line.`,
				)
			}
			lines[input.insert_line - 1] =
				`${lineText.slice(0, input.insert_column - 1)}${input.new_text}${lineText.slice(input.insert_column - 1)}`
			return lines.join(eol)
		}
		const maxBoundaryLine = lines.length + 1
		if (input.insert_line < 1 || input.insert_line > maxBoundaryLine) {
			throw new Error(
				`Invalid insert_line: ${input.insert_line}. insert_line must be a positive one-based boundary line in the range 1-${maxBoundaryLine}. Use ${maxBoundaryLine} to append at EOF.`,
			)
		}
		lines.splice(input.insert_line - 1, 0, ...input.new_text.split(/\r\n|\n/))
		return lines.join(eol)
	}

	if (input.insert_column != null) {
		throw new Error("`insert_column` needs `insert_line` to say which line it is a column of.")
	}

	if (input.start_line != null) {
		if (editType === "create") {
			throw new Error(`Cannot replace lines in ${filePath}: the file does not exist. Omit start_line to create it.`)
		}
		const endLine = input.end_line ?? input.start_line

		if (input.start_column != null) {
			assertLineInRange(input.start_line, lines.length, "start_line")
			assertLineInRange(endLine, lines.length, "end_line")
			if (endLine < input.start_line) {
				throw new Error(`Invalid end_line: ${endLine}. It must be at least start_line (${input.start_line}).`)
			}
			const startLineText = lines[input.start_line - 1] ?? ""
			const endLineText = lines[endLine - 1] ?? ""
			const endColumn = input.end_column ?? input.start_column
			assertColumnInRange(input.start_column, startLineText, input.start_line, "start_column")
			assertColumnInRange(endColumn, endLineText, endLine, "end_column")
			if (input.start_line === endLine && endColumn < input.start_column) {
				throw new Error(
					`Invalid end_column: ${endColumn}. On a single line it must be at least start_column (${input.start_column}). To insert without replacing anything, use insert_line with insert_column.`,
				)
			}
			const replaced = `${startLineText.slice(0, input.start_column - 1)}${input.new_text ?? ""}${endLineText.slice(endColumn)}`
			lines.splice(input.start_line - 1, endLine - input.start_line + 1, ...replaced.split(/\r\n|\n/))
			return lines.join(eol)
		}

		if (input.end_column != null) {
			throw new Error(
				"`end_column` needs `start_column`: without it the tool replaces whole lines and the column has nothing to bound.",
			)
		}

		if (input.start_line < 1 || input.start_line > lines.length) {
			throw new Error(
				`Invalid start_line: ${input.start_line}. The file has ${lines.length} line(s), so start_line must be between 1 and ${lines.length}.`,
			)
		}
		if (endLine < input.start_line) {
			throw new Error(`Invalid end_line: ${endLine}. It must be at least start_line (${input.start_line}).`)
		}
		// An end_line past the last line means "to the end of the file".
		const effectiveEndLine = Math.min(endLine, lines.length)
		const spanned = effectiveEndLine - input.start_line + 1
		// Lines 1..count is the stated whole-file rewrite, not a disguised one.
		const isFullSpanRewrite = input.start_line === 1 && effectiveEndLine === lines.length
		if (!isFullSpanRewrite && spanned > MAX_UNANCHORED_RANGE_LINES && spanned > lines.length * MAX_UNANCHORED_RANGE_SHARE) {
			throw new Error(
				`No replacement performed: lines ${input.start_line}-${effectiveEndLine} is ${spanned} of the file's ${lines.length} lines, and the call carries no \`old_text\` to check it against.`,
			)
		}
		// An empty new_text deletes the range outright.
		const replacement = input.new_text == null || input.new_text === "" ? [] : input.new_text.split(/\r\n|\n/)
		lines.splice(input.start_line - 1, spanned, ...replacement)
		return lines.join(eol)
	}

	if (input.start_column != null || input.end_column != null) {
		throw new Error("`start_column`/`end_column` need `start_line` to say which line they are columns of.")
	}

	if (editType === "create") {
		return input.new_text
	}

	if (input.old_text == null) {
		throw new Error("Parameter `old_text` is required when editing an existing file without `insert_line` or `start_line`")
	}

	let oldStr = normalizeLineEndings(input.old_text, eol)
	let newStr = normalizeLineEndings(input.new_text ?? "", eol)
	let occurrences = countOccurrences(originalContent, oldStr)

	// The file decides: the gutter is only stripped when the stripped text then
	// actually occurs, so a file that genuinely contains `123 | ` is unaffected.
	if (occurrences === 0 && hasLineNumberGutter(oldStr)) {
		const strippedOld = stripLineNumberGutter(oldStr)
		const strippedOccurrences = countOccurrences(originalContent, strippedOld)
		if (strippedOccurrences > 0) {
			oldStr = strippedOld
			occurrences = strippedOccurrences
			if (hasLineNumberGutter(newStr)) {
				newStr = stripLineNumberGutter(newStr)
			}
		}
	}

	if (occurrences === 0) {
		throw new Error(`No replacement performed: text not found in ${filePath}.`)
	}
	if (input.replace_all) {
		return originalContent.split(oldStr).join(newStr)
	}
	if (input.occurrence != null) {
		if (input.occurrence < 1 || input.occurrence > occurrences) {
			throw new Error(
				`No replacement performed: occurrence ${input.occurrence} is out of range; the text appears ${occurrences} time(s) in ${filePath}.`,
			)
		}
		return replaceNthOccurrence(originalContent, oldStr, newStr, input.occurrence)
	}
	if (occurrences > 1) {
		throw new Error(`No replacement performed: multiple occurrences of text found in ${filePath}.`)
	}
	// Replacer function so "$"-sequences in new_text are inserted literally.
	return originalContent.replace(oldStr, () => newStr)
}

/** Mirrors the SDK executor's resolveFilePath (restrictToCwd=true): absolute paths pass through. */
function resolveEditPath(cwd: string, inputPath: string): string {
	const isAbsoluteInput = path.isAbsolute(inputPath)
	const resolved = isAbsoluteInput ? path.normalize(inputPath) : path.resolve(cwd, inputPath)
	if (isAbsoluteInput) {
		return resolved
	}
	const rel = path.relative(cwd, resolved)
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Path must stay within cwd: ${inputPath}`)
	}
	return resolved
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Waits `ms`, resolving early (never rejecting) if the signal aborts. */
function lingerDelay(ms: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.resolve()
	}
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		const onAbort = () => {
			clearTimeout(timer)
			resolve()
		}
		signal?.addEventListener("abort", onAbort, { once: true })
	})
}
