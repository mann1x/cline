/**
 * Document Extract Executor
 *
 * Turns a document (PDF, Office old and new, OpenDocument, RTF, ebooks) into
 * markdown or plain text, and writes the pictures inside it out as files.
 * Pure JavaScript and WebAssembly only: it runs in the extension and the CLI
 * alike, with no converter installed on the machine.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent, TextContent } from "@cline/shared";
import type { AgentOverlay } from "../../../runtime/sandbox/overlay-fs";
import type { ExtractDocumentExecutor } from "../types";
import {
	type DocumentFormat,
	type DocumentReadResult,
	FORMAT_LABELS,
	type ReadProgress,
} from "./document/formats";
import { type ExtractedImage, VIEWABLE_MEDIA_TYPES } from "./document/images";
import type { DocumentReaderSettings } from "./document/ocr";
import { formatUnits, parseUnitRange } from "./document/range";
import { type HeldRead, readDocumentJob } from "./document/read-process";
import {
	altTextOf,
	DESCRIBE_LIMIT,
	type DescribeImages,
	describePictures,
} from "./document/recognition";

/** Where extractions go when the call names no `output_dir`. */
export const DEFAULT_EXTRACTION_DIR = path.join(".cline", "extracted");

export interface DocumentExtractExecutorOptions {
	/** The workspace; relative paths resolve against it and output stays in it. */
	cwd?: string;
	/** A delegated agent's overlay: reads fall through, writes stay private. */
	overlay?: AgentOverlay;
	/** @default 200 MB */
	maxFileSizeBytes?: number;
	/** The user's Document Reader settings: how scanned pages are read, and descriptions. */
	reader?: DocumentReaderSettings;
	/**
	 * The session's vision model (the Vision tab, or the CLI's
	 * `--vision-model`), when there is one: it reads scanned pages for
	 * `ocr: "vision"` and describes pictures.
	 */
	describeImages?: DescribeImages;
}

const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024;
/** How many pictures `images: "inline"` attaches, and how large each may be. */
const INLINE_IMAGE_LIMIT = 4;
const INLINE_IMAGE_BYTES = 1_500_000;
/** Pictures smaller than this on both sides are not worth a look. */
const INLINE_MIN_SIDE = 32;
/** A scanned page handed to the model to read: larger than a picture, still bounded. */
const PAGE_IMAGE_BYTES = 3_500_000;
/** Pictures smaller than this on both sides are bullets and icons, not worth describing. */
const DESCRIBE_MIN_SIDE = 48;

/**
 * The executor options a session's configuration gives the tool: the user's
 * settings and the session's vision model. The same for the lead and every
 * agent it delegates to, so a delegated agent reads a scan the way the lead
 * would.
 */
export function documentReaderExecutorOptions(config: {
	enableExtractDocument?: boolean;
	documentReader?: DocumentReaderSettings;
	describeImages?: DescribeImages;
}): DocumentExtractExecutorOptions | undefined {
	if (config.enableExtractDocument !== true) return undefined;
	return {
		...(config.documentReader ? { reader: config.documentReader } : {}),
		...(config.describeImages ? { describeImages: config.describeImages } : {}),
	};
}

function isInside(root: string, target: string): boolean {
	const rel = path.relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function shown(cwd: string, target: string): string {
	const rel = path.relative(cwd, target);
	return (isInside(cwd, target) ? rel || "." : target)
		.split(path.sep)
		.join("/");
}

function stemOf(filePath: string): string {
	return (
		path
			.basename(filePath, path.extname(filePath))
			.replace(/[^a-zA-Z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 80) || "document"
	);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Markdown as plain text: the words, without the markup.
 *
 * Pictures stay as a bracketed file name, because the file is where the
 * picture went and the text around it may refer to it.
 */
export function markdownToText(markdown: string): string {
	return markdown
		.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, link: string) =>
			alt ? `[image: ${alt} (${link})]` : `[image: ${link}]`,
		)
		.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")
		.replace(/\s*\{#[^}]+\}/g, "")
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, "")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2")
		.replace(/^>\s?/gm, "")
		.replace(/\\([\\`*_{}[\]()#+\-.!|])/g, "$1")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/**
 * The same tidy for every reader's markdown: heading ids (`{#intro}`), lines
 * holding only indentation, and runs of blank lines. None of it is content,
 * and all of it is tokens.
 */
export function tidyMarkdown(markdown: string): string {
	return markdown
		.replace(/^(#{1,6}[ \t]+.*?)[ \t]*\{#[^}\n]+\}[ \t]*$/gm, "$1")
		.replace(/^(#{1,6})[ \t]{2,}/gm, "$1 ")
		.replace(/^[ \t]+$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export interface DocumentText {
	/** The document as markdown. */
	markdown: string;
	format: DocumentFormat;
	title?: string;
	author?: string;
	bytes: number;
	/** What was skipped or could not be read, in sentences. */
	notes: string[];
}

/**
 * A document's text, and nothing written anywhere: what the Library indexes.
 *
 * The same readers as the tool, without the pictures. Scanned pages are read
 * when the settings name an engine that needs no model in the conversation
 * (tesseract, or the vision model when one is given).
 */
export async function readDocumentText(
	filePath: string,
	options: {
		/** Removed afterwards. Not the system temp directory: a book's pages can be large. */
		scratchDir: string;
		maxFileSizeBytes?: number;
		reader?: DocumentReaderSettings;
		describeImages?: DescribeImages;
	},
): Promise<DocumentText> {
	const stat = await fs.stat(filePath).catch(() => undefined);
	if (!stat?.isFile()) {
		throw new Error(`No file at ${filePath}.`);
	}
	const limit = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_BYTES;
	if (stat.size > limit) {
		throw new Error(
			`${filePath} is ${formatBytes(stat.size)}, past the ${formatBytes(limit)} the Document Reader reads.`,
		);
	}
	const read = await readDocumentJob(
		{
			filePath,
			wantImages: false,
			scratchDir: path.join(
				options.scratchDir,
				`.scratch-${randomBytes(4).toString("hex")}`,
			),
			recognition: {
				settings: options.reader ?? {},
				modelSupportsImages: false,
			},
		},
		options.describeImages ? { describeImages: options.describeImages } : {},
	);
	await read.release();
	const { result } = read;
	return {
		markdown: tidyMarkdown(result.markdown),
		format: read.format,
		...(result.title ? { title: result.title } : {}),
		...(result.author ? { author: result.author } : {}),
		bytes: stat.size,
		notes: [...read.recognitionNotes, ...(result.notes ?? [])],
	};
}

export interface BookDocument extends DocumentText {
	/**
	 * The pictures inside it; the markdown links them as `images/<file>`.
	 * Each one's bytes are in the file at `path`, not in memory: a scanned
	 * book is a picture a page. They are there until `release`.
	 */
	images: {
		file: string;
		path: string;
		mediaType: string;
		width?: number;
		height?: number;
		origin?: string;
		description?: string;
		/** `description` is a vision model's, not the caption the document gave. */
		described?: boolean;
	}[];
	/** Pages or chapters it has, and how many were read. */
	units?: { name: string; total: number; read: number };
	/** Scanned pages, and how many of them had their text recognized. */
	scanned?: { pages: number; recognized: number };
	/**
	 * Everything that was left out, a line each: a scanned page with no
	 * recognized text, a picture that could not be taken out. Empty when the
	 * whole document was read.
	 */
	problems: string[];
	/**
	 * Removes the pictures' files. Called once the book is filed or given
	 * up, on every path; a session that dies first leaves them for
	 * `sweepAbandonedReads`.
	 */
	release(): Promise<void>;
}

/** How old a read's scratch directory is before nothing can still be using it. */
const ABANDONED_READ_MS = 6 * 60 * 60_000;

/**
 * Remove scratch directories that reads left behind: a session that ended
 * between reading a book and filing it never released its pictures.
 */
export async function sweepAbandonedReads(
	scratchDir: string,
	olderThanMs: number = ABANDONED_READ_MS,
): Promise<void> {
	const names = await fs.readdir(scratchDir).catch(() => [] as string[]);
	const now = Date.now();
	for (const name of names) {
		if (!name.startsWith(".scratch-")) continue;
		const at = path.join(scratchDir, name);
		const stat = await fs.stat(at).catch(() => undefined);
		if (stat && now - stat.mtimeMs > olderThanMs) {
			await fs.rm(at, { recursive: true, force: true }).catch(() => {});
		}
	}
}

/**
 * A document as the Library keeps a book: its text and its pictures.
 * Nothing is written anywhere the caller sees; the caller puts the pictures
 * where the book is kept, `describeBookPictures` has a vision model look at
 * them, and `release` removes them.
 */
export async function readDocumentForBook(
	filePath: string,
	options: {
		scratchDir: string;
		maxFileSizeBytes?: number;
		reader?: DocumentReaderSettings;
		describeImages?: DescribeImages;
		/**
		 * Take the pictures out as well. Off for a read that only compares
		 * text: a scanned book is a picture a page, a gigabyte of them decoded.
		 * @default true
		 */
		pictures?: boolean;
		/** Stops the read at the next page or chapter; the read throws. */
		signal?: AbortSignal;
		onProgress?: (progress: ReadProgress) => void;
		/** Lines for the log: what the decoder warned about, a picture asked for twice. */
		onNote?: (line: string) => void;
	},
): Promise<BookDocument> {
	const stat = await fs.stat(filePath).catch(() => undefined);
	if (!stat?.isFile()) {
		throw new Error(`No file at ${filePath}.`);
	}
	const limit = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_BYTES;
	if (stat.size > limit) {
		throw new Error(
			`${filePath} is ${formatBytes(stat.size)}, past the ${formatBytes(limit)} the Document Reader reads.`,
		);
	}
	await sweepAbandonedReads(options.scratchDir);
	const read = await readDocumentJob(
		{
			filePath,
			wantImages: options.pictures ?? true,
			scratchDir: path.join(
				options.scratchDir,
				`.scratch-${randomBytes(4).toString("hex")}`,
			),
			recognition: {
				settings: options.reader ?? {},
				modelSupportsImages: false,
				// A book kept in the Library is read whole, however long that
				// is. A read that only compares text keeps the usual limit.
				...(options.pictures === false ? {} : { everyPage: true }),
			},
		},
		{
			...(options.describeImages
				? { describeImages: options.describeImages }
				: {}),
			...(options.signal ? { signal: options.signal } : {}),
			...(options.onProgress ? { onProgress: options.onProgress } : {}),
			...(options.onNote ? { onNote: options.onNote } : {}),
		},
	);
	// Nothing to hold: the scratch directory goes now.
	if (read.images.length === 0) await read.release();
	const { result } = read;
	return {
		markdown: tidyMarkdown(result.markdown),
		format: read.format,
		...(result.title ? { title: result.title } : {}),
		...(result.author ? { author: result.author } : {}),
		bytes: stat.size,
		notes: [...read.recognitionNotes, ...(result.notes ?? [])],
		...(result.units
			? {
					units: {
						name: result.units.name,
						total: result.units.total,
						read: result.units.read.length,
					},
				}
			: {}),
		...(result.scannedPages?.length
			? {
					scanned: {
						pages: result.scannedPages.length,
						recognized: result.recognizedPages?.length ?? 0,
					},
				}
			: {}),
		problems: [...read.recognitionProblems, ...read.problems],
		release: read.images.length === 0 ? async () => {} : read.release,
		images: read.images.map(({ image, file }) => ({
			file: image.file,
			path: file,
			mediaType: image.mediaType,
			...(image.width ? { width: image.width } : {}),
			...(image.height ? { height: image.height } : {}),
			...(image.source ? { origin: image.source } : {}),
			...((image.description ?? image.alt)
				? { description: image.description ?? image.alt }
				: {}),
		})),
	};
}

/**
 * Have the vision model describe a book's pictures: each description is kept
 * with its picture and becomes the alt text where the text shows it, so a
 * search for what a figure shows finds the page it is on. Resolves with how
 * many were described and how many could have been.
 */
export async function describeBookPictures(
	book: BookDocument,
	describeImages: DescribeImages,
	options: { documentName: string; limit?: number },
): Promise<{ described: number; candidates: number }> {
	const candidates = book.images.filter(
		(image) =>
			VIEWABLE_MEDIA_TYPES.has(image.mediaType) &&
			!(
				image.width &&
				image.height &&
				image.width < DESCRIBE_MIN_SIDE &&
				image.height < DESCRIBE_MIN_SIDE
			),
	);
	const chosen = candidates.slice(0, options.limit ?? 40);
	const descriptions = await describePictures(
		describeImages,
		chosen.map((image) => ({
			link: `images/${image.file}`,
			mediaType: image.mediaType,
			data: () => fs.readFile(image.path),
			...(image.origin ? { source: image.origin } : {}),
		})),
		options.documentName,
	);
	let described = 0;
	chosen.forEach((image, index) => {
		const description = descriptions[index];
		if (!description) return;
		described++;
		image.description = description;
		image.described = true;
		const alt = altTextOf(description);
		book.markdown = book.markdown.replace(
			new RegExp(
				`!\\[[^\\]]*\\]\\(${escapeRegExp(`images/${image.file}`)}\\)`,
				"g",
			),
			() => `![${alt}](images/${image.file})`,
		);
	});
	return { described, candidates: candidates.length };
}

export function createDocumentExtractExecutor(
	options: DocumentExtractExecutorOptions = {},
): ExtractDocumentExecutor {
	const { overlay, describeImages } = options;
	const settings = options.reader ?? {};
	const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_BYTES;

	return async (input, callCwd, context) => {
		// `cwd` is taken per call; the creation-time one is the fallback.
		const cwd = path.resolve(callCwd || options.cwd || process.cwd());
		const requested = path.isAbsolute(input.path)
			? path.normalize(input.path)
			: path.resolve(cwd, input.path);
		const sourcePath = overlay
			? await overlay.resolveRead(requested)
			: requested;

		const stat = await fs.stat(sourcePath).catch(() => undefined);
		if (!stat) {
			throw new Error(
				`No file at ${input.path}. Check the path; relative paths start at the workspace root.`,
			);
		}
		if (!stat.isFile()) {
			throw new Error(`${input.path} is a directory, not a document.`);
		}
		if (stat.size > maxFileSizeBytes) {
			throw new Error(
				`${input.path} is ${formatBytes(stat.size)}, past the ${formatBytes(maxFileSizeBytes)} this tool reads.`,
			);
		}
		const range = parseUnitRange(input.range ?? undefined);

		// Output stays inside the workspace, for the lead and every delegated
		// agent alike: the same rule the editor keeps for its writes.
		const outputDir = input.output_dir?.trim()
			? path.resolve(cwd, input.output_dir.trim())
			: path.join(cwd, DEFAULT_EXTRACTION_DIR, stemOf(requested));
		if (!isInside(cwd, outputDir)) {
			throw new Error(
				`output_dir ${input.output_dir} is outside the workspace. Extractions are written inside it: give a path under ${cwd}, or omit output_dir for ${DEFAULT_EXTRACTION_DIR}/.`,
			);
		}
		// Every write goes through the overlay when there is one, so a delegated
		// agent's extraction lands in its private copy of the workspace.
		const writeFile = async (target: string, contents: Uint8Array | string) => {
			const real = overlay ? await overlay.resolveWrite(target) : target;
			await fs.mkdir(path.dirname(real), { recursive: true });
			await fs.writeFile(real, contents);
		};
		const scratchTarget = path.join(
			outputDir,
			`.scratch-${randomBytes(4).toString("hex")}`,
			"x",
		);
		const scratchDir = path.dirname(
			overlay ? await overlay.resolveWrite(scratchTarget) : scratchTarget,
		);

		const wantImages = input.images !== "none";
		const modelSupportsImages = context.metadata?.modelSupportsImages === true;
		const read = await readDocumentJob(
			{
				filePath: sourcePath,
				namedAs: requested,
				wantImages,
				...(input.password ? { password: input.password } : {}),
				...(range ? { range: range.spec } : {}),
				scratchDir,
				recognition: {
					...(input.ocr ? { request: input.ocr } : {}),
					...(input.ocr_languages ? { languages: input.ocr_languages } : {}),
					settings,
					modelSupportsImages,
				},
			},
			describeImages ? { describeImages } : {},
		);
		const fileBytes = stat.size;
		// The pictures are files in the scratch directory until this call is
		// done with them, and are read one at a time.
		try {
			return await answer(read);
		} finally {
			await read.release();
		}

		async function answer(
			read: HeldRead,
		): Promise<string | (TextContent | ImageContent)[]> {
			const { format, result, images } = read;
			const pictures = images.map((entry) => entry.image);

			const describeNote = await describeExtractedPictures({
				wanted:
					wantImages &&
					(input.describe_images ?? settings.describePictures ?? false),
				describeImages,
				images,
				result,
				documentName: shown(cwd, requested),
			});

			const suffix = range ? `.${range.spec.replace(/[^0-9,-]/g, "")}` : "";
			const asText = input.format === "text";
			const markdown = tidyMarkdown(describeNote.markdown ?? result.markdown);
			const body = asText ? markdownToText(markdown) : markdown;
			const documentFile = path.join(
				outputDir,
				`${stemOf(requested)}${suffix}.${asText ? "txt" : "md"}`,
			);
			await writeFile(documentFile, `${body}\n`);
			for (const { image, file } of images) {
				await writeFile(
					path.join(outputDir, "images", image.file),
					await fs.readFile(file),
				);
			}
			const indexFile = path.join(outputDir, "images", `index${suffix}.json`);
			if (pictures.length > 0) {
				await writeFile(
					indexFile,
					`${JSON.stringify(
						{
							document: shown(cwd, requested),
							images: pictures.map(({ sha1: _sha1, ...image }) => image),
						},
						null,
						2,
					)}\n`,
				);
			}

			const header = describe({
				cwd,
				requested,
				bytes: fileBytes,
				format,
				result,
				images: pictures,
				documentFile,
				indexFile,
				outputDir,
				range: range?.spec,
				bodyChars: body.length,
				wantImages,
				notes: [
					...read.recognitionNotes,
					...(describeNote.note ? [describeNote.note] : []),
				],
			});
			const maxChars = input.max_chars ?? 60_000;
			const cut = body.length > maxChars;
			const text = [
				header,
				"---",
				cut ? body.slice(0, maxChars) : body || "(The document has no text.)",
				...(cut
					? [
							`[Cut at ${maxChars.toLocaleString("en-US")} of ${body.length.toLocaleString("en-US")} characters. The whole text is in ${shown(cwd, documentFile)}: read the rest with read_files and start_line, or call again with a narrower range.]`,
						]
					: []),
			].join("\n\n");

			const pages = read.attachments.filter(
				(page) => page.png.byteLength <= PAGE_IMAGE_BYTES,
			);
			const inline = input.images === "inline" && pictures.length > 0;
			if (!inline && pages.length === 0) {
				return text;
			}
			if (!modelSupportsImages) {
				return `${text}\n\n[images: "inline" attaches nothing here: this model does not take image input. The pictures are the files listed above.]`;
			}
			const attached: (TextContent | ImageContent)[] = [{ type: "text", text }];
			for (const page of pages) {
				attached.push({
					type: "text",
					text: `Scanned page ${page.page}, to read:`,
				});
				attached.push({
					type: "image",
					data: Buffer.from(page.png).toString("base64"),
					mediaType: "image/png",
				});
			}
			const pictureStart = attached.length;
			for (const { image, file } of inline ? images : []) {
				if (attached.length - pictureStart >= INLINE_IMAGE_LIMIT * 2) break;
				if (
					!VIEWABLE_MEDIA_TYPES.has(image.mediaType) ||
					image.bytes > INLINE_IMAGE_BYTES
				)
					continue;
				if (
					image.width &&
					image.height &&
					image.width < INLINE_MIN_SIDE &&
					image.height < INLINE_MIN_SIDE
				)
					continue;
				attached.push({
					type: "text",
					text: `${image.link}${image.source ? ` (${image.source})` : ""}:`,
				});
				attached.push({
					type: "image",
					data: (await fs.readFile(file)).toString("base64"),
					mediaType: image.mediaType,
				});
			}
			return attached;
		}
	};
}

function describe(input: {
	cwd: string;
	requested: string;
	bytes: number;
	format: DocumentFormat;
	result: DocumentReadResult;
	images: readonly ExtractedImage[];
	documentFile: string;
	indexFile: string;
	outputDir: string;
	range?: string;
	bodyChars: number;
	wantImages: boolean;
	/** Recognition and description, said by the parts that did them. */
	notes: readonly string[];
}): string {
	const { cwd, result } = input;
	const lines = [
		`Document: ${shown(cwd, input.requested)} (${FORMAT_LABELS[input.format]}, ${formatBytes(input.bytes)}), read with ${result.reader}.`,
	];
	const byline = [
		result.title && `Title: ${result.title}`,
		result.author && `Author: ${result.author}`,
	].filter(Boolean);
	if (byline.length) lines.push(byline.join(" · "));
	if (result.units) {
		const { name, total, read } = result.units;
		const plural = total === 1 ? name : `${name}s`;
		lines.push(
			input.range
				? `${total} ${plural}; read ${read.length ? `${name}s ${formatUnits(read)}` : "none: the range selects nothing that exists"}.`
				: `${total} ${plural}.`,
		);
	} else if (input.range) {
		lines.push(
			`range was ignored: a ${FORMAT_LABELS[input.format]} is one flow of text, not pages, slides, sheets or chapters.`,
		);
	}
	if (result.contents?.length) {
		const shownContents = result.contents.slice(0, 40);
		lines.push(
			`Contents:\n${shownContents.map((entry) => `  ${entry}`).join("\n")}${result.contents.length > shownContents.length ? `\n  … ${result.contents.length - shownContents.length} more` : ""}`,
		);
	}
	for (const note of input.notes) lines.push(note);
	if (result.ocrLayerPages?.length) {
		lines.push(
			`Pages ${formatUnits(result.ocrLayerPages)} are scans that already carry a recognized text layer; that text is included.`,
		);
	}
	if (result.vectorPages?.length) {
		lines.push(
			`Pages ${formatUnits(result.vectorPages)} are drawn as shapes, with no text or pictures to read; nothing here can read them.`,
		);
	}
	for (const note of result.notes ?? []) lines.push(note);
	const imageLine = !input.wantImages
		? 'Pictures were not extracted (images: "none").'
		: input.images.length === 0
			? "No pictures."
			: `${input.images.length} picture(s) in ${shown(cwd, path.join(input.outputDir, "images"))}/, listed in ${shown(cwd, input.indexFile)}${input.images.some((image) => image.notViewable) ? `; ${input.images.filter((image) => image.notViewable).length} of them are EMF, WMF, PICT, TIFF or BMP, kept as files but not viewable as they are` : ""}.`;
	lines.push(
		`Wrote ${shown(cwd, input.documentFile)} (${input.bodyChars.toLocaleString("en-US")} characters). ${imageLine}`,
	);
	return lines.join("\n");
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Descriptions of the document's pictures by the vision model, written into
 * each picture's index entry and, shortened, into its alt text.
 *
 * Not the pictures a scanned page is drawn from: those are the page, and its
 * text is what recognition is for.
 */
async function describeExtractedPictures(input: {
	wanted: boolean;
	describeImages: DescribeImages | undefined;
	images: readonly { image: ExtractedImage; file: string }[];
	result: DocumentReadResult;
	documentName: string;
	/** @default DESCRIBE_LIMIT */
	limit?: number;
}): Promise<{ markdown?: string; note?: string }> {
	if (!input.wanted || input.images.length === 0) return {};
	if (!input.describeImages) {
		return {
			note: "Pictures were not described: no vision model is configured (the Vision tab of the API settings, or the CLI's --vision-model).",
		};
	}
	const scanned = new Set(
		(input.result.scannedPages ?? []).map((page) => `page ${page}`),
	);
	const candidates = input.images.filter(
		({ image }) =>
			VIEWABLE_MEDIA_TYPES.has(image.mediaType) &&
			!(image.source && scanned.has(image.source)) &&
			!(
				image.width &&
				image.height &&
				image.width < DESCRIBE_MIN_SIDE &&
				image.height < DESCRIBE_MIN_SIDE
			),
	);
	if (candidates.length === 0) return {};
	const limit = input.limit ?? DESCRIBE_LIMIT;
	const chosen = candidates.slice(0, limit);
	const descriptions = await describePictures(
		input.describeImages,
		chosen.map(({ image, file }) => ({
			link: image.link,
			mediaType: image.mediaType,
			data: () => fs.readFile(file),
			...(image.source ? { source: image.source } : {}),
		})),
		input.documentName,
	);
	let markdown = input.result.markdown;
	let described = 0;
	chosen.forEach(({ image }, index) => {
		const description = descriptions[index];
		if (!description) return;
		described++;
		image.description = description;
		const alt = altTextOf(description);
		markdown = markdown.replace(
			new RegExp(`!\\[[^\\]]*\\]\\(${escapeRegExp(image.link)}\\)`, "g"),
			() => `![${alt}](${image.link})`,
		);
	});
	const beyond =
		candidates.length > chosen.length
			? ` One call describes at most ${limit}; the rest have none.`
			: "";
	return {
		markdown,
		note: `${described} of ${candidates.length} picture(s) described by the vision model, in the index and the alt text.${beyond}`,
	};
}
