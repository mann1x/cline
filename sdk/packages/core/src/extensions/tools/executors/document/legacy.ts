/**
 * Word, Excel and PowerPoint 97-2003 through office_oxide.
 *
 * office_oxide renders markdown with each picture inline as
 * `[image-base64:<data>]` at its place in the text; each becomes a file and a
 * link. Its Word reader misses some pictures (measured: POI's PngPicture.doc,
 * one PNG), so a Word file's streams are also scanned for complete PNG and
 * JPEG images, and any not already found are listed after the text.
 *
 * Word only. Excel splits a record longer than 8,224 bytes with a 4-byte
 * CONTINUE header, so a picture in a workbook stream is not contiguous there:
 * a byte scan of POI's SimpleWithImages.xls "found" a JPEG 4 bytes longer than
 * the real one, damaged from byte 8,108 on, beside the one office_oxide read
 * correctly. PowerPoint keeps its pictures in one flat stream, which
 * office_oxide reads whole.
 */

import type * as CFB from "cfb";
import type { DocumentReadResult, ReadOptions } from "./formats";
import { imageMarkdown } from "./images";
import { openOfficeOxide } from "./office-oxide";

const INLINE_IMAGE = /\[image-base64:([A-Za-z0-9+/=\s]+)\]/g;

/**
 * Control characters Word leaves in the text stream: 0x05 marks where a
 * comment is anchored, 0x01 and 0x08 where a picture or drawing was, 0x13-0x15
 * delimit field codes. office_oxide passes some of them through.
 */
function stripWordControls(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: these control characters are what is being removed
	return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** A PNG's length, walked chunk by chunk to its IEND. */
function pngLength(data: Uint8Array, start: number): number | undefined {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	let offset = start + 8;
	while (offset + 12 <= data.length) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(...data.subarray(offset + 4, offset + 8));
		offset += 12 + length;
		if (type === "IEND") return offset - start;
		if (length > data.length) return undefined;
	}
	return undefined;
}

/** A JPEG's length, walked segment by segment to its EOI. */
function jpegLength(data: Uint8Array, start: number): number | undefined {
	let offset = start + 2;
	while (offset + 4 <= data.length) {
		if (data[offset] !== 0xff) return undefined;
		const marker = data[offset + 1] as number;
		if (marker === 0xd9) return offset + 2 - start;
		if (marker === 0xda) {
			// Entropy-coded data runs to the next marker that is not a stuffed
			// 0xFF00 or a restart marker.
			offset +=
				2 +
				(((data[offset + 2] as number) << 8) | (data[offset + 3] as number));
			while (offset + 1 < data.length) {
				if (data[offset] === 0xff) {
					const next = data[offset + 1] as number;
					if (next === 0xd9) return offset + 2 - start;
					if (next !== 0x00 && (next < 0xd0 || next > 0xd7)) break;
				}
				offset++;
			}
			continue;
		}
		offset +=
			2 + (((data[offset + 2] as number) << 8) | (data[offset + 3] as number));
	}
	return undefined;
}

/** Complete PNG and JPEG images inside a compound file's streams. */
export async function scanCompoundImages(
	data: Uint8Array,
): Promise<Uint8Array[]> {
	// CommonJS: its functions are on the default export under Node's ESM
	// loader, and on the namespace under a bundler.
	const loaded = await import("cfb");
	const cfb = ((loaded as unknown as { default?: typeof CFB }).default ??
		loaded) as typeof CFB;
	let container: CFB.CFB$Container;
	try {
		container = cfb.read(Buffer.from(data), { type: "buffer" });
	} catch {
		return [];
	}
	const found: Uint8Array[] = [];
	for (const entry of container.FileIndex) {
		const content = entry.content as Uint8Array | undefined;
		if (entry.type !== 2 || !content || content.length < 64) continue;
		const bytes =
			content instanceof Uint8Array ? content : new Uint8Array(content);
		for (let i = 0; i + 8 < bytes.length; i++) {
			let length: number | undefined;
			if (
				bytes[i] === 0x89 &&
				bytes[i + 1] === 0x50 &&
				bytes[i + 2] === 0x4e &&
				bytes[i + 3] === 0x47
			) {
				length = pngLength(bytes, i);
			} else if (
				bytes[i] === 0xff &&
				bytes[i + 1] === 0xd8 &&
				bytes[i + 2] === 0xff
			) {
				length = jpegLength(bytes, i);
			}
			if (length && length > 64 && i + length <= bytes.length) {
				found.push(bytes.slice(i, i + length));
				i += length - 1;
			}
		}
	}
	return found;
}

export async function readLegacyOffice(
	data: Uint8Array,
	format: "doc" | "xls" | "ppt",
	options: ReadOptions,
): Promise<DocumentReadResult> {
	const document = openOfficeOxide(data, format);
	let markdown: string;
	try {
		markdown = document.toMarkdownWithImages();
	} finally {
		document.free();
	}

	let n = 0;
	markdown = markdown.replace(INLINE_IMAGE, (_match, base64: string) => {
		if (!options.wantImages) return "";
		n++;
		const image = options.images.add({
			data: Buffer.from(base64.replace(/\s/g, ""), "base64"),
			stem: `${format}-image-${n}`,
		});
		return image ? imageMarkdown(image) : "";
	});
	markdown = stripWordControls(markdown)
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	const notes: string[] = [];
	if (options.wantImages && format === "doc") {
		const missed: string[] = [];
		for (const bytes of await scanCompoundImages(data)) {
			const known = options.images.images.length;
			n++;
			const image = options.images.add({
				data: bytes,
				stem: `${format}-image-${n}`,
			});
			if (image && options.images.images.length > known)
				missed.push(imageMarkdown(image));
		}
		if (missed.length) {
			markdown += `\n\n## Pictures not placed in the text\n\n${missed.join("\n\n")}`;
			notes.push(
				`${missed.length} picture(s) were found in the file but not at a place in its text; they are listed at the end.`,
			);
		}
	}

	return {
		markdown,
		reader: "office_oxide",
		...(notes.length ? { notes } : {}),
	};
}
