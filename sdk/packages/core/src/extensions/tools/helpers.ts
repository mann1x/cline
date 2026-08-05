import { validateWithZod } from "@cline/shared";
import {
	type EditFileInput,
	EDITOR_ARG_CHAR_LIMIT,
	type ReadFileRequest,
	RunCommandsInputUnionSchema,
	type StructuredCommandInput,
} from "./schemas";

/**
 * Format an error into a string message
 */
export function formatError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Whether this call writes a whole file rather than editing part of one.
 *
 * `new_text` with no `old_text`, `insert_line` or `start_line` is the create
 * form: the executor writes the payload as the entire file. There is no
 * "smaller tool call" it can be split into, so the size guard must not ask
 * for one.
 */
function isWholeFileWrite(input: EditFileInput): boolean {
	return (
		input.old_text == null &&
		input.insert_line == null &&
		input.start_line == null
	);
}

export function getEditorSizeError(input: EditFileInput): string | null {
	if (
		typeof input.old_text === "string" &&
		input.old_text.length > EDITOR_ARG_CHAR_LIMIT
	) {
		return `Editor input too large: old_text was ${input.old_text.length} characters, exceeding the limit of ${EDITOR_ARG_CHAR_LIMIT}. A match string this long is the slow way to address an edit: replace the region by line number with \`start_line\`/\`end_line\` and no \`old_text\` at all, or split it into smaller edits.`;
	}

	// A whole-file write is exempt: it is the one edit shape that cannot be
	// made smaller. Measured on a 156-message session — the model sent a
	// 13,279-character rewrite of a file it had failed to patch incrementally,
	// was told to "split the edit into smaller tool calls", and twenty turns
	// later asked the user whether it should try rewriting the file from
	// scratch. It had already tried, and this guard was why it could not.
	if (isWholeFileWrite(input)) {
		return null;
	}

	if (input.new_text.length > EDITOR_ARG_CHAR_LIMIT) {
		return `Editor input too large: new_text was ${input.new_text.length} characters, exceeding the limit of ${EDITOR_ARG_CHAR_LIMIT}. Split the edit into smaller tool calls, or replace the whole region in one call by line number with \`start_line\`/\`end_line\`.`;
	}

	return null;
}

/**
 * Create a timeout-wrapped promise
 */
export class TimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(message: string, timeoutMs: number) {
		super(message);
		this.name = "TimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	message: string,
): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new TimeoutError(message, ms)), ms);
		}),
	]);
}

export function formatReadFileQuery(request: ReadFileRequest): string {
	const { path, start_line, end_line } = request;
	if (start_line == null && end_line == null) {
		return path;
	}
	const start = start_line ?? 1;
	const end = end_line ?? "EOF";
	return `${path}:${start}-${end}`;
}

export function getReadFileRangeError(request: ReadFileRequest): string | null {
	const { start_line, end_line } = request;
	if (start_line == null || end_line == null || start_line <= end_line) {
		return null;
	}

	return `start_line must be less than or equal to end_line (received start_line: ${start_line}, end_line: ${end_line})`;
}

const READ_RANGE_KEYS = new Set(["start_line", "end_line"]);

function isOrphanReadRangeEntry(
	value: unknown,
): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}
	const keys = Object.keys(value);
	return keys.length > 0 && keys.every((key) => READ_RANGE_KEYS.has(key));
}

function coalesceOrphanReadRangeEntries(entries: unknown[]): unknown[] {
	const coalesced: unknown[] = [];
	for (const entry of entries) {
		if (isOrphanReadRangeEntry(entry)) {
			const previous = coalesced[coalesced.length - 1];
			if (typeof previous === "string") {
				coalesced[coalesced.length - 1] = { path: previous, ...entry };
				continue;
			}
			if (
				previous !== null &&
				typeof previous === "object" &&
				!Array.isArray(previous) &&
				"path" in previous &&
				Object.keys(entry).every((key) => !(key in previous))
			) {
				coalesced[coalesced.length - 1] = { ...previous, ...entry };
				continue;
			}
		}
		coalesced.push(entry);
	}
	return coalesced;
}

/**
 * Some models emit a file's line range as a separate array element instead of
 * placing start_line/end_line on the same object as its path. Fold such
 * orphan range entries into the preceding file entry before validation.
 */
export function coalesceOrphanReadRanges(input: unknown): unknown {
	if (Array.isArray(input)) {
		return coalesceOrphanReadRangeEntries(input);
	}
	if (input !== null && typeof input === "object") {
		for (const key of ["files", "paths"] as const) {
			const value = (input as Record<string, unknown>)[key];
			if (Array.isArray(value)) {
				return { ...input, [key]: coalesceOrphanReadRangeEntries(value) };
			}
		}
	}
	return input;
}

/** Path-carrying keys a model might put a bracketed list into. */
const READ_PATH_KEYS = [
	"path",
	"file_path",
	"filePath",
	"paths",
	"file_paths",
	"files",
] as const;

/**
 * Read a path field whose value is a list rendered as a string.
 *
 * Returns the paths it contains, or null when the value is an ordinary path.
 * Only a value that is bracketed end to end qualifies — a path that merely
 * contains a bracket is left alone.
 */
export function parseBracketedPathList(value: string): string[] | null {
	const trimmed = value.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
		return null;
	}

	// `["c:\\dir\\a.js"]` — a JSON array the model stringified. Parsing it
	// also undoes the escaping, which a naive split would leave behind.
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (
			Array.isArray(parsed) &&
			parsed.length > 0 &&
			parsed.every((entry) => typeof entry === "string" && entry.trim())
		) {
			return parsed.map((entry) => (entry as string).trim());
		}
	} catch {
		// Not JSON; fall through to the bare form below.
	}

	// `[c:\dir\a.js, c:\dir\b.js]` — brackets with no quoting at all.
	const paths = trimmed
		.slice(1, -1)
		.split(",")
		.map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
		.filter(Boolean);
	return paths.length > 0 ? paths : null;
}

/**
 * Expand a path field holding a bracketed list into the real list.
 *
 * `read_files` is plural and its sibling `check_file` takes `paths: [...]`,
 * so a model that has just used one reaches for an array here too — but
 * `path` is a string, and a string is what a bracketed list validates as.
 * Measured on a 156-message session: three consecutive calls sent
 * `path: "[\"c:\\...\\game.js\"]"`, `"[c:\\...\\game.js]"` and
 * `"[c:/.../game.js]"`, each of which passed validation and was then joined
 * onto the cwd, so all three came back
 * `ENOENT ... stat 'c:\...\test\["c:\...\game.js"]'`. The list was always
 * there in the argument; nothing was reading it as one.
 */
export function expandBracketedPathLists(input: unknown): unknown {
	if (typeof input === "string") {
		return parseBracketedPathList(input) ?? input;
	}

	if (input === null || typeof input !== "object" || Array.isArray(input)) {
		return input;
	}

	const record = input as Record<string, unknown>;
	for (const key of READ_PATH_KEYS) {
		const value = record[key];
		if (typeof value !== "string") {
			continue;
		}
		const paths = parseBracketedPathList(value);
		if (!paths) {
			continue;
		}
		if (paths.length === 1) {
			return { ...record, [key]: paths[0] };
		}
		// Several files in one field: the entry's own range fields apply to
		// each of them, since that is the only file they could have meant.
		const { [key]: _listed, start_line, end_line, ...rest } = record;
		const range = {
			...(start_line === undefined ? {} : { start_line }),
			...(end_line === undefined ? {} : { end_line }),
		};
		return { ...rest, files: paths.map((path) => ({ path, ...range })) };
	}

	return input;
}

export function normalizeRunCommandsInput(
	input: unknown,
): Array<string | StructuredCommandInput> {
	const validate = validateWithZod(RunCommandsInputUnionSchema, input);

	if (typeof validate === "string") {
		return [validate];
	}

	if (Array.isArray(validate)) {
		return validate;
	}

	if ("commands" in validate) {
		return Array.isArray(validate.commands)
			? validate.commands
			: [validate.commands];
	}

	if ("command" in validate) {
		return "args" in validate ? [validate] : [validate.command];
	}

	if ("cmd" in validate) {
		return [validate.cmd];
	}

	return [validate];
}

export function formatRunCommandQuery(
	command: string | StructuredCommandInput,
): string {
	if (typeof command === "string") {
		return command;
	}

	const args = command.args ?? [];
	if (args.length === 0) {
		return command.command;
	}

	const renderedArgs = args.map((arg) =>
		/[\s"]/u.test(arg) ? JSON.stringify(arg) : arg,
	);
	return `${command.command} ${renderedArgs.join(" ")}`;
}

/**
 * Max characters of the executed command echoed back in the tool result's
 * `query` field. The full command already exists in the assistant tool-call
 * input, so repeating it in the result only duplicates tokens in the
 * provider request (expensive for large heredoc/file-generation commands).
 */
export const RUN_COMMAND_QUERY_PREVIEW_LIMIT = 200;

/**
 * Bound the command echo placed in a provider-facing tool result.
 * Short commands pass through unchanged; long commands keep a short
 * prefix plus a truncation note so the result is still identifiable.
 */
export function formatRunCommandQueryPreview(
	command: string | StructuredCommandInput,
): string {
	const rendered = formatRunCommandQuery(command);
	if (rendered.length <= RUN_COMMAND_QUERY_PREVIEW_LIMIT) {
		return rendered;
	}
	const truncatedChars = rendered.length - RUN_COMMAND_QUERY_PREVIEW_LIMIT;
	return `${rendered.slice(0, RUN_COMMAND_QUERY_PREVIEW_LIMIT)} ... [command truncated: ${truncatedChars} more chars; full command is in the tool call input]`;
}
