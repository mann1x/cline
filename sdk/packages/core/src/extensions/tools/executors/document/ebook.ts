/// <reference path="./turndown-plugin-gfm.d.ts" />
/**
 * EPUB, MOBI, AZW3 (KF8) and FB2 through lingo-reader.
 *
 * lingo-reader returns each chapter as HTML and writes the book's resources
 * into a directory it is given, pointing every `<img src>` at the file it
 * wrote. The chapter HTML becomes markdown here, and each picture is taken
 * from that directory into the image collector before lingo-reader's own
 * `destroy()` deletes the directory.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import type TurndownService from "turndown";
import type {
	DocumentFormat,
	DocumentReadResult,
	ReadOptions,
} from "./formats";
import { type ExtractedImage, imageMarkdown } from "./images";

/** What every lingo-reader book answers, typed as loosely as they differ. */
interface LingoBook {
	getSpine(): { id: string }[];
	loadChapter(
		id: string,
	): Promise<{ html: string } | undefined> | { html: string } | undefined;
	getToc(): { label: string; children?: unknown[] }[];
	getMetadata(): Record<string, unknown>;
	destroy(): void;
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)$/i;

/**
 * Whether a Kindle file is DRM-protected.
 *
 * The PalmDOC header at the start of record 0 carries the encryption type at
 * offset 12: 0 is none, 1 the old Mobipocket scheme, 2 Mobipocket DRM.
 */
function kindleEncryption(data: Uint8Array): number {
	if (data.length < 90) return 0;
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const record0 = view.getUint32(78);
	if (record0 + 14 > data.length) return 0;
	return view.getUint16(record0 + 12);
}

/**
 * Whether an EPUB carries DRM rather than font obfuscation.
 *
 * `META-INF/encryption.xml` alone is not DRM: the IDPF font obfuscation
 * writes it too. Adobe ADEPT adds `rights.xml`, Readium LCP adds
 * `license.lcpl`. ZIP entry names are stored uncompressed, so a byte search
 * finds them without unpacking anything.
 */
function epubDrm(data: Uint8Array): boolean {
	const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	return (
		bytes.includes("META-INF/rights.xml") ||
		bytes.includes("META-INF/license.lcpl")
	);
}

function tocTitles(
	items: { label: string; children?: unknown[] }[],
	depth = 0,
	out: string[] = [],
): string[] {
	for (const item of items) {
		if (out.length >= 200) break;
		const label = String(item.label ?? "").trim();
		if (label) out.push(`${"  ".repeat(depth)}${label}`);
		if (Array.isArray(item.children)) {
			tocTitles(
				item.children as { label: string; children?: unknown[] }[],
				depth + 1,
				out,
			);
		}
	}
	return out;
}

function firstString(value: unknown): string | undefined {
	if (typeof value === "string") return value.trim() || undefined;
	if (Array.isArray(value)) {
		for (const entry of value) {
			const found = firstString(
				typeof entry === "object" && entry !== null
					? ((entry as Record<string, unknown>).contributor ??
							(entry as Record<string, unknown>).name)
					: entry,
			);
			if (found) return found;
		}
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		return firstString(record.contributor ?? record.name ?? record.value);
	}
	return undefined;
}

async function createTurndown(
	resolveImage: (src: string, alt: string) => string | undefined,
): Promise<TurndownService> {
	const { default: Turndown } = await import("turndown");
	const { gfm } = await import("@joplin/turndown-plugin-gfm");
	const service = new Turndown({
		headingStyle: "atx",
		codeBlockStyle: "fenced",
		bulletListMarker: "-",
	});
	// Tables, strikethrough and task lists as GitHub markdown: without it a
	// table comes out as its cells on separate lines, one after another.
	service.use(gfm);
	service.remove(["script", "style", "head"]);
	service.addRule("image", {
		filter: "img",
		replacement: (_content, node) => {
			const element = node as unknown as {
				getAttribute(name: string): string | null;
			};
			const src = element.getAttribute("src") ?? "";
			return resolveImage(src, element.getAttribute("alt") ?? "") ?? "";
		},
	});
	// SVG covers (`<svg><image xlink:href=...>`) are how calibre writes them.
	service.addRule("svgImage", {
		filter: (node) =>
			(node as unknown as { nodeName: string }).nodeName.toLowerCase() ===
			"image",
		replacement: (_content, node) => {
			const element = node as unknown as {
				getAttribute(name: string): string | null;
			};
			const src =
				element.getAttribute("xlink:href") ??
				element.getAttribute("href") ??
				"";
			return resolveImage(src, "") ?? "";
		},
	});
	return service;
}

export async function readEbook(
	filePath: string,
	data: Uint8Array,
	format: Extract<DocumentFormat, "epub" | "mobi" | "azw3" | "fb2">,
	options: ReadOptions,
): Promise<DocumentReadResult> {
	if ((format === "mobi" || format === "azw3") && kindleEncryption(data) > 1) {
		throw new Error(
			"This Kindle book is DRM-protected. It can be read only in a Kindle app; nothing here can remove the protection.",
		);
	}
	if (format === "epub" && epubDrm(data)) {
		throw new Error(
			"This EPUB is DRM-protected (Adobe ADEPT or Readium LCP). It can be read only in a reader app licensed for it.",
		);
	}

	const resources = options.scratchDir;
	// Loaded on first use, like every reader here.
	const { initEpubFile } = await import("@lingo-reader/epub-parser");
	const { initFb2File } = await import("@lingo-reader/fb2-parser");
	const { initKf8File, initMobiFile } = await import(
		"@lingo-reader/mobi-parser"
	);
	let book: LingoBook;
	let reader: string;
	if (format === "epub") {
		book = (await initEpubFile(filePath, resources)) as unknown as LingoBook;
		reader = "lingo-reader (EPUB)";
	} else if (format === "fb2") {
		book = (await initFb2File(filePath, resources)) as unknown as LingoBook;
		reader = "lingo-reader (FB2)";
	} else {
		// A `.mobi` from calibre carries both a MOBI 6 and a KF8 book, and an
		// `.azw` can be either, so the other reader is the fallback.
		const [first, second] =
			format === "azw3"
				? [initKf8File, initMobiFile]
				: [initMobiFile, initKf8File];
		try {
			book = (await first(filePath, resources)) as unknown as LingoBook;
			reader = `lingo-reader (${first === initKf8File ? "KF8" : "MOBI"})`;
		} catch {
			book = (await second(filePath, resources)) as unknown as LingoBook;
			reader = `lingo-reader (${second === initKf8File ? "KF8" : "MOBI"})`;
		}
	}

	try {
		const byPath = new Map<string, ExtractedImage | undefined>();
		let chapterNumber = 0;
		const takeImage = (src: string, alt: string): string | undefined => {
			if (!options.wantImages || !src || /^(data:|https?:)/i.test(src))
				return undefined;
			let file = src;
			try {
				file = decodeURI(src.replace(/^file:\/\//, ""));
			} catch {}
			if (!path.isAbsolute(file) || !existsSync(file)) return undefined;
			if (!byPath.has(file)) {
				byPath.set(
					file,
					options.images.add({
						data: readFileSync(file),
						stem: path.basename(file),
						source: `chapter ${chapterNumber}`,
						...(alt ? { alt } : {}),
					}),
				);
			}
			const image = byPath.get(file);
			return image ? imageMarkdown(image) : undefined;
		};
		const turndown = await createTurndown(takeImage);

		const spine = book.getSpine();
		const read: number[] = [];
		const parts: string[] = [];
		for (let index = 0; index < spine.length; index++) {
			const number = index + 1;
			if (options.selects && !options.selects(number)) continue;
			chapterNumber = number;
			read.push(number);
			const chapter = await book.loadChapter(
				(spine[index] as { id: string }).id,
			);
			const html = chapter?.html ?? "";
			const markdown = html ? turndown.turndown(html).trim() : "";
			if (markdown) parts.push(markdown);
		}

		// Pictures no chapter links to: a cover the spine skips, a picture only a
		// stylesheet uses. Still the book's pictures.
		if (options.wantImages && existsSync(resources)) {
			for (const name of readdirSync(resources, {
				recursive: true,
			}) as string[]) {
				const file = path.join(resources, name);
				if (
					!IMAGE_FILE.test(name) ||
					byPath.has(file) ||
					!statSync(file).isFile()
				)
					continue;
				byPath.set(
					file,
					options.images.add({
						data: readFileSync(file),
						stem: path.basename(name),
					}),
				);
			}
		}

		const metadata = book.getMetadata() ?? {};
		const title = firstString(metadata.title);
		const author = firstString(metadata.creator ?? metadata.author);
		const contents = tocTitles(book.getToc() ?? []);
		return {
			markdown: parts.join("\n\n"),
			reader,
			...(title && title !== "Unknown" ? { title } : {}),
			...(author && author !== "Unknown" ? { author } : {}),
			units: { name: "chapter", total: spine.length, read },
			...(contents.length ? { contents } : {}),
		};
	} finally {
		book.destroy();
	}
}
