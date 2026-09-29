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
import { readEbook } from "./document/ebook";
import {
	type DocumentFormat,
	type DocumentReadResult,
	detectFormat,
	FORMAT_LABELS,
	type ReadOptions,
} from "./document/formats";
import {
	type ExtractedImage,
	ImageCollector,
	VIEWABLE_MEDIA_TYPES,
} from "./document/images";
import { readLegacyOffice } from "./document/legacy";
import { readOffice } from "./document/office";
import { readPdf } from "./document/pdf";
import { formatUnits, parseUnitRange } from "./document/range";

/** Where extractions go when the call names no `output_dir`. */
export const DEFAULT_EXTRACTION_DIR = path.join(".cline", "extracted");

export interface DocumentExtractExecutorOptions {
	/** The workspace; relative paths resolve against it and output stays in it. */
	cwd?: string;
	/** A delegated agent's overlay: reads fall through, writes stay private. */
	overlay?: AgentOverlay;
	/** @default 200 MB */
	maxFileSizeBytes?: number;
}

const DEFAULT_MAX_FILE_BYTES = 200 * 1024 * 1024;
/** How many pictures `images: "inline"` attaches, and how large each may be. */
const INLINE_IMAGE_LIMIT = 4;
const INLINE_IMAGE_BYTES = 1_500_000;
/** Pictures smaller than this on both sides are not worth a look. */
const INLINE_MIN_SIDE = 32;

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

async function read(
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

export function createDocumentExtractExecutor(
	options: DocumentExtractExecutorOptions = {},
): ExtractDocumentExecutor {
	const { overlay } = options;
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
		const data = new Uint8Array(await fs.readFile(sourcePath));
		const verdict = detectFormat(requested, data.subarray(0, 512));
		if ("unsupported" in verdict) {
			throw new Error(verdict.unsupported);
		}
		const { format } = verdict;
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
		await fs.mkdir(scratchDir, { recursive: true });

		const wantImages = input.images !== "none";
		const images = new ImageCollector("images");
		let result: DocumentReadResult;
		try {
			result = await read(sourcePath, data, format, {
				images,
				wantImages,
				...(input.password ? { password: input.password } : {}),
				...(range ? { selects: range.selects } : {}),
				scratchDir,
			});
		} finally {
			await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
		}

		const suffix = range ? `.${range.spec.replace(/[^0-9,-]/g, "")}` : "";
		const asText = input.format === "text";
		const markdown = tidyMarkdown(result.markdown);
		const body = asText ? markdownToText(markdown) : markdown;
		const documentFile = path.join(
			outputDir,
			`${stemOf(requested)}${suffix}.${asText ? "txt" : "md"}`,
		);
		await writeFile(documentFile, `${body}\n`);
		for (const { image, data: bytes } of images.entries()) {
			await writeFile(path.join(outputDir, "images", image.file), bytes);
		}
		const indexFile = path.join(outputDir, "images", `index${suffix}.json`);
		if (images.images.length > 0) {
			await writeFile(
				indexFile,
				`${JSON.stringify(
					{
						document: shown(cwd, requested),
						images: images.images.map(({ sha1: _sha1, ...image }) => image),
					},
					null,
					2,
				)}\n`,
			);
		}

		const header = describe({
			cwd,
			requested,
			bytes: stat.size,
			format,
			result,
			images: images.images,
			documentFile,
			indexFile,
			outputDir,
			range: range?.spec,
			bodyChars: body.length,
			wantImages,
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

		if (input.images !== "inline" || images.images.length === 0) {
			return text;
		}
		if (context.metadata?.modelSupportsImages !== true) {
			return `${text}\n\n[images: "inline" attaches nothing here: this model does not take image input. The pictures are the files listed above.]`;
		}
		const attached: (TextContent | ImageContent)[] = [{ type: "text", text }];
		for (const { image, data: bytes } of images.entries()) {
			if (attached.length > INLINE_IMAGE_LIMIT) break;
			if (
				!VIEWABLE_MEDIA_TYPES.has(image.mediaType) ||
				bytes.byteLength > INLINE_IMAGE_BYTES
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
				data: Buffer.from(bytes).toString("base64"),
				mediaType: image.mediaType,
			});
		}
		return attached;
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
	if (result.scannedPages?.length) {
		lines.push(
			`Scanned pages ${formatUnits(result.scannedPages)}: an image of text with no text layer, so their words are not in this text. ${input.wantImages ? "Their page images are in the images folder; " : 'Call again without images: "none" to get their page images; '}text recognition (OCR) is not available yet.`,
		);
	}
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
