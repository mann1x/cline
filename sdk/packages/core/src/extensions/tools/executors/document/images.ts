/**
 * Where a document's pictures go.
 *
 * Every reader hands its pictures here as bytes, whatever form it found them
 * in (base64 in officeparser's tree and office_oxide's markdown, raw pixels
 * from pdf.js, files lingo-reader wrote), so the naming, deduplication and the
 * index are the same for every format.
 */

import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";

export interface ExtractedImage {
	/** File name inside the images directory. */
	file: string;
	/** Path relative to the extraction directory, for markdown links. */
	link: string;
	mediaType: string;
	bytes: number;
	width?: number;
	height?: number;
	/** Where in the document it came from: `page 7`, `slide 3`, `chapter 2`. */
	source?: string;
	/** The document's own alt text or caption, when it carries one. */
	alt?: string;
	/**
	 * Set for a format no model can view (EMF, WMF, PICT, TIFF, BMP): the file is
	 * kept, but it is not a picture anyone downstream can look at as it is.
	 */
	notViewable?: boolean;
	sha1: string;
}

/** The formats a vision model is sent, which is what `inline` can attach. */
export const VIEWABLE_MEDIA_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

const EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/tiff": "tif",
	"image/svg+xml": "svg",
	"image/emf": "emf",
	"image/wmf": "wmf",
	"image/x-pict": "pict",
};

/**
 * The media type of an image, from its first bytes.
 *
 * The containers are not trusted for this: officeparser labels by extension,
 * office_oxide by record type, and an EMF inside a `.png`-named part is
 * common enough in real decks.
 */
export function sniffImageType(data: Uint8Array): string | undefined {
	const at = (offset: number, ...bytes: number[]) =>
		bytes.every((byte, i) => data[offset + i] === byte);
	if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
	if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) {
		return "image/webp";
	}
	if (at(0, 0x42, 0x4d)) return "image/bmp";
	if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) {
		return "image/tiff";
	}
	if (at(40, 0x20, 0x45, 0x4d, 0x46)) return "image/emf";
	if (at(0, 0xd7, 0xcd, 0xc6, 0x9a) || at(0, 0x01, 0x00, 0x09, 0x00)) {
		return "image/wmf";
	}
	// Mac PICT as Office stores it: no 512-byte file header, so the size and
	// frame come first and the version-2 opcode sits at offset 10.
	if (at(10, 0x00, 0x11, 0x02, 0xff)) return "image/x-pict";
	const head = Buffer.from(data.subarray(0, 256)).toString("utf8").trimStart();
	if (
		head.startsWith("<svg") ||
		(head.startsWith("<?xml") && head.includes("<svg"))
	) {
		return "image/svg+xml";
	}
	return undefined;
}

/**
 * Undo the deflate a metafile BLIP is stored under.
 *
 * Office keeps EMF and WMF pictures zlib-compressed inside `.doc`, `.xls`
 * and `.ppt` (measured: 3 of 5 pictures in POI's pictures.ppt), and
 * office_oxide hands them over as stored. Inflated, they sniff as what they
 * are; left compressed they are anonymous bytes.
 */
function inflateIfCompressed(data: Uint8Array): Uint8Array {
	if (data[0] !== 0x78 || ![0x01, 0x5e, 0x9c, 0xda].includes(data[1] ?? 0)) {
		return data;
	}
	try {
		return new Uint8Array(inflateSync(data));
	} catch {
		return data;
	}
}

export interface AddImageInput {
	data: Uint8Array;
	/** A name to build the file name from, such as `p7` or the part's own name. */
	stem: string;
	mediaType?: string;
	width?: number;
	height?: number;
	source?: string;
	alt?: string;
}

/**
 * Collects a document's images, named and deduplicated, for writing.
 *
 * Deduplicated by content: a logo on every slide of a deck is one file, and
 * every place it appears links to that one file.
 */
export class ImageCollector {
	private readonly byHash = new Map<string, ExtractedImage>();
	private readonly names = new Set<string>();
	private readonly pending: { image: ExtractedImage; data: Uint8Array }[] = [];

	constructor(private readonly linkDir = "images") {}

	add(input: AddImageInput): ExtractedImage | undefined {
		if (input.data.byteLength === 0) {
			return undefined;
		}
		const data = inflateIfCompressed(input.data);
		const sha1 = createHash("sha1").update(data).digest("hex");
		const seen = this.byHash.get(sha1);
		if (seen) {
			return seen;
		}
		const mediaType =
			sniffImageType(data) ?? input.mediaType ?? "application/octet-stream";
		const extension = EXTENSIONS[mediaType] ?? "bin";
		const file = this.uniqueName(safeStem(input.stem), extension);
		const image: ExtractedImage = {
			file,
			link: `${this.linkDir}/${file}`,
			mediaType,
			bytes: data.byteLength,
			...(input.width ? { width: input.width } : {}),
			...(input.height ? { height: input.height } : {}),
			...(input.source ? { source: input.source } : {}),
			...(input.alt?.trim() ? { alt: input.alt.trim() } : {}),
			...(VIEWABLE_MEDIA_TYPES.has(mediaType) || mediaType === "image/svg+xml"
				? {}
				: { notViewable: true }),
			sha1,
		};
		this.byHash.set(sha1, image);
		this.pending.push({ image, data });
		return image;
	}

	get images(): readonly ExtractedImage[] {
		return this.pending.map((entry) => entry.image);
	}

	/** Every image with its bytes, in the order they were found. */
	entries(): readonly { image: ExtractedImage; data: Uint8Array }[] {
		return this.pending;
	}

	private uniqueName(stem: string, extension: string): string {
		let name = `${stem}.${extension}`;
		for (let n = 2; this.names.has(name); n++) {
			name = `${stem}-${n}.${extension}`;
		}
		this.names.add(name);
		return name;
	}
}

function safeStem(stem: string): string {
	const cleaned = stem
		.replace(/\.[a-z0-9]{2,4}$/i, "")
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
	return cleaned || "image";
}

/** Markdown for an image: its alt text when the document gave one. */
export function imageMarkdown(image: ExtractedImage): string {
	const alt = (image.alt ?? "").replace(/[[\]\n]/g, " ").trim();
	return `![${alt}](${image.link})`;
}
