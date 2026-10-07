/**
 * One document read, as a request that can be handed to another process.
 *
 * Everything a read needs is in `ReadJob` as plain data, and everything it
 * needs from the session while it runs (the vision model, progress, a stop)
 * is in `ReadJobHooks`. `runReadJob` is the work itself: the reader process
 * runs it (`read-child.ts`), and so does this process where no reader process
 * can be started.
 */

import fs from "node:fs/promises";
import { readEbook } from "./ebook";
import {
	type DocumentFormat,
	type DocumentReadResult,
	detectFormat,
	type ReadOptions,
	type ReadProgress,
} from "./formats";
import { type ExtractedImage, ImageCollector } from "./images";
import { readLegacyOffice } from "./legacy";
import type { DocumentReaderSettings } from "./ocr";
import { readOffice } from "./office";
import { readPdf } from "./pdf";
import { parseUnitRange } from "./range";
import {
	type DescribeImages,
	type OcrRequest,
	planRecognition,
} from "./recognition";

export interface ReadJob {
	/** The file to read. */
	filePath: string;
	/**
	 * The path whose name says what the file is, when that is not `filePath`:
	 * a delegated agent's overlay keeps its copy under another name.
	 */
	namedAs?: string;
	/** Whether pictures are taken out as well. */
	wantImages: boolean;
	password?: string;
	/** Which pages, slides, sheets or chapters: `"1-5,9,12-"`. */
	range?: string;
	/** An existing directory the read may write in; the caller removes it. */
	scratchDir: string;
	/** How scanned pages are read. Only a PDF has any. */
	recognition: {
		request?: OcrRequest;
		languages?: string;
		settings: DocumentReaderSettings;
		modelSupportsImages: boolean;
		/** A book kept in the Library is read whole, however many scanned pages. */
		everyPage?: boolean;
	};
}

export interface ReadJobHooks {
	/** The session's vision model, when there is one. */
	describeImages?: DescribeImages;
	/** Stops the read at the next page or chapter; the read throws. */
	signal?: AbortSignal;
	onProgress?: (progress: ReadProgress) => void;
	/** Lines for the log, not for the reader of the document. */
	onNote?: (line: string) => void;
}

export interface ReadJobResult {
	format: DocumentFormat;
	result: DocumentReadResult;
	/** Every picture with its bytes, in the order they were found. */
	images: { image: ExtractedImage; data: Uint8Array }[];
	/** What recognition has to say, in sentences, for the result's header. */
	recognitionNotes: string[];
	/** Every scanned page left without text, a line each. */
	recognitionProblems: string[];
	/** Page images for the session's own model to read. */
	attachments: { page: number; png: Uint8Array }[];
	/** Everything else the read left out, a line each. */
	problems: string[];
}

function read(
	filePath: string,
	data: Uint8Array,
	format: DocumentFormat,
	options: ReadOptions,
): Promise<DocumentReadResult> {
	switch (format) {
		case "pdf":
			return readPdf(data, options);
		case "doc":
		case "xls":
		case "ppt":
			return readLegacyOffice(data, format, options);
		case "epub":
		case "mobi":
		case "azw3":
		case "fb2":
			return readEbook(filePath, data, format, options);
		default:
			return readOffice(data, format, options);
	}
}

export async function runReadJob(
	job: ReadJob,
	hooks: ReadJobHooks = {},
): Promise<ReadJobResult> {
	const data = new Uint8Array(await fs.readFile(job.filePath));
	const verdict = detectFormat(
		job.namedAs ?? job.filePath,
		data.subarray(0, 512),
	);
	if ("unsupported" in verdict) {
		throw new Error(verdict.unsupported);
	}
	const { format } = verdict;
	const range = parseUnitRange(job.range);
	const recognition =
		format === "pdf"
			? planRecognition({
					request: job.recognition.request,
					languages: job.recognition.languages,
					settings: job.recognition.settings,
					describeImages: hooks.describeImages,
					modelSupportsImages: job.recognition.modelSupportsImages,
					...(job.recognition.everyPage
						? { pageLimit: Number.POSITIVE_INFINITY }
						: {}),
				})
			: undefined;
	const problems: string[] = [];
	const images = new ImageCollector("images");
	let result: DocumentReadResult;
	try {
		result = await read(job.filePath, data, format, {
			images,
			wantImages: job.wantImages,
			scratchDir: job.scratchDir,
			problems,
			...(job.password ? { password: job.password } : {}),
			...(range ? { selects: range.selects } : {}),
			...(hooks.signal ? { signal: hooks.signal } : {}),
			...(hooks.onProgress ? { onProgress: hooks.onProgress } : {}),
			...(hooks.onNote ? { onNote: hooks.onNote } : {}),
			...(recognition?.recognize ? { recognize: recognition.recognize } : {}),
		});
	} finally {
		await recognition?.close();
	}
	const scanned = result.scannedPages ?? [];
	const recognized = result.recognizedPages ?? [];
	return {
		format,
		result,
		images: [...images.entries()],
		recognitionNotes: recognition?.notes(scanned, recognized) ?? [],
		recognitionProblems: recognition?.problems(scanned, recognized) ?? [],
		attachments: recognition?.attachments ?? [],
		problems,
	};
}
