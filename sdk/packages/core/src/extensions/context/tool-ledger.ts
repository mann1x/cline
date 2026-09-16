/**
 * What the tools did, for a transcript that is about to be discarded.
 *
 * Both compaction strategies need this and neither can get it from the model.
 * A summary is the model's account of its own work, and the one thing it is
 * measurably worst at is remembering which calls it actually made: it
 * reconstructs plausible ones, drops the refused ones, and repeats work it has
 * already done because nothing in the summary said it had. The ledger is the
 * harness's account of the same stretch, taken from the messages rather than
 * from the model, and it is appended to the summary rather than requested
 * inside it.
 *
 * Three problems shape the format.
 *
 * **Size.** A whole-file write is the largest single thing in any transcript
 * and the least worth reproducing, because the file is still on disk. So a
 * long field is never copied — it is measured, and where a revision log is
 * available the entry names the revision that holds it. That is the trade the
 * file-revision store already exists to make: an address instead of a body.
 *
 * **Repetition.** A stuck run calls the same thing over and over; that is the
 * behaviour the corpus shows ending runs. Listing forty identical `read_files`
 * calls buries the four that matter, so identical calls collapse — unless the
 * *result* changed, which is the one case where the repeat is the story rather
 * than the noise.
 *
 * **Legibility.** The reader is a small model that has just lost its memory.
 * One line per call, the failures marked, no JSON it has to parse.
 */

import type {
	AgentMessage,
	AgentToolCallPart,
	AgentToolResultPart,
} from "@cline/shared";

/** What a file was, and became, across one call. */
export interface ToolLedgerFileImpact {
	path: string;
	/** Revision label before the call, e.g. `#1`. Absent when unknown. */
	before?: string;
	/** Revision label after it. Absent when unknown. */
	after?: string;
}

export interface ToolLedgerEntry {
	/** 1-based, in the order the calls were made. */
	index: number;
	toolName: string;
	/** The arguments, trimmed and on one line where they fit. */
	input: string;
	/** What came back, trimmed. */
	result: string;
	/** The call reported an error, or returned a refusal. */
	failed: boolean;
	/** How many identical calls this entry stands for. 1 is the common case. */
	repeated: number;
	/** Files this call touched, with the revisions holding their content. */
	files: ToolLedgerFileImpact[];
}

export interface ToolLedgerLimits {
	/** Longest a single scalar field may be before it is elided. */
	maxFieldChars: number;
	/** Longest the rendered arguments may be, all fields together. */
	maxInputChars: number;
	/** Longest a result may be. */
	maxResultChars: number;
	/** A string with at least this many lines is reported as a size. */
	multilineLineFloor: number;
}

export const DEFAULT_TOOL_LEDGER_LIMITS: ToolLedgerLimits = {
	maxFieldChars: 200,
	maxInputChars: 400,
	maxResultChars: 300,
	multilineLineFloor: 4,
};

export interface ToolLedgerOptions {
	limits?: Partial<ToolLedgerLimits>;
	/**
	 * The revisions holding a file's content before and after a call.
	 *
	 * Supplied by the caller because the ledger is pure: it reads messages, and
	 * the revision log lives with the session. Absent means the entry says
	 * nothing about files, which is honest — a wrong revision number is worse
	 * than none, since the model will try to restore it.
	 */
	revisionsFor?: (
		path: string,
	) => { before?: string; after?: string } | undefined;
}

function resolveLimits(given?: Partial<ToolLedgerLimits>): ToolLedgerLimits {
	return { ...DEFAULT_TOOL_LEDGER_LIMITS, ...(given ?? {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * One field, short enough to read.
 *
 * A multi-line body is reported as its shape rather than its head: the first
 * 200 characters of a 400-line file say nothing a reader can use, and they
 * cost as much as the sentence that says what it was.
 */
function summariseValue(value: unknown, limits: ToolLedgerLimits): string {
	if (value === null || value === undefined) {
		return String(value);
	}
	if (typeof value !== "string") {
		if (Array.isArray(value)) {
			return `[${value.length} items]`;
		}
		if (isRecord(value)) {
			return `{${Object.keys(value).join(", ")}}`;
		}
		return String(value);
	}
	const lines = value.split("\n");
	if (lines.length >= limits.multilineLineFloor) {
		return `<${lines.length} lines, ${value.length} chars>`;
	}
	if (value.length <= limits.maxFieldChars) {
		return value;
	}
	const keep = Math.max(20, Math.floor(limits.maxFieldChars / 2) - 12);
	return `${value.slice(0, keep)} …${value.length - keep * 2} chars elided… ${value.slice(-keep)}`;
}

function summariseInput(input: unknown, limits: ToolLedgerLimits): string {
	if (!isRecord(input)) {
		return clamp(summariseValue(input, limits), limits.maxInputChars);
	}
	const parts = Object.entries(input).map(
		([key, value]) => `${key}=${summariseValue(value, limits)}`,
	);
	return clamp(parts.join(" "), limits.maxInputChars);
}

function summariseOutput(output: unknown, limits: ToolLedgerLimits): string {
	const text =
		typeof output === "string" ? output : summariseValue(output, limits);
	return clamp(text, limits.maxResultChars);
}

function clamp(text: string, max: number): string {
	const flat = text.replace(/\s*\n\s*/g, " ⏎ ").trim();
	if (flat.length <= max) {
		return flat;
	}
	const keep = Math.max(20, Math.floor(max / 2) - 12);
	return `${flat.slice(0, keep)} …${flat.length - keep * 2} chars elided… ${flat.slice(-keep)}`;
}

/**
 * Whether a result is a refusal the tool wrapped in a success envelope.
 *
 * `isError` is the runtime's own flag and catches the calls that threw. It
 * does not catch a tool that returned `{"ok":false}` inside a result it called
 * a success, which is the larger half — and the half a summary reliably drops.
 */
function looksRefused(output: unknown, isError?: boolean): boolean {
	if (isError) {
		return true;
	}
	const text = typeof output === "string" ? output : JSON.stringify(output);
	if (!text) {
		return false;
	}
	return (
		/"ok"\s*:\s*false/i.test(text) ||
		/"(?:error|failure)"\s*:\s*"/i.test(text) ||
		/^\s*(?:error|refused|failed)\b/i.test(text)
	);
}

/** The file a call touched, where its arguments name one. */
function pathsIn(input: unknown): string[] {
	if (!isRecord(input)) {
		return [];
	}
	const found: string[] = [];
	for (const key of ["path", "file", "filePath", "target"]) {
		const value = input[key];
		if (typeof value === "string" && value !== "") {
			found.push(value);
		}
	}
	const list = input.files ?? input.paths;
	if (Array.isArray(list)) {
		for (const item of list) {
			if (typeof item === "string" && item !== "") {
				found.push(item);
			} else if (isRecord(item) && typeof item.path === "string") {
				found.push(item.path);
			}
		}
	}
	return [...new Set(found)];
}

/**
 * Pair the calls in a stretch of messages with their results.
 *
 * Paired by `toolCallId`, never by position: a turn can issue several calls
 * and their results arrive in one message, so counting on order puts the wrong
 * answer against the wrong call — which reads as a tool that returned
 * something it never returned.
 */
export function buildToolLedger(
	messages: readonly AgentMessage[],
	options: ToolLedgerOptions = {},
): ToolLedgerEntry[] {
	const limits = resolveLimits(options.limits);
	const results = new Map<string, AgentToolResultPart>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content) {
			if (
				isRecord(part) &&
				part.type === "tool-result" &&
				typeof part.toolCallId === "string"
			) {
				results.set(part.toolCallId, part as unknown as AgentToolResultPart);
			}
		}
	}

	const entries: ToolLedgerEntry[] = [];
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content) {
			if (!isRecord(part) || part.type !== "tool-call") {
				continue;
			}
			const callPart = part as unknown as AgentToolCallPart;
			const answer = results.get(callPart.toolCallId);
			const input = summariseInput(callPart.input, limits);
			const result = answer
				? summariseOutput(answer.output, limits)
				: "(no result recorded)";
			const failed = answer
				? looksRefused(answer.output, answer.isError)
				: false;

			// The repeat rule: same tool, same arguments, same answer. A changed
			// answer means something moved between the two calls, and that is
			// the most informative pair in the stretch.
			const previous = entries[entries.length - 1];
			if (
				previous &&
				previous.toolName === callPart.toolName &&
				previous.input === input &&
				previous.result === result
			) {
				previous.repeated += 1;
				continue;
			}

			const files: ToolLedgerFileImpact[] = [];
			if (options.revisionsFor) {
				for (const path of pathsIn(callPart.input)) {
					const revisions = options.revisionsFor(path);
					if (revisions) {
						files.push({ path, ...revisions });
					}
				}
			}

			entries.push({
				index: entries.length + 1,
				toolName: callPart.toolName,
				input,
				result,
				failed,
				repeated: 1,
				files,
			});
		}
	}
	return entries;
}

/**
 * The ledger as the model will read it.
 *
 * One line per call, the marks where the eye lands rather than at the end of a
 * long line: a reader scanning for what went wrong should not have to finish
 * every line to find out.
 */
export function renderToolLedger(entries: readonly ToolLedgerEntry[]): string {
	if (entries.length === 0) {
		return "";
	}
	const lines = entries.map((entry) => {
		const marks: string[] = [];
		if (entry.failed) {
			marks.push("FAILED");
		}
		if (entry.repeated > 1) {
			marks.push(`${entry.repeated}×`);
		}
		const mark = marks.length > 0 ? ` [${marks.join(" ")}]` : "";
		const files = entry.files
			.map((file) => {
				const from = file.before ?? "?";
				const to = file.after ?? "?";
				return `      ${file.path}: ${from} → ${to}`;
			})
			.join("\n");
		return [
			`${entry.index}. ${entry.toolName}${mark}  ${entry.input}`,
			`      → ${entry.result}`,
			files,
		]
			.filter((part) => part !== "")
			.join("\n");
	});
	return lines.join("\n");
}
