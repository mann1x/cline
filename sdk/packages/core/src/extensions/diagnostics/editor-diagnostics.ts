// Hands the model the editor's verdict on the file it just wrote.
//
// The IDE type-checks and lints every edit Cerebriline makes, and none of it
// reached the model: the model writes a file, the editor underlines the broken
// line a second later, the user sees it, and the agent goes on to the next
// step believing the edit landed clean. Measured on a single-file build: a
// generated `introSound: getSound('level-start')',` left a stray quote,
// TypeScript flagged it immediately, and the run continued for several turns
// against a file that could not parse.
//
// This closes that loop for the two tools that write files. After an edit, the
// diagnostics that edit *introduced* are appended to the tool result.
//
// Only the new ones. A file with fifty pre-existing warnings is not a report
// about this edit, and re-sending them on every touch would cost more context
// than the edit itself -- so `beforeTool` snapshots the file's diagnostics and
// `afterTool` reports the difference.
//
// Host-agnostic: the extension reads VS Code, the CLI and automaticum's runner
// read the language servers they start (`createLspHost`). A host whose servers
// are not watching the disk passes `touch`, and the file is handed over before
// and after the edit.

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import {
	type AgentAfterToolContext,
	type AgentBeforeToolContext,
	type AgentHooks,
	editorFilePath,
} from "@cline/shared";
import { describeDelimiterBalance } from "../tools/delimiter-balance";
import {
	getNewDiagnostics,
	singleFileDiagnosticsToProblemsString,
} from "./render";
import type {
	DiagnosticSeverityName,
	HostDiagnostic,
	HostFileDiagnostics,
	ReadDiagnostics,
	ReadText,
	TouchDocument,
} from "./types";

/** Tools whose successful execution can leave a file in a state a linter judges. */
const FILE_WRITING_TOOLS = new Set(["editor", "apply_patch"]);

/**
 * Severities worth a turn of the model's attention.
 *
 * Errors and warnings are claims that something is wrong. Information and hint
 * diagnostics are mostly editor affordances -- "convert to template literal",
 * "this import could be type-only" -- and a model handed them will act on them,
 * turning every edit into a style refactor nobody asked for.
 */
export const REPORTED_SEVERITIES: readonly DiagnosticSeverityName[] = [
	"error",
	"warning",
];

/**
 * Extensions whose diagnostics are never about the code the model wrote: the
 * case where Cerebriline writes bytes rather than source and something in the
 * editor reads them as text anyway and reports on the mojibake.
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
]);

/**
 * Diagnostics reported per file. A truncated list still says "this edit broke
 * something, look here", which is the whole job. An untruncated one can be
 * longer than the file.
 */
export const MAX_DIAGNOSTICS_PER_FILE = 20;

/**
 * How long to wait for the language server to catch up with the write.
 *
 * Diagnostics are published asynchronously and a request issued the instant an
 * edit lands reads the state before it. The wait ends early as soon as the
 * file's diagnostics stop changing, so the common case costs one poll interval
 * rather than the whole budget. Small on purpose: this sits between the model
 * and its next turn, and a slow linter must not become a slow agent.
 */
export const SETTLE_POLL_MS = 250;
export const SETTLE_TIMEOUT_MS = 2_000;

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Extract the files a file-writing tool call is about.
 *
 * `editor` names its file directly. `apply_patch` carries a patch body whose
 * grammar names the files in its headers, which is the only place they appear.
 */
export function readTargetPaths(toolName: string, input: unknown): string[] {
	if (toolName === "editor") {
		const filePath = editorFilePath(input);
		return filePath !== undefined && filePath.trim() !== "" ? [filePath] : [];
	}
	if (toolName !== "apply_patch") {
		return [];
	}
	const body =
		typeof input === "string"
			? input
			: (input as { input?: unknown } | undefined)?.input;
	if (typeof body !== "string") {
		return [];
	}
	const paths: string[] = [];
	for (const line of body.split("\n")) {
		const match = line.match(
			/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/,
		);
		if (match?.[1]) {
			paths.push(match[1]);
		}
	}
	return paths;
}

/**
 * Whether a file is one an editor diagnostic can say something useful about.
 * A rejection list rather than an allow list: the set of things an editor
 * lints grows with every extension installed, and a Dockerfile, a Makefile or
 * a `.env` has no extension to allow in the first place.
 */
export function isLintableFile(filePath: string): boolean {
	return !OPAQUE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * A path in the form used to compare two paths for identity.
 *
 * Windows filesystems are case-insensitive, and the two sides come from
 * different places: the editor reports the path as the workspace has it, and
 * the model types it. Measured: the workspace was `c:\Users\...` and the model
 * asked about `C:\Users\...`, and six `check_file` calls answered "no problems"
 * for a file `node --check` rejects. Only the case is normalized; this is a
 * comparison key, not a canonical path.
 */
export function comparablePath(filePath: string): string {
	const resolved = path.resolve(filePath);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Whether two paths name the same file, as this platform judges it. */
export function samePath(a: string, b: string): boolean {
	return comparablePath(a) === comparablePath(b);
}

export function filterToPaths(
	diagnostics: readonly HostFileDiagnostics[],
	absolutePaths: ReadonlySet<string>,
): HostFileDiagnostics[] {
	const wanted = new Set([...absolutePaths].map(comparablePath));
	return diagnostics.filter((file) =>
		wanted.has(comparablePath(file.filePath)),
	);
}

/** The diagnostics as the editor reports them, without a host's `pending` mark. */
export function withoutPending(
	files: readonly HostFileDiagnostics[],
): HostFileDiagnostics[] {
	return files.map(({ filePath, diagnostics }) => ({ filePath, diagnostics }));
}

export function isReportableDiagnostic(diagnostic: HostDiagnostic): boolean {
	return REPORTED_SEVERITIES.includes(diagnostic.severity);
}

/**
 * Render one file's reportable diagnostics, or an empty string when there are
 * none -- silence is the correct output for a clean edit, and the cheapest.
 */
export async function renderFileDiagnostics(
	cwd: string,
	filePath: string,
	diagnostics: readonly HostDiagnostic[],
	readText?: ReadText,
): Promise<string> {
	const reportable = diagnostics.filter(isReportableDiagnostic);
	if (reportable.length === 0) {
		return "";
	}
	const shown = reportable.slice(0, MAX_DIAGNOSTICS_PER_FILE);
	const section = await singleFileDiagnosticsToProblemsString(
		cwd,
		filePath,
		shown,
		readText,
	);
	if (!section) {
		return "";
	}
	const omitted = reportable.length - shown.length;
	return omitted > 0 ? `${section}\n- ...and ${omitted} more` : section;
}

export async function formatIntroducedDiagnostics(
	cwd: string,
	before: readonly HostFileDiagnostics[],
	after: readonly HostFileDiagnostics[],
): Promise<string> {
	const sections: string[] = [];
	for (const file of getNewDiagnostics(before, after)) {
		const section = await renderFileDiagnostics(
			cwd,
			file.filePath,
			file.diagnostics,
		);
		if (section !== "") {
			sections.push(section);
		}
	}
	if (sections.length === 0) {
		return "";
	}
	return [
		"<editor_diagnostics>",
		"The editor reported these problems on the file(s) this edit touched. They were not present before it.",
		sections.join("\n\n"),
		"</editor_diagnostics>",
	].join("\n");
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
		const record = output as Record<string, unknown>;
		const existing = typeof record.result === "string" ? record.result : "";
		return {
			...record,
			result: existing === "" ? block : `${existing}\n\n${block}`,
		};
	}
	if (typeof output === "string") {
		return output === "" ? block : `${output}\n\n${block}`;
	}
	return output;
}

/**
 * How many diagnostics on these files are worth a turn of attention.
 *
 * The count, not the novelty: repairing a broken file almost always moves a
 * diagnostic while removing others, so "introduced any new diagnostic" fires
 * on exactly the work that should be encouraged (14 -> 10, 12 -> 11, 9 -> 6,
 * all scored as no progress in a live run). A net-neutral edit is left
 * unflagged too; the repeat detectors cover a model that churns.
 */
function countReportable(files: readonly HostFileDiagnostics[]): number {
	let total = 0;
	for (const file of files) {
		total += file.diagnostics.filter(isReportableDiagnostic).length;
	}
	return total;
}

/**
 * Mark a tool result as having made the file worse.
 *
 * The loop tracker asked "did it get anywhere?" from failure alone, which is
 * blind to eight `editor` calls returning `success: true` while the file's
 * diagnostics went 2 -> 20. An edit that adds problems did not get anywhere,
 * whatever its envelope says. The flag rides on the result so the runtime can
 * read it without this module knowing about the loop tracker.
 */
export function markRegressed(output: unknown): unknown {
	if (output && typeof output === "object" && !Array.isArray(output)) {
		return { ...(output as Record<string, unknown>), regressed: true };
	}
	return output;
}

/**
 * The delimiter verdict for the files an edit touched, when they have one.
 * Attached to the edit that caused the trouble rather than left to the model
 * choosing `check_file`, which in the measured session it never did.
 */
async function describeBalanceForPaths(
	paths: readonly string[],
): Promise<string> {
	const sections: string[] = [];
	for (const filePath of paths) {
		try {
			const text = await readFile(filePath, "utf8");
			const verdict = describeDelimiterBalance(filePath, text);
			if (verdict) {
				sections.push(verdict);
			}
		} catch {
			// A file that cannot be read has no verdict; the diagnostics block
			// is still worth sending on its own.
		}
	}
	return sections.join("\n\n");
}

/**
 * Read the files' diagnostics once the language servers have stopped
 * changing their mind, or once the budget runs out -- whichever comes first.
 * A file changed after its server last reported on it is `pending`, and a
 * pending answer is not a settled one however long it has stayed the same.
 */
export async function readSettledDiagnostics(
	absolutePaths: ReadonlySet<string>,
	read: ReadDiagnostics,
	delay: (ms: number) => Promise<void>,
	budget: { pollMs?: number; timeoutMs?: number } = {},
): Promise<HostFileDiagnostics[]> {
	const pollMs = budget.pollMs ?? SETTLE_POLL_MS;
	let previous = "";
	let latest: HostFileDiagnostics[] = [];
	const deadline = Date.now() + (budget.timeoutMs ?? SETTLE_TIMEOUT_MS);
	do {
		await delay(pollMs);
		latest = filterToPaths(await read(), absolutePaths);
		const fingerprint = JSON.stringify(latest);
		if (fingerprint === previous && !latest.some((file) => file.pending)) {
			return latest;
		}
		previous = fingerprint;
	} while (Date.now() < deadline);
	return latest;
}

export interface EditorDiagnosticsHooksOptions {
	cwd: string;
	readDiagnostics: ReadDiagnostics;
	/**
	 * For a host whose servers do not watch the disk: hand a file over before
	 * the edit (so what was already wrong with it is known, as it is for a
	 * file open in an editor) and after it, as saved. Left out, the host's
	 * diagnostics are read as they stand -- VS Code reloads the file itself.
	 */
	touch?: TouchDocument;
	/** Only files this says a server answers for are watched. */
	serves?: (filePath: string) => boolean;
	/** Injection point for tests; defaults to a real timer. */
	delay?: (ms: number) => Promise<void>;
	/** One record per edit, for a host's trace: what was asked and found. */
	trace?: (entry: Record<string, unknown>) => void;
	/** Where a failure of this feature goes. It never fails the edit. */
	onError?: (message: string, error: unknown) => void;
	/**
	 * What reported paths are written relative to. Defaults to `cwd`; the
	 * extension writes them relative to the workspace root it reports.
	 */
	displayCwd?: () => string | Promise<string>;
}

/** Paths touched by a tool call, captured before it ran. */
type PendingSnapshot = {
	paths: string[];
	before: HostFileDiagnostics[];
};

/**
 * Hooks that report an edit's new diagnostics back to the model.
 *
 * Composed with whatever hooks the host already has rather than folded into
 * them: this is not optional in the way user-authored hook scripts are.
 */
export function createEditorDiagnosticsHooks(
	options: EditorDiagnosticsHooksOptions,
): AgentHooks {
	const read = options.readDiagnostics;
	const delay = options.delay ?? sleep;
	const trace = options.trace ?? (() => {});
	const pending = new Map<string, PendingSnapshot>();
	/** Files already handed to a server, whose "before" is therefore known. */
	const opened = new Set<string>();

	const resolveTargets = (toolName: string, input: unknown): string[] =>
		readTargetPaths(toolName, input)
			.filter(isLintableFile)
			.map((filePath) => path.resolve(options.cwd, filePath))
			.filter((filePath) => options.serves?.(filePath) ?? true);

	async function snapshotBefore(
		paths: string[],
	): Promise<HostFileDiagnostics[]> {
		if (!options.touch) {
			return filterToPaths(await read(), new Set(paths));
		}
		// A file the server sees for the first time gets the settling budget:
		// what was already wrong with it is not this edit's doing, and has to
		// be known before the edit to be told apart from what the edit adds.
		let fresh = false;
		for (const filePath of paths) {
			const held = await options.touch(filePath);
			if (held && !opened.has(filePath)) {
				fresh = true;
			}
			opened.add(filePath);
		}
		return fresh
			? readSettledDiagnostics(new Set(paths), read, delay)
			: filterToPaths(await read(), new Set(paths));
	}

	return {
		async beforeTool(ctx: AgentBeforeToolContext): Promise<undefined> {
			try {
				if (!FILE_WRITING_TOOLS.has(ctx.toolCall.toolName)) {
					return undefined;
				}
				const paths = resolveTargets(ctx.toolCall.toolName, ctx.input);
				if (paths.length === 0) {
					trace({
						phase: "before",
						tool: ctx.toolCall.toolName,
						targets: [],
						rawPaths: readTargetPaths(ctx.toolCall.toolName, ctx.input),
					});
					return undefined;
				}
				const before = withoutPending(await snapshotBefore(paths));
				pending.set(ctx.toolCall.toolCallId, { paths, before });
				trace({
					phase: "before",
					tool: ctx.toolCall.toolName,
					targets: paths,
					matched: before.length,
				});
			} catch (error) {
				options.onError?.(
					"[EditorDiagnostics] failed to snapshot diagnostics:",
					error,
				);
			}
			return undefined;
		},

		async afterTool(ctx: AgentAfterToolContext) {
			const snapshot = pending.get(ctx.toolCall.toolCallId);
			pending.delete(ctx.toolCall.toolCallId);
			try {
				// A failed edit changed nothing, so anything the editor reports
				// belongs to the file as it already was.
				if (!snapshot || ctx.result.isError) {
					return undefined;
				}
				if (options.touch) {
					for (const filePath of snapshot.paths) {
						await options.touch(filePath, { save: true });
					}
				}
				const after = withoutPending(
					await readSettledDiagnostics(new Set(snapshot.paths), read, delay),
				);
				const block = await formatIntroducedDiagnostics(
					options.displayCwd ? await options.displayCwd() : options.cwd,
					snapshot.before,
					after,
				);
				// Only worth reading the file back when the edit already looks
				// wrong. A clean edit pays nothing for this.
				const balance = block
					? await describeBalanceForPaths(snapshot.paths)
					: "";
				const wasCount = countReportable(snapshot.before);
				const nowCount = countReportable(after);
				const regressed = nowCount > wasCount;
				trace({
					phase: "after",
					tool: ctx.toolCall.toolName,
					targets: snapshot.paths,
					before: wasCount,
					after: nowCount,
					blockChars: block.length,
					balanceChars: balance.length,
					regressed,
				});
				if (!block) {
					return undefined;
				}
				const appended = [block, balance]
					.filter((part) => part !== "")
					.join("\n\n");
				const output = appendToOutput(ctx.result.output, appended);
				return {
					result: {
						...ctx.result,
						output: regressed ? markRegressed(output) : output,
					},
				};
			} catch (error) {
				options.onError?.(
					"[EditorDiagnostics] failed to report diagnostics:",
					error,
				);
				return undefined;
			}
		},
	};
}
