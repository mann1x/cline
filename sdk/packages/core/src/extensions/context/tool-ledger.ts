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

import { asStructuredToolResultEntry } from "./compaction-shared";

/**
 * Any message with a content array, in either of the two block shapes this
 * repository carries — see {@link normaliseCall}.
 */
export interface ToolLedgerMessage {
	content?: unknown;
}

/**
 * A file the folded stretch touched, and the revisions holding its earlier
 * content.
 *
 * Stated per file rather than per call, and that is a correction. The ledger
 * used to print `path: #1 → #2` on a call's own line, which reads as a claim
 * about *that call* -- and the revision log cannot support one: it records
 * revisions in order with the tool that made each, not which call made which,
 * and the correspondence breaks exactly where it matters (identical calls are
 * collapsed into one entry, a refused call makes no revision, and an opaque
 * writer can make several). A wrong revision number is worse than none,
 * because the model acts on it by trying to restore it.
 *
 * The span is true however the calls line up, and it is what the model needs
 * anyway: not "what did this call do" -- the result line says that -- but
 * "where can I get this file's earlier content".
 */
export interface ToolLedgerFileHistory {
	path: string;
	/** The revisions that exist, e.g. `#1–#7`, or `#1` when there is one. */
	span: string;
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
	/**
	 * The paths this call named, in the order its arguments gave them.
	 *
	 * Recorded unconditionally, because a path is a fact about the call rather
	 * than a claim about the file. What is held for those paths is answered
	 * once per file by {@link collectFileHistories}.
	 */
	files: string[];
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
}

/**
 * The revisions held for one file, as a span like `#1–#7`.
 *
 * Supplied by the caller because the ledger is pure: it reads messages, and
 * the revision log lives with the session. Nothing for a file the log does not
 * track, which is most of them — an untracked file simply does not appear.
 */
export type RevisionSpanLookup = (path: string) => string | undefined;

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

/**
 * What a structured tool answer returned, in one line.
 *
 * `read_files`, `run_commands` and `search_codebase` answer with
 * `{query, result, success, error?}` entries, and an array of them used to
 * print as `[1 items]` here -- so the ledger, which exists to be the measured
 * counterpart to the model's own account, carried no measurement for the
 * three tools whose results matter most. A pandorum summary claimed a checker
 * run had succeeded where it had returned `ok:false` three times, and the
 * line beside it that should have said otherwise said `[1 items]`.
 *
 * Undefined when the array is not that shape, so text and image blocks keep
 * the rendering they had.
 */
function summariseStructuredOutput(
	entries: readonly unknown[],
	limits: ToolLedgerLimits,
): string | undefined {
	if (entries.length === 0) {
		return undefined;
	}
	const parts: string[] = [];
	for (const entry of entries) {
		const structured = asStructuredToolResultEntry(entry);
		if (!structured) {
			return undefined;
		}
		const error =
			typeof structured.error === "string" && structured.error
				? `failed: ${structured.error}`
				: undefined;
		const body =
			error ??
			(typeof structured.result === "string" && structured.result
				? structured.result
				: structured.success === false
					? "failed"
					: "(no output)");
		const query =
			typeof structured.query === "string" && structured.query
				? `${summariseValue(structured.query, limits)}: `
				: "";
		parts.push(`${query}${summariseValue(body, limits)}`);
	}
	return parts.join("; ");
}

function summariseOutput(output: unknown, limits: ToolLedgerLimits): string {
	if (typeof output === "string") {
		return clamp(output, limits.maxResultChars);
	}
	const structured = Array.isArray(output)
		? summariseStructuredOutput(output, limits)
		: undefined;
	return clamp(
		structured ?? summariseValue(output, limits),
		limits.maxResultChars,
	);
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

interface NormalisedCall {
	id: string;
	name: string;
	input: unknown;
}

interface NormalisedResult {
	id: string;
	output: unknown;
	isError?: boolean;
}

/**
 * One call, whichever of the two block shapes it arrived in.
 *
 * This repository carries both, and which one a caller holds is not something
 * the caller can be expected to know: the agent runtime works in the AI SDK's
 * `tool-call` / `toolCallId` / `input`, and the compaction pipeline works in
 * the Anthropic-style `tool_use` / `id` / `input` with results keyed by
 * `tool_use_id`. A ledger that reads only one of them is not half-working; it
 * silently reports that no tools were called, which is the most damaging thing
 * it could say. So it reads both and says so here.
 */
function normaliseCall(part: unknown): NormalisedCall | undefined {
	if (!isRecord(part)) {
		return undefined;
	}
	if (part.type === "tool-call" && typeof part.toolCallId === "string") {
		return {
			id: part.toolCallId,
			name: typeof part.toolName === "string" ? part.toolName : "(unnamed)",
			input: part.input,
		};
	}
	if (part.type === "tool_use" && typeof part.id === "string") {
		return {
			id: part.id,
			name: typeof part.name === "string" ? part.name : "(unnamed)",
			input: part.input,
		};
	}
	return undefined;
}

/** One result, in either shape. See {@link normaliseCall}. */
function normaliseResult(part: unknown): NormalisedResult | undefined {
	if (!isRecord(part)) {
		return undefined;
	}
	if (part.type === "tool-result" && typeof part.toolCallId === "string") {
		return {
			id: part.toolCallId,
			output: part.output,
			isError: part.isError === true,
		};
	}
	if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
		return {
			id: part.tool_use_id,
			output: part.content,
			isError: part.is_error === true,
		};
	}
	return undefined;
}

/**
 * Pair the calls in a stretch of messages with their results.
 *
 * Paired by call id, never by position: a turn can issue several calls and
 * their results arrive in one message, so counting on order puts the wrong
 * answer against the wrong call — which reads as a tool that returned
 * something it never returned.
 */
export function buildToolLedger(
	messages: readonly ToolLedgerMessage[],
	options: ToolLedgerOptions = {},
): ToolLedgerEntry[] {
	const limits = resolveLimits(options.limits);
	const results = new Map<string, NormalisedResult>();
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content) {
			const answer = normaliseResult(part);
			if (answer) {
				results.set(answer.id, answer);
			}
		}
	}

	const entries: ToolLedgerEntry[] = [];
	for (const message of messages) {
		if (!Array.isArray(message.content)) {
			continue;
		}
		for (const part of message.content) {
			const call = normaliseCall(part);
			if (!call) {
				continue;
			}
			const answer = results.get(call.id);
			const input = summariseInput(call.input, limits);
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
				previous.toolName === call.name &&
				previous.input === input &&
				previous.result === result
			) {
				previous.repeated += 1;
				continue;
			}

			entries.push({
				index: entries.length + 1,
				toolName: call.name,
				input,
				result,
				failed,
				repeated: 1,
				files: pathsIn(call.input),
			});
		}
	}
	return entries;
}

/**
 * The tools whose result is a judgement about the work rather than a copy of
 * something still on disk.
 *
 * A read can be made again and an edit can be seen in the file; what a checker
 * said cannot be recovered from anywhere. So when the ledger has to lose
 * something, it loses the recoverable calls and keeps the verdicts — which is
 * also the eviction order the tester asked for, in as many words: "the old
 * read/edit commands should be evicted at some point but the run commands
 * should be carried over as much as possible".
 */
const VERDICT_TOOLS = new Set(["run_commands", "check_file"]);

/**
 * Concatenate a carried ledger with this compaction's own, as one run.
 *
 * The seam is where the repeat rule matters most: a checker run just before a
 * compaction and again just after is one fact reported twice, and it is the
 * call most likely to repeat because it follows every edit. So the same rule
 * `buildToolLedger` applies within a stretch is applied across the join —
 * same tool, same arguments, same answer collapses; a changed answer does not,
 * because a changed answer is the most informative pair in the record.
 */
export function mergeToolLedger(
	previous: readonly ToolLedgerEntry[],
	next: readonly ToolLedgerEntry[],
): ToolLedgerEntry[] {
	const merged: ToolLedgerEntry[] = [];
	for (const entry of [...previous, ...next]) {
		const last = merged[merged.length - 1];
		if (
			last &&
			last.toolName === entry.toolName &&
			last.input === entry.input &&
			last.result === entry.result
		) {
			last.repeated += entry.repeated;
			continue;
		}
		merged.push({ ...entry });
	}
	return renumber(merged);
}

function renumber(entries: ToolLedgerEntry[]): ToolLedgerEntry[] {
	return entries.map((entry, index) => ({ ...entry, index: index + 1 }));
}

/** What one entry costs, as the model will read it. */
function entryChars(entry: ToolLedgerEntry): number {
	return entry.toolName.length + entry.input.length + entry.result.length + 16;
}

/**
 * Bring a carried ledger back under budget, losing the recoverable calls
 * first.
 *
 * Three tiers, oldest first within each: successful non-verdict calls, then
 * failed non-verdict calls, then anything that returned a verdict. A refused
 * read outranks a successful one because the summary is measurably worst at
 * keeping refusals, and without it the model simply makes the call again.
 *
 * Eviction rather than truncation, because a ledger is a record: half an entry
 * says something that did not happen, where a missing entry only fails to say
 * something that did.
 */
export function evictToolLedger(
	entries: readonly ToolLedgerEntry[],
	budgetChars: number,
): ToolLedgerEntry[] {
	let total = entries.reduce((sum, entry) => sum + entryChars(entry), 0);
	if (total <= budgetChars) {
		return renumber([...entries]);
	}
	const tierOf = (entry: ToolLedgerEntry): number =>
		VERDICT_TOOLS.has(entry.toolName) ? 2 : entry.failed ? 1 : 0;
	// Oldest first within a tier, which is what the index already records.
	const order = entries
		.map((entry, position) => ({ entry, position }))
		.sort(
			(a, b) => tierOf(a.entry) - tierOf(b.entry) || a.position - b.position,
		);
	const dropped = new Set<number>();
	for (const { position, entry } of order) {
		if (total <= budgetChars) {
			break;
		}
		dropped.add(position);
		total -= entryChars(entry);
	}
	return renumber(entries.filter((_entry, position) => !dropped.has(position)));
}

/**
 * The ledger as the model will read it.
 *
 * One line per call, the marks where the eye lands rather than at the end of a
 * long line: a reader scanning for what went wrong should not have to finish
 * every line to find out.
 */
export function renderToolLedger(
	entries: readonly ToolLedgerEntry[],
	histories: readonly ToolLedgerFileHistory[] = [],
): string {
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
		return [
			`${entry.index}. ${entry.toolName}${mark}  ${entry.input}`,
			`      → ${entry.result}`,
		].join("\n");
	});
	if (histories.length > 0) {
		lines.push(
			"",
			"Files whose earlier content is still held, by revision:",
			...histories.map((file) => `  ${file.path}  ${file.span}`),
		);
	}
	return lines.join("\n");
}

/**
 * The files the ledger touched that the revision log still holds, once each.
 *
 * First-touched order rather than sorted: the ledger is read top to bottom and
 * a file's place in that order is the reader's way back to the calls it
 * belongs to.
 */
export function collectFileHistories(
	entries: readonly ToolLedgerEntry[],
	spanFor: RevisionSpanLookup | undefined,
): ToolLedgerFileHistory[] {
	if (!spanFor) {
		return [];
	}
	const histories: ToolLedgerFileHistory[] = [];
	const seen = new Set<string>();
	for (const entry of entries) {
		for (const path of entry.files) {
			if (seen.has(path)) {
				continue;
			}
			seen.add(path);
			const span = spanFor(path);
			if (span) {
				histories.push({ path, span });
			}
		}
	}
	return histories;
}
