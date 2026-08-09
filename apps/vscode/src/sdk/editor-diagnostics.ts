// Hands the model the editor's verdict on the file it just wrote.
//
// The IDE type-checks and lints every edit Cline makes, and none of it reached
// the model: workspace diagnostics were readable through exactly one path, the
// `@problems` mention, which only a user can type. So the model writes a file,
// VS Code underlines the broken line a second later, the user sees it, and the
// agent goes on to the next step believing the edit landed clean. Measured on a
// single-file build: a generated `introSound: getSound('level-start')',` left a
// stray quote, TypeScript flagged it immediately, and the run continued for
// several turns against a file that could not parse.
//
// This closes that loop for the two tools that write files. After an edit, the
// diagnostics that edit *introduced* are appended to the tool result.
//
// Only the new ones. A file with fifty pre-existing warnings is not a report
// about this edit, and re-sending them on every touch would cost more context
// than the edit itself — so `beforeTool` snapshots the file's diagnostics and
// `afterTool` reports the difference. The user can still ask for the whole
// picture with `@problems`.

import { appendFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { describeDelimiterBalance } from "@cline/core"
import type { AgentAfterToolContext, AgentBeforeToolContext, AgentHooks } from "@cline/shared"
import { getNewDiagnostics, singleFileDiagnosticsToProblemsString } from "@integrations/diagnostics"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { type Diagnostic, DiagnosticSeverity, type FileDiagnostics } from "@/shared/proto/index.cline"
import { Logger } from "@/shared/services/Logger"

/** Tools whose successful execution can leave a file in a state a linter judges. */
const FILE_WRITING_TOOLS = new Set(["editor", "apply_patch"])

/**
 * Severities worth a turn of the model's attention.
 *
 * Errors and warnings are claims that something is wrong. Information and hint
 * diagnostics are mostly editor affordances — "convert to template literal",
 * "this import could be type-only" — and a model handed them will act on them,
 * turning every edit into a style refactor nobody asked for.
 */
export const REPORTED_SEVERITIES = [DiagnosticSeverity.DIAGNOSTIC_ERROR, DiagnosticSeverity.DIAGNOSTIC_WARNING]

/**
 * Extensions whose diagnostics are never about the code the model wrote.
 *
 * A language server only produces diagnostics for files it can parse, so most
 * of the filtering happens upstream of this list. What it catches is the case
 * where Cline writes bytes rather than source — an audio file, an image, a
 * font, an archive — and something in the editor reads them as text anyway and
 * reports on the mojibake. That report is not actionable by anyone: the file is
 * correct, the reader is wrong, and the model cannot tell the difference.
 */
const OPAQUE_EXTENSIONS = new Set([
	".7z",
	".aac",
	".avi",
	".bin",
	".bmp",
	".class",
	".dll",
	".dylib",
	".eot",
	".exe",
	".flac",
	".gif",
	".gz",
	".ico",
	".jar",
	".jpeg",
	".jpg",
	".mov",
	".mp3",
	".mp4",
	".ogg",
	".otf",
	".pdf",
	".png",
	".so",
	".tar",
	".ttf",
	".wasm",
	".wav",
	".webm",
	".webp",
	".woff",
	".woff2",
	".zip",
])

/**
 * Diagnostics reported per file.
 *
 * A truncated list still says "this edit broke something, look here", which is
 * the whole job. An untruncated one can be longer than the file.
 */
export const MAX_DIAGNOSTICS_PER_FILE = 20

/**
 * How long to wait for the language server to catch up with the write.
 *
 * Diagnostics are published asynchronously and a request issued the instant an
 * edit lands reads the state before it. The wait ends early as soon as the
 * file's diagnostics stop changing, so the common case (a fast server, or a
 * clean edit that changes nothing) costs one poll interval rather than the
 * whole budget. The budget is small on purpose: this sits between the model and
 * its next turn, and a slow linter must not become a slow agent.
 */
export const SETTLE_POLL_MS = 250
export const SETTLE_TIMEOUT_MS = 2_000

/** Paths touched by a tool call, captured before it ran. */
type PendingSnapshot = {
	paths: string[]
	before: FileDiagnostics[]
}

export interface EditorDiagnosticsOptions {
	cwd: string
	/** Injection point for tests; defaults to the host bridge. */
	readDiagnostics?: () => Promise<FileDiagnostics[]>
	/** Injection point for tests; defaults to a real timer. */
	delay?: (ms: number) => Promise<void>
}

/**
 * Extract the files a file-writing tool call is about.
 *
 * `editor` names its file directly. `apply_patch` carries a patch body whose
 * grammar names the files in its headers, which is the only place they appear.
 */
export function readTargetPaths(toolName: string, input: unknown): string[] {
	if (toolName === "editor") {
		const filePath = (input as { path?: unknown } | undefined)?.path
		return typeof filePath === "string" && filePath.trim() !== "" ? [filePath] : []
	}
	if (toolName !== "apply_patch") {
		return []
	}
	const body = typeof input === "string" ? input : (input as { input?: unknown } | undefined)?.input
	if (typeof body !== "string") {
		return []
	}
	const paths: string[] = []
	for (const line of body.split("\n")) {
		const match = line.match(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/)
		if (match?.[1]) {
			paths.push(match[1])
		}
	}
	return paths
}

/**
 * Whether a file is one an editor diagnostic can say something useful about.
 *
 * Deliberately a rejection list rather than an allow list: the set of things VS
 * Code lints grows with every extension the user installs, and a Dockerfile, a
 * Makefile or a `.env` has no extension to allow in the first place.
 */
export function isLintableFile(filePath: string): boolean {
	return !OPAQUE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

/**
 * A path in the form used to compare two paths for identity.
 *
 * Windows filesystems are case-insensitive, and the two sides of this
 * comparison come from different places: the editor reports the path as the
 * workspace has it, and the model types the path itself. Measured on a live
 * session — the workspace was `c:\Users\manni\source\repos\test` and the model
 * asked about `C:\Users\...`. One capital letter, and `Set.has` said no.
 *
 * The consequence is the worst one available to this tool: no match means no
 * diagnostics, and no diagnostics reads as a clean file. Six consecutive
 * `check_file` calls answered "no problems reported by the editor" for a file
 * that `node --check` rejects, and the model believed them.
 *
 * Only the case is normalized. Symlinks, 8.3 short names and UNC spellings are
 * still distinct here, which is correct: this is a comparison key, not a
 * canonical path.
 */
export function comparablePath(filePath: string): string {
	const resolved = path.resolve(filePath)
	return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/** Whether two paths name the same file, as this platform judges it. */
export function samePath(a: string, b: string): boolean {
	return comparablePath(a) === comparablePath(b)
}

function filterToPaths(diagnostics: FileDiagnostics[], absolutePaths: Set<string>): FileDiagnostics[] {
	const wanted = new Set([...absolutePaths].map(comparablePath))
	return diagnostics.filter((file) => wanted.has(comparablePath(file.filePath)))
}

export function isReportableDiagnostic(diagnostic: Diagnostic): boolean {
	return REPORTED_SEVERITIES.includes(diagnostic.severity)
}

/**
 * Render the diagnostics an edit introduced, or an empty string when it
 * introduced none — silence is the correct output for a clean edit, and the
 * cheapest.
 */
export async function renderFileDiagnostics(filePath: string, diagnostics: readonly Diagnostic[]): Promise<string> {
	const reportable = diagnostics.filter(isReportableDiagnostic)
	if (reportable.length === 0) {
		return ""
	}
	const shown = reportable.slice(0, MAX_DIAGNOSTICS_PER_FILE)
	const section = await singleFileDiagnosticsToProblemsString(filePath, shown)
	if (!section) {
		return ""
	}
	const omitted = reportable.length - shown.length
	return omitted > 0 ? `${section}\n- ...and ${omitted} more` : section
}

export async function formatIntroducedDiagnostics(before: FileDiagnostics[], after: FileDiagnostics[]): Promise<string> {
	const sections: string[] = []
	for (const file of getNewDiagnostics(before, after)) {
		const section = await renderFileDiagnostics(file.filePath, file.diagnostics)
		if (section !== "") {
			sections.push(section)
		}
	}
	if (sections.length === 0) {
		return ""
	}
	return [
		"<editor_diagnostics>",
		"The editor reported these problems on the file(s) this edit touched. They were not present before it.",
		sections.join("\n\n"),
		"</editor_diagnostics>",
	].join("\n")
}

/**
 * Append a rendered block to a tool result without destroying its shape.
 *
 * The file-writing tools return a `ToolOperationResult`, whose `result` field is
 * what the model reads; anything else is stringified by the transport, so the
 * block goes where a string will survive.
 */
export function appendToOutput(output: unknown, block: string): unknown {
	if (output && typeof output === "object" && "result" in output) {
		const record = output as Record<string, unknown>
		const existing = typeof record.result === "string" ? record.result : ""
		return { ...record, result: existing === "" ? block : `${existing}\n\n${block}` }
	}
	if (typeof output === "string") {
		return output === "" ? block : `${output}\n\n${block}`
	}
	return output
}

/**
 * Mark a tool result as having made the file worse.
 *
 * The loop tracker asks one question of every finished call: did it get
 * anywhere? It answered that from failure alone — a thrown error, or the
 * `{success: false}` envelope — which is blind to the way a weaker model
 * actually stalls. Measured on a live session: eight consecutive `editor` calls
 * all returned `success: true` while the file's diagnostics went 2 → 20 and the
 * class under repair ended up in the file three times. Nothing failed, so the
 * barren-repeat counter was reset on every one of those turns and the loop
 * detector could never fire.
 *
 * An edit that introduces diagnostics did not get anywhere, whatever its
 * envelope says. The flag rides on the result so the runtime can read it
 * without this package having to know about the loop tracker.
 */
/**
 * How many diagnostics on these files are worth a turn of attention.
 *
 * The count, not the novelty. The first cut of this marked an edit regressed
 * whenever it introduced *any* diagnostic that was not there before, and a
 * live run showed what that costs: edits that took the file from 14 problems
 * to 10, from 12 to 11, from 9 to 6 — real progress every time — were all
 * scored as having got nowhere, because each of them also moved one error to
 * a new line. Repairing a broken file almost always shifts a diagnostic while
 * removing others, so the novel-diagnostic test fires on exactly the work it
 * should be encouraging.
 *
 * A net-neutral edit is left unflagged too. It is not progress, but a loop
 * stop is expensive and being wrong here ends a task that was working; the
 * repeat detectors already cover a model that churns without moving.
 */
function countReportable(files: readonly FileDiagnostics[]): number {
	let total = 0
	for (const file of files) {
		total += file.diagnostics.filter(isReportableDiagnostic).length
	}
	return total
}

export function markRegressed(output: unknown): unknown {
	if (output && typeof output === "object" && !Array.isArray(output)) {
		return { ...(output as Record<string, unknown>), regressed: true }
	}
	return output
}

/**
 * The delimiter verdict for the files an edit touched, when they have one.
 *
 * `check_file` already computes this and says exactly the thing a stuck model
 * needs — "counting only code, this line has 1 more `}` than `{` — that is the
 * edit". In the measured session it was never called: across 111,790 characters
 * of reasoning the model named two of the twenty-five tools available to it and
 * `check_file` was not one of them. So this stops depending on the model
 * choosing it, and attaches the verdict to the edit that caused the trouble.
 */
async function describeBalanceForPaths(paths: readonly string[]): Promise<string> {
	const sections: string[] = []
	for (const filePath of paths) {
		try {
			const text = await readFile(filePath, "utf8")
			const verdict = describeDelimiterBalance(filePath, text)
			if (verdict) {
				sections.push(verdict)
			}
		} catch {
			// A file that cannot be read has no verdict; the diagnostics block
			// above is still worth sending on its own.
		}
	}
	return sections.join("\n\n")
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The editor's current verdict on the whole workspace. */
export async function readHostDiagnostics(): Promise<FileDiagnostics[]> {
	return (await HostProvider.workspace.getDiagnostics({})).fileDiagnostics
}

/**
 * Append one line per edit to `<tmpdir>/cline-editor-diagnostics.jsonl`.
 *
 * Silence from this feature is ambiguous by design — a clean edit and a broken
 * lookup both produce nothing — and the first live run was exactly that: four
 * edits, no block, no way to tell which link failed. This makes the difference
 * visible: what the editor was asked about, how many diagnostics it held before
 * and after, and whether anything was new.
 *
 * Best-effort and never throws; a diagnostic about diagnostics must not be able
 * to break an edit.
 */
function appendEditorDiagnosticsTrace(entry: Record<string, unknown>): void {
	try {
		appendFileSync(
			path.join(tmpdir(), "cline-editor-diagnostics.jsonl"),
			`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
			"utf8",
		)
	} catch {
		// ignored
	}
}

/**
 * Read the touched files' diagnostics once the language server has stopped
 * changing its mind, or once the budget runs out — whichever comes first.
 */
export async function readSettledDiagnostics(
	absolutePaths: Set<string>,
	read: () => Promise<FileDiagnostics[]>,
	delay: (ms: number) => Promise<void>,
	budget: { pollMs?: number; timeoutMs?: number } = {},
): Promise<FileDiagnostics[]> {
	const pollMs = budget.pollMs ?? SETTLE_POLL_MS
	let previous = ""
	let latest: FileDiagnostics[] = []
	const deadline = Date.now() + (budget.timeoutMs ?? SETTLE_TIMEOUT_MS)
	do {
		await delay(pollMs)
		latest = filterToPaths(await read(), absolutePaths)
		const fingerprint = JSON.stringify(latest)
		if (fingerprint === previous) {
			return latest
		}
		previous = fingerprint
	} while (Date.now() < deadline)
	return latest
}

/**
 * Hooks that report an edit's new diagnostics back to the model.
 *
 * Composed with the file-based hook adapter rather than folded into it: that
 * one bridges user-authored hook scripts and is disabled when the user has
 * none, and this is not optional in the same way.
 */
export function createEditorDiagnosticsHooks(options: EditorDiagnosticsOptions): AgentHooks {
	const read = options.readDiagnostics ?? readHostDiagnostics
	const delay = options.delay ?? sleep
	const pending = new Map<string, PendingSnapshot>()

	const resolveTargets = (toolName: string, input: unknown): string[] =>
		readTargetPaths(toolName, input)
			.filter(isLintableFile)
			.map((filePath) => path.resolve(options.cwd, filePath))

	return {
		async beforeTool(ctx: AgentBeforeToolContext): Promise<undefined> {
			try {
				if (!FILE_WRITING_TOOLS.has(ctx.toolCall.toolName)) {
					return undefined
				}
				const paths = resolveTargets(ctx.toolCall.toolName, ctx.input)
				if (paths.length === 0) {
					appendEditorDiagnosticsTrace({
						phase: "before",
						tool: ctx.toolCall.toolName,
						targets: [],
						rawPaths: readTargetPaths(ctx.toolCall.toolName, ctx.input),
					})
					return undefined
				}
				const all = await read()
				pending.set(ctx.toolCall.toolCallId, {
					paths,
					before: filterToPaths(all, new Set(paths)),
				})
				appendEditorDiagnosticsTrace({
					phase: "before",
					tool: ctx.toolCall.toolName,
					targets: paths,
					workspaceFiles: all.length,
					// The paths the editor is reporting on, so a match failure is
					// distinguishable from an editor that simply has nothing to say.
					workspaceSample: all.slice(0, 5).map((file) => file.filePath),
					matched: filterToPaths(all, new Set(paths)).length,
				})
			} catch (error) {
				Logger.error("[EditorDiagnostics] failed to snapshot diagnostics:", error)
			}
			return undefined
		},

		async afterTool(ctx: AgentAfterToolContext) {
			const snapshot = pending.get(ctx.toolCall.toolCallId)
			pending.delete(ctx.toolCall.toolCallId)
			try {
				// A failed edit changed nothing, so anything the editor reports
				// belongs to the file as it already was.
				if (!snapshot || ctx.result.isError) {
					return undefined
				}
				const after = await readSettledDiagnostics(new Set(snapshot.paths), read, delay)
				const block = await formatIntroducedDiagnostics(snapshot.before, after)
				// Only worth reading the file back when the edit already looks
				// wrong. A clean edit pays nothing for this.
				const balance = block ? await describeBalanceForPaths(snapshot.paths) : ""
				const wasCount = countReportable(snapshot.before)
				const nowCount = countReportable(after)
				const regressed = nowCount > wasCount
				appendEditorDiagnosticsTrace({
					phase: "after",
					tool: ctx.toolCall.toolName,
					targets: snapshot.paths,
					before: wasCount,
					after: nowCount,
					blockChars: block.length,
					balanceChars: balance.length,
					regressed,
				})
				if (!block) {
					return undefined
				}
				const appended = [block, balance].filter((part) => part !== "").join("\n\n")
				const output = appendToOutput(ctx.result.output, appended)
				return {
					result: {
						...ctx.result,
						output: regressed ? markRegressed(output) : output,
					},
				}
			} catch (error) {
				Logger.error("[EditorDiagnostics] failed to report diagnostics:", error)
				return undefined
			}
		},
	}
}
