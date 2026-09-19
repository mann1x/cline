/**
 * File Read Executor
 *
 * Built-in implementation for reading files using Node.js fs module.
 */

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { AgentToolContext } from "@cline/shared";
import { resolveExistingFilePath } from "@cline/shared/storage";
import type { ReadFileRequest } from "../schemas";
import type { FileReadExecutor } from "../types";
import { withFileLock } from "./file-locks";
import {
	MAX_LINE_CHARS,
	MAX_READ_LINES,
	MAX_READ_OUTPUT_CHARS,
	MAX_READ_REFUSAL_CHARS,
} from "./output-limits";
import { type ReadReceipts, readFileStamp } from "./read-receipts";
import type { ReadLedger } from "./unchanged-reads";

const IMAGE_MEDIA_TYPES = new Map<string, string>([
	[".gif", "image/gif"],
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".webp", "image/webp"],
]);

/**
 * Options for the file read executor
 */
export interface FileReadExecutorOptions {
	/**
	 * Characters past which a read window is refused instead of returned.
	 * Defaults to {@link MAX_READ_REFUSAL_CHARS}. Raised by tests that need to
	 * exercise the windowing and line-counting paths, which still run for every
	 * read that fits.
	 */
	maxReadChars?: number;
	/**
	 * Ledger of what has already been returned, so an unchanged re-read can be
	 * answered with a pointer instead of a second copy. Omit and every read
	 * returns the content, which is the behaviour this had before.
	 */
	readLedger?: ReadLedger;

	/**
	 * Maximum file size to read in bytes
	 * @default 10_000_000 (10MB)
	 */
	maxFileSizeBytes?: number;

	/**
	 * File encoding
	 * @default "utf-8"
	 */
	encoding?: BufferEncoding;

	/**
	 * Whether to include line numbers in output
	 * @default false
	 */
	includeLineNumbers?: boolean;

	/**
	 * The directory a relative path is resolved against.
	 *
	 * The workspace, not the process. These are the same thing only when the
	 * agent was launched from the directory it is working in, and in the two
	 * hosts that matter they are not: the extension host's `process.cwd()` is
	 * wherever VS Code was started, and the CLI takes its workspace as `--cwd`
	 * while running from wherever the shell was.
	 *
	 * Measured on a harness run started one directory above its workspace: a
	 * model that sends bare filenames -- `manic_miner.html` rather than the
	 * full path -- had 56 reads land in the parent and fail with ENOENT, then
	 * 19 edits refused because the file it was editing had never been read,
	 * then the loop guard stopped the run six times over. Three hours, four
	 * applied edits. Five earlier runs on a different model never saw it, for
	 * the single reason that that model always sent absolute paths.
	 *
	 * Falls back to `process.cwd()`, which is what this did unconditionally
	 * before, so an embedder that wires the executor up alone is unaffected.
	 */
	cwd?: string;

	/**
	 * Shared record of what has been read. Paired with the same object on the
	 * editor executor, this is what lets an edit require a prior read.
	 */
	receipts?: ReadReceipts;
}

// `receipts`, `cwd` and `readLedger` are deliberately outside the defaults: there is no
// sensible default registry, and its absence is what turns the read-before-edit
// guard off for a standalone executor. `cwd` is absent rather than defaulted so
// that "nobody told us the workspace" stays distinguishable from "the workspace
// is the process's directory", which is the distinction the fix rests on.
// `readLedger` is absent for the same reason as `receipts`: without one, every
// read returns the content, which is what a standalone executor should do.
const DEFAULT_FILE_READ_OPTIONS: Required<
	Omit<FileReadExecutorOptions, "receipts" | "cwd" | "readLedger">
> = {
	maxFileSizeBytes: 10_000_000, // 10MB default limit
	encoding: "utf-8", // Default to UTF-8 encoding
	includeLineNumbers: true, // Include line numbers by default
	maxReadChars: MAX_READ_REFUSAL_CHARS,
};

const MAX_TEXT_STREAM_BYTES = 100_000_000;
const MAX_UNRANGED_LINE_SCAN = 50_000;

/**
 * How far the reader keeps counting lines after it has stopped capturing them,
 * so that every read can report how long the file is.
 *
 * A ranged read used to stop at `end_line` and never learn the file's length,
 * which left no way to ask the question at all. Measured on a 265-message
 * session: five consecutive shell commands trying to find a line count —
 * `wc -l` (not a Windows command), `type | find`, and three spellings of
 * `(Get-Content).Count` — followed by two `editor` calls sending
 * `end_line: 9999` as a guess at EOF. Counting the remaining lines costs one
 * stream pass with no capture and no allocation.
 */
const MAX_LINE_COUNT_SCAN = 500_000;

/** A read's text together with the line span it actually returned. */
/**
 * Where a read's lines come from.
 *
 * A path, for every read but one: the change protocol serves `revision:
 * "base"` out of the transaction's snapshot, which is held in memory and has
 * no path to stream from. Both go through the same windowing, so a base read
 * is capped, numbered and reported exactly like the working read it exists to
 * be compared against — a base revision that paginated differently would be
 * unreadable next to the file it is a revision of.
 */
export type ReadTextSource =
	| { readonly kind: "file"; readonly path: string }
	| { readonly kind: "text"; readonly text: string };

export interface ReadWindow {
	text: string;
	firstLine: number;
	lastLine: number;
}

interface CapturedLine {
	lineNumber: number;
	text: string;
}

function getAbortError(signal: AbortSignal): Error {
	const { reason } = signal;
	if (reason instanceof Error) {
		return reason;
	}
	if (reason !== undefined) {
		return new Error(String(reason));
	}
	return new Error("File read was aborted");
}

async function readTextWindow(
	source: ReadTextSource,
	encoding: BufferEncoding,
	includeLineNumbers: boolean,
	startLine: number | null | undefined,
	endLine: number | null | undefined,
	signal: AbortSignal | undefined,
	maxReadChars: number,
): Promise<ReadWindow> {
	if (signal?.aborted) {
		throw getAbortError(signal);
	}

	const requestedStartLine = Math.max(startLine ?? 1, 1);
	const requestedEndLine = endLine ?? Number.POSITIVE_INFINITY;
	const hasFiniteEndLine = Number.isFinite(requestedEndLine);
	const maxScannedLine = hasFiniteEndLine
		? requestedEndLine
		: requestedStartLine + MAX_UNRANGED_LINE_SCAN - 1;
	const captured: CapturedLine[] = [];
	let chars = 0;
	let totalLines = 0;
	let capped = false;
	let approximateTotalLines = false;
	let fileLineCount = 0;
	let approximateFileLineCount = false;
	let doneCapturing = false;
	const maxCapturedLineNumber = Number.isFinite(requestedEndLine)
		? Math.min(requestedEndLine, requestedStartLine + MAX_READ_LINES - 1)
		: requestedStartLine + MAX_READ_LINES - 1;
	const lineNumberPrefixChars = includeLineNumbers
		? String(maxCapturedLineNumber).length + 3
		: 0;

	// `Readable.from([text])`, with the array: handed the string bare it is
	// iterated as an iterable of characters, and every line arrives one letter
	// at a time.
	const stream =
		source.kind === "file"
			? createReadStream(source.path, { encoding })
			: Readable.from([source.text]);
	const reader = createInterface({
		input: stream,
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	const abortHandler = signal
		? () => stream.destroy(getAbortError(signal))
		: undefined;

	if (signal && abortHandler) {
		signal.addEventListener("abort", abortHandler, { once: true });
	}

	try {
		for await (const rawLine of reader) {
			fileLineCount += 1;
			if (fileLineCount > MAX_LINE_COUNT_SCAN) {
				fileLineCount -= 1;
				approximateFileLineCount = true;
				break;
			}
			// Past the requested range the loop keeps turning purely to count,
			// so the result can say how long the file is.
			if (doneCapturing) {
				continue;
			}

			totalLines += 1;
			if (totalLines > requestedEndLine) {
				totalLines = requestedEndLine;
				doneCapturing = true;
				continue;
			}
			if (!hasFiniteEndLine && capped && totalLines >= maxScannedLine) {
				approximateTotalLines = true;
				doneCapturing = true;
				continue;
			}
			if (totalLines < requestedStartLine || capped) {
				continue;
			}
			if (captured.length >= MAX_READ_LINES) {
				capped = true;
				continue;
			}

			let line = rawLine;
			if (line.length > MAX_LINE_CHARS) {
				line = `${line.slice(0, MAX_LINE_CHARS)} [line truncated]`;
			}

			const nextChars = chars + line.length + lineNumberPrefixChars + 1;
			if (nextChars > MAX_READ_OUTPUT_CHARS && captured.length > 0) {
				capped = true;
				continue;
			}

			captured.push({ lineNumber: totalLines, text: line });
			chars = nextChars;
		}
	} finally {
		if (signal && abortHandler) {
			signal.removeEventListener("abort", abortHandler);
		}
		reader.close();
		stream.destroy();
	}

	const maxLineNumWidth = String(
		captured[captured.length - 1]?.lineNumber ?? totalLines,
	).length;
	const body = captured
		.map(({ lineNumber, text }) =>
			includeLineNumbers
				? `${String(lineNumber).padStart(maxLineNumWidth, " ")} | ${text}`
				: text,
		)
		.join("\n");
	// Refused, not truncated. `chars` is what this window would return; past
	// the cap the model is sent back to ask for the part it needs. The range it
	// asked for is echoed so the refusal is actionable rather than a wall.
	if (chars > maxReadChars) {
		const shown = captured.length;
		const firstShown = captured[0]?.lineNumber ?? requestedStartLine;
		// How many lines of *this* file would fit, rather than a rule of thumb:
		// a refusal that does not say how much is too much makes the model
		// guess, and it guesses far too small. Measured from what it just asked
		// for, so a file of long lines gets a smaller number than one of short.
		const fitsLines = Math.max(
			1,
			Math.floor((shown * maxReadChars) / Math.max(1, chars)),
		);
		throw new Error(
			`Read too large: this window is ${chars} characters (max: ${maxReadChars}). ` +
				`The file has ${fileLineCount} lines and you asked for ${shown} of them starting at ${firstShown}. ` +
				`About ${fitsLines} lines of this file fit in one read, so read it in ranges of that size with ` +
				"`start_line` and `end_line` — or find the part you need first with grep, which is cheaper than " +
				"reading the file to look for one thing in it.",
		);
	}

	const lastCapturedLine = captured[captured.length - 1]?.lineNumber;
	if (lastCapturedLine === undefined) {
		// Nothing was captured, so nothing has been seen: no span to record.
		return { text: body, firstLine: 0, lastLine: -1 };
	}
	// The span the model actually saw, which is not the span it asked for
	// whenever the read was capped by line count or output size.
	const seen = {
		firstLine: captured[0]?.lineNumber ?? requestedStartLine,
		lastLine: lastCapturedLine,
	};

	// How long the file is, said on every read rather than only on a truncated
	// one. It is the number needed to replace a file whole (`start_line: 1`
	// with `end_line` at the count) and there was no way to ask for it.
	const fileLength = approximateFileLineCount
		? `${fileLineCount}+`
		: `${fileLineCount}`;

	const effectiveEndLine = Math.min(requestedEndLine, totalLines);
	if (lastCapturedLine >= effectiveEndLine) {
		const readWholeFile =
			requestedStartLine === 1 &&
			!approximateFileLineCount &&
			lastCapturedLine === fileLineCount;
		return {
			text: readWholeFile
				? `${body}\n\n[${fileLength} lines, shown in full.]`
				: `${body}\n\n[Lines ${requestedStartLine}-${lastCapturedLine} of ${fileLength}.]`,
			...seen,
		};
	}

	// `approximateTotalLines` was the old ceiling on counting: an unranged read
	// stopped scanning and could only say "50000+". The count now continues
	// past the capture window, so say the real number whenever there is one.
	const totalLineText =
		approximateFileLineCount && approximateTotalLines
			? `${fileLength} lines`
			: fileLength;

	return {
		text:
			`${body}\n\n` +
			`[Showing lines ${requestedStartLine}-${lastCapturedLine} of ${totalLineText}. ` +
			"Use start_line/end_line to read other sections.]",
		...seen,
	};
}

/**
 * Create a file read executor using Node.js fs module
 *
 * @example
 * ```typescript
 * const readFile = createFileReadExecutor({
 *   maxFileSizeBytes: 5_000_000, // 5MB limit
 *   includeLineNumbers: true,
 * })
 *
 * const content = await readFile({ path: "/path/to/file.ts" }, context)
 * ```
 */
export function createFileReadExecutor(
	options: FileReadExecutorOptions = {},
): FileReadExecutor {
	const { receipts, cwd, readLedger } = options;
	const { maxFileSizeBytes, encoding, includeLineNumbers, maxReadChars } = {
		...DEFAULT_FILE_READ_OPTIONS,
		...options,
	};

	return async (request: ReadFileRequest, context: AgentToolContext) => {
		const { path: filePath, start_line, end_line } = request;
		// Per-request, falling back to the executor default. A caller about to
		// copy this text into `editor` needs it without the gutter; everyone
		// else keeps the line numbers they address edits by.
		const withLineNumbers = request.line_numbers ?? includeLineNumbers;
		const initialPath = path.isAbsolute(filePath)
			? path.normalize(filePath)
			: path.resolve(cwd ?? process.cwd(), filePath);
		// Tolerate Unicode-whitespace mismatches (e.g. macOS Sonoma+
		// screenshot paths where the on-disk filename contains U+202F but
		// the caller's string has a regular space).
		const resolvedPath = resolveExistingFilePath(initialPath) ?? initialPath;
		const extension = path.extname(resolvedPath).toLowerCase();
		const imageMediaType = IMAGE_MEDIA_TYPES.get(extension);

		// Check if file exists
		const stat = await fs.stat(resolvedPath);

		if (!stat.isFile()) {
			throw new Error(`Path is not a file: ${resolvedPath}`);
		}

		if (imageMediaType) {
			if (stat.size > maxFileSizeBytes) {
				throw new Error(
					`Image file too large: ${stat.size} bytes (max: ${maxFileSizeBytes} bytes).`,
				);
			}
			if (context.metadata?.modelSupportsImages !== true) {
				throw new Error("Current model does not support image input");
			}
			const data = await fs.readFile(resolvedPath);
			return [
				{
					type: "text",
					text: "Successfully read image",
				},
				{
					type: "image",
					data: data.toString("base64"),
					mediaType: imageMediaType,
				},
			];
		}

		if (stat.size > MAX_TEXT_STREAM_BYTES) {
			throw new Error(
				`Text file too large to stream safely: ${stat.size} bytes (max: ${MAX_TEXT_STREAM_BYTES} bytes). Use a targeted command such as sed, grep, head, or tail to inspect specific sections.`,
			);
		}

		// Under the lock, so a read cannot land in the middle of this process's
		// own write. `fs.writeFile` truncates and then writes, and a reader in
		// that window sees a file that is neither the old one nor the new one --
		// the one failure here that produces content no version of the file ever
		// had. A reader in another process can still see it; that is what the
		// stamps are for.
		const window = await withFileLock(resolvedPath, () =>
			readTextWindow(
				{ kind: "file", path: resolvedPath },
				encoding,
				withLineNumbers,
				start_line,
				end_line,
				context.signal,
				maxReadChars,
			),
		);
		// Record what was actually looked at, so `editor` can refuse an edit
		// aimed at lines that were never read. The span comes from the read
		// itself, not from the request: a read capped by line count or output
		// size returns less than it was asked for, and crediting the model for
		// lines it never saw is the one way this guard could wave through the
		// edit it exists to catch.
		if (window.lastLine >= window.firstLine) {
			receipts?.noteRead(resolvedPath, window.firstLine, window.lastLine);
		}
		// Did the file move under this session between the last look and this
		// one? Asked here rather than inferred from the conversation, because
		// the conversation cannot answer it: a second agent, a background task,
		// a shell command or the user's own editor all leave no trace in the
		// transcript, and the model has no way to know its read was stale until
		// an edit lands on the wrong lines.
		const stamp = await readFileStamp(resolvedPath);
		const movedUnderUs = receipts?.changedSince(resolvedPath, stamp) ?? false;
		receipts?.noteStamp(resolvedPath, stamp);
		// Receipts are recorded either way above: a model told the file has not
		// changed has still seen these lines in this conversation, and refusing
		// its next edit for not having read them would be false.
		const unchanged = readLedger?.noticeFor(
			{
				path: resolvedPath,
				firstLine: window.firstLine,
				lastLine: window.lastLine,
				withLineNumbers,
			},
			window.text,
		);
		const text = unchanged ?? window.text;
		// Ahead of the content, not after it. A model that has what it asked for
		// stops reading, and this is the one thing it must not miss: everything
		// it believed about this file a moment ago may be wrong.
		return movedUnderUs
			? `${describeMovedUnderUs(resolvedPath)}\n\n${text}`
			: text;
	};
}

/**
 * Tell the model its earlier view of a file is out of date.
 *
 * Says who did it — or rather, says that this session did not — because the
 * two cases need opposite responses. A file the model changed itself is
 * expected and needs nothing; a file something else changed means every line
 * number it is holding may be wrong, and the fix is to trust this read and
 * discard the earlier one rather than to reconcile them.
 */
function describeMovedUnderUs(path: string): string {
	return [
		`NOTE: ${path} changed since you last looked at it, and not because of anything you did.`,
		"Something outside this session wrote to it — another agent working in parallel, a background task, a command you ran, or the user.",
		"Use the content below and discard what you remember of this file: earlier line numbers may now point at different code.",
	].join(" ");
}

/**
 * Window a string exactly as a read of the same file on disk would.
 *
 * For content that has no path to stream from — the change protocol's
 * transaction snapshot, which holds what each file said when the transaction
 * opened. Sharing the windowing with the disk path is the whole point: a base
 * revision that numbered or truncated its lines differently could not be laid
 * next to the working file, which is the only reason to read one.
 */
export async function readTextWindowFromText(options: {
	text: string;
	includeLineNumbers?: boolean;
	startLine?: number | null;
	endLine?: number | null;
	signal?: AbortSignal;
	/** Defaults to {@link MAX_READ_REFUSAL_CHARS}, as the file executor does. */
	maxReadChars?: number;
}): Promise<ReadWindow> {
	return readTextWindow(
		{ kind: "text", text: options.text },
		"utf8",
		options.includeLineNumbers ?? true,
		options.startLine,
		options.endLine,
		options.signal,
		options.maxReadChars ?? MAX_READ_REFUSAL_CHARS,
	);
}
