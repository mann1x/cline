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

function filterToPaths(diagnostics: FileDiagnostics[], absolutePaths: Set<string>): FileDiagnostics[] {
	return diagnostics.filter((file) => absolutePaths.has(path.resolve(file.filePath)))
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

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** The editor's current verdict on the whole workspace. */
export async function readHostDiagnostics(): Promise<FileDiagnostics[]> {
	return (await HostProvider.workspace.getDiagnostics({})).fileDiagnostics
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
					return undefined
				}
				pending.set(ctx.toolCall.toolCallId, {
					paths,
					before: filterToPaths(await read(), new Set(paths)),
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
				if (!block) {
					return undefined
				}
				return { result: { ...ctx.result, output: appendToOutput(ctx.result.output, block) } }
			} catch (error) {
				Logger.error("[EditorDiagnostics] failed to report diagnostics:", error)
				return undefined
			}
		},
	}
}
