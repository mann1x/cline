/**
 * File Read Executor
 *
 * Built-in implementation for reading files using Node.js fs module.
 */

import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";
import type { AgentToolContext } from "@cline/shared";
import { resolveExistingFilePath } from "@cline/shared/storage";
import type { ReadFileRequest } from "../schemas";
import type { FileReadExecutor } from "../types";
import {
	MAX_LINE_CHARS,
	MAX_READ_LINES,
	MAX_READ_OUTPUT_CHARS,
} from "./output-limits";
import type { ReadReceipts } from "./read-receipts";

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
	 * Shared record of what has been read. Paired with the same object on the
	 * editor executor, this is what lets an edit require a prior read.
	 */
	receipts?: ReadReceipts;
}

// `receipts` is deliberately outside the defaults: there is no sensible
// default registry, and its absence is what turns the read-before-edit guard
// off for a standalone executor.
const DEFAULT_FILE_READ_OPTIONS: Required<
	Omit<FileReadExecutorOptions, "receipts">
> = {
	maxFileSizeBytes: 10_000_000, // 10MB default limit
	encoding: "utf-8", // Default to UTF-8 encoding
	includeLineNumbers: true, // Include line numbers by default
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
interface ReadWindow {
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
	filePath: string,
	encoding: BufferEncoding,
	includeLineNumbers: boolean,
	startLine: number | null | undefined,
	endLine: number | null | undefined,
	signal?: AbortSignal,
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

	const stream = createReadStream(filePath, { encoding });
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
	const { receipts } = options;
	const { maxFileSizeBytes, encoding, includeLineNumbers } = {
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
			: path.resolve(process.cwd(), filePath);
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

		const window = await readTextWindow(
			resolvedPath,
			encoding,
			withLineNumbers,
			start_line,
			end_line,
			context.signal,
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
		return window.text;
	};
}
