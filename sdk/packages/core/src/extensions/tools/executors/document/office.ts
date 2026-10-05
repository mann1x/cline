/**
 * OOXML, OpenDocument, RTF, CSV and HTML through officeparser.
 *
 * officeparser parses to a tree and renders the tree to markdown. Its
 * markdown carries every picture as a base64 data URI, which in a tool result
 * is the picture's bytes spelled out as text, so the renderer's `onNode` hook
 * replaces each one with a link to the file it was written to.
 */

import type * as OfficeParserModule from "officeparser";
import type { OfficeContentNode, OfficeParserAST } from "officeparser";
import type {
	DocumentFormat,
	DocumentReadResult,
	ReadOptions,
	UnitName,
} from "./formats";
import { type ExtractedImage, imageMarkdown } from "./images";

/**
 * Past these, a ZIP-backed document is refused as a decompression bomb.
 * officeparser's own defaults (512 MB, 10,000 entries) are for a server; an
 * editor extension holding the result in memory wants less.
 */
const DECOMPRESSION_LIMITS = {
	maxUncompressedBytes: 256 * 1024 * 1024,
	maxZipEntries: 20_000,
};

const UNIT_OF: Partial<
	Record<DocumentFormat, { node: string; unit: UnitName }>
> = {
	pptx: { node: "slide", unit: "slide" },
	odp: { node: "slide", unit: "slide" },
	xlsx: { node: "sheet", unit: "sheet" },
	ods: { node: "sheet", unit: "sheet" },
};

/**
 * The parser, under whichever runtime loaded the package.
 *
 * officeparser's ESM entry default-imports its own CommonJS build and
 * destructures the named exports from it. Node hands that import the whole
 * `module.exports`; Bun, seeing `__esModule`, hands it `exports.default`,
 * which is the `OfficeParser` class, and every named export comes out
 * undefined. The class itself is the default either way, and its static
 * `parseOffice` is all this needs: the tree it returns renders itself.
 */
async function loadOfficeParser(): Promise<
	typeof OfficeParserModule.OfficeParser
> {
	// Loaded on first use: officeparser brings pdf.js and tesseract.js with it.
	const officeparser = await import("officeparser");
	return (officeparser.OfficeParser ??
		(
			officeparser as unknown as {
				default?: typeof OfficeParserModule.OfficeParser;
			}
		).default) as typeof OfficeParserModule.OfficeParser;
}

function passwordError(
	error: unknown,
	password: string | undefined,
): Error | undefined {
	const message = (error as { message?: string })?.message ?? "";
	if (!/password|encrypt/i.test(message)) return undefined;
	return new Error(
		password
			? "The document's password is not the one given in `password`."
			: "The document is password-protected. Ask the user for the password and call again with `password`.",
	);
}

function stripFrontMatter(markdown: string): string {
	return markdown.replace(/^\s*---\n[\s\S]*?\n---\n/, "").trim();
}

export async function readOffice(
	data: Uint8Array,
	format: DocumentFormat,
	options: ReadOptions,
): Promise<DocumentReadResult> {
	const OfficeParser = await loadOfficeParser();
	let ast: OfficeParserAST;
	try {
		ast = await OfficeParser.parseOffice(Buffer.from(data), {
			// The format is already decided, from the bytes and the name. Left
			// to officeparser it is guessed again with `file-type`, which does
			// not load from a bundle: RTF, CSV and HTML, which have no ZIP
			// signature to fall back on, then fail as "auto-detection failed".
			fileType: format as never,
			extractAttachments: options.wantImages,
			decompressionLimits: DECOMPRESSION_LIMITS,
			...(options.password ? { password: options.password } : {}),
		});
	} catch (error) {
		throw passwordError(error, options.password) ?? error;
	}

	// Slides and sheets are the top-level nodes of a deck or a workbook, so a
	// range selects among them; every other format is one flow of text.
	const unitOf = UNIT_OF[format];
	let units: DocumentReadResult["units"];
	if (unitOf) {
		const all = ast.content.filter((node) => node.type === unitOf.node);
		const read: number[] = [];
		const kept = new Set<OfficeContentNode>();
		all.forEach((node, index) => {
			if (!options.selects || options.selects(index + 1)) {
				read.push(index + 1);
				kept.add(node);
			}
		});
		ast.content = ast.content.filter(
			(node) => node.type !== unitOf.node || kept.has(node),
		);
		units = { name: unitOf.unit, total: all.length, read };
	}

	// Each attachment becomes a file once, by name, so a picture that appears
	// on ten slides is one file linked ten times.
	const written = new Map<string, ExtractedImage | undefined>();
	const fileFor = (name: string, alt?: string): ExtractedImage | undefined => {
		if (written.has(name)) return written.get(name);
		const attachment = ast.attachments?.find((entry) => entry.name === name);
		const image = attachment
			? options.images.add({
					data: Buffer.from(attachment.data, "base64"),
					stem: name,
					mediaType: attachment.mimeType,
					...(alt ? { alt } : {}),
				})
			: undefined;
		written.set(name, image);
		return image;
	};

	const result = await ast.to(
		"md" as never,
		{
			// GitHub markdown, and HTML only where markdown cannot carry the
			// content: a merged-cell table. Alignment, underline and anchor tags are
			// presentation, and in a tool result they are tokens that say nothing
			// (measured on the calibre guide: `<div style="text-align: center">`
			// around every heading, `<u>` around every link).
			mdConfig: {
				dialect: "github",
				fallbackToHtml: {
					textFormatting: false,
					alignment: false,
					anchors: false,
					tables: true,
					embeds: false,
					cellLineBreaks: true,
				},
			},
			onNode: (node: OfficeContentNode) => {
				if (node.type !== "image") return undefined;
				if (!options.wantImages) return false;
				const meta = (node.metadata ?? {}) as {
					attachmentName?: string;
					altText?: string;
				};
				const image = meta.attachmentName
					? fileFor(meta.attachmentName, meta.altText)
					: undefined;
				return image ? imageMarkdown(image) : false;
			},
		} as never,
	);
	let markdown = stripFrontMatter(
		String((result as { value?: unknown }).value ?? ""),
	);
	if (format === "rtf") {
		// RTF paragraphs keep their `\tab` indent as leading whitespace, and
		// four columns of it is a code block to a markdown reader: every
		// paragraph of the calibre guide came out as one. List items keep theirs.
		markdown = markdown.replace(/^[ ]*\t[ \t]*(?![-*+] |\d+[.)] )/gm, "");
	}

	// Charts and pictures no content node points at (a slide background, a
	// picture only a chart refers to) are still the document's pictures.
	if (options.wantImages) {
		for (const attachment of ast.attachments ?? []) {
			if (attachment.type === "image") fileFor(attachment.name);
		}
	}

	const metadata = ast.metadata ?? {};
	return {
		markdown,
		reader: "officeparser",
		...(metadata.title?.trim() ? { title: metadata.title.trim() } : {}),
		...(metadata.author?.trim() ? { author: metadata.author.trim() } : {}),
		...(units ? { units } : {}),
	};
}
