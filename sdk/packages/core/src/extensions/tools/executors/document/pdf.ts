/**
 * PDF through unpdf (pdf.js, serverless build: no canvas, no worker file).
 */

import type { getDocumentProxy } from "unpdf";
import type { DocumentReadResult, ReadOptions } from "./formats";
import { imageMarkdown } from "./images";

/**
 * A page with less visible text than this, and most of its area covered by
 * pictures, is an image of text.
 *
 * Not zero: a scan often carries a stamped page number or a header line in
 * real text (the probe's "Page 1" is 5 characters), and a threshold at zero
 * would read every stamped scan as a text page and return nothing.
 */
const SCANNED_TEXT_CHARS = 100;
/** Share of the page area pictures must cover for the page to be a scan. */
const SCANNED_COVERAGE = 0.5;
/**
 * Path operations past which an empty page is drawn rather than blank: text
 * converted to outlines, or a chart. Nothing here can read it, since reading
 * it would need the page rendered, and rendering needs a native canvas.
 */
const VECTOR_PATH_OPS = 200;
/** Images this small are rules, bullets and spacers. */
const MIN_IMAGE_SIDE = 4;

type Matrix = [number, number, number, number, number, number];

function multiply(a: Matrix, b: readonly number[]): Matrix {
	const [b0 = 1, b1 = 0, b2 = 0, b3 = 1, b4 = 0, b5 = 0] = b;
	return [
		a[0] * b0 + a[2] * b1,
		a[1] * b0 + a[3] * b1,
		a[0] * b2 + a[2] * b3,
		a[1] * b2 + a[3] * b3,
		a[0] * b4 + a[2] * b5 + a[4],
		a[1] * b4 + a[3] * b5 + a[5],
	];
}

interface PageShape {
	/** Share of the page covered by images, 0-1. */
	coverage: number;
	/** Whether text is drawn in render mode 3 (invisible): an OCR layer. */
	invisibleText: boolean;
	pathOps: number;
}

/**
 * What a page draws: how much of it is pictures, and whether it hides text.
 *
 * Read from the operator list rather than guessed from the text: a picture's
 * area on the page is its transform's determinant, since pdf.js paints every
 * image into the unit square.
 */
async function measurePage(
	page: Awaited<
		ReturnType<Awaited<ReturnType<typeof getDocumentProxy>>["getPage"]>
	>,
	ops: Record<string, number>,
): Promise<PageShape> {
	const [x0, y0, x1, y1] = page.view as [number, number, number, number];
	const pageArea = Math.abs((x1 - x0) * (y1 - y0)) || 1;
	const list = await page.getOperatorList();
	let ctm: Matrix = [1, 0, 0, 1, 0, 0];
	const stack: Matrix[] = [];
	let imageArea = 0;
	let invisibleText = false;
	let pathOps = 0;
	for (let i = 0; i < list.fnArray.length; i++) {
		const fn = list.fnArray[i];
		const args = list.argsArray[i] as unknown[];
		if (fn === ops.save) {
			stack.push(ctm);
		} else if (fn === ops.restore) {
			ctm = stack.pop() ?? ctm;
		} else if (fn === ops.transform) {
			ctm = multiply(ctm, args as number[]);
		} else if (fn === ops.setTextRenderingMode) {
			if (args[0] === 3) invisibleText = true;
		} else if (
			fn === ops.paintImageXObject ||
			fn === ops.paintInlineImageXObject ||
			fn === ops.paintImageXObjectRepeat ||
			fn === ops.paintImageMaskXObject
		) {
			imageArea += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
		} else if (fn === ops.constructPath) {
			pathOps++;
		}
	}
	return {
		coverage: Math.min(1, imageArea / pageArea),
		invisibleText,
		pathOps,
	};
}

/**
 * A text layer that decodes to nothing readable.
 *
 * A font with no Unicode mapping comes back as private-use code points or
 * replacement characters: text is there, and every character of it is wrong.
 */
function isGarbled(text: string): boolean {
	const letters = text.replace(/\s/g, "");
	if (letters.length < 20) return false;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are part of what a garbled layer is made of
	const bad = letters.match(/[\uE000-\uF8FF\uFFFD\u0000-\u0008]/g)?.length ?? 0;
	return bad / letters.length > 0.3;
}

function toPng(
	encodePng: typeof import("fast-png").encode,
	image: {
		data: Uint8ClampedArray;
		width: number;
		height: number;
		channels: 1 | 3 | 4;
	},
): Uint8Array {
	return encodePng({
		width: image.width,
		height: image.height,
		data: new Uint8Array(
			image.data.buffer,
			image.data.byteOffset,
			image.data.byteLength,
		),
		channels: image.channels,
		depth: 8,
	});
}

function passwordError(
	error: unknown,
	password: string | undefined,
): Error | undefined {
	const name = (error as { name?: string })?.name;
	const message = (error as { message?: string })?.message ?? "";
	if (name !== "PasswordException" && !/password/i.test(message)) {
		return undefined;
	}
	return new Error(
		password
			? "The PDF's password is not the one given in `password`."
			: "The PDF is password-protected. Ask the user for the password and call again with `password`.",
	);
}

export async function readPdf(
	data: Uint8Array,
	options: ReadOptions,
): Promise<DocumentReadResult> {
	// Loaded on first use: pdf.js is megabytes of code a session that never
	// reads a PDF should not pay for at startup.
	const { extractImages, getDocumentProxy, getMeta, getResolvedPDFJS } =
		await import("unpdf");
	const { encode: encodePng } = await import("fast-png");
	let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
	try {
		pdf = await getDocumentProxy(data, {
			...(options.password ? { password: options.password } : {}),
			// Font data is needed only to draw glyphs; text extraction reads the
			// mapping without it.
			disableFontFace: true,
		});
	} catch (error) {
		throw passwordError(error, options.password) ?? error;
	}
	const { OPS } = await getResolvedPDFJS();
	const ops = OPS as unknown as Record<string, number>;
	const meta = await getMeta(pdf).catch(() => undefined);
	const info = (meta?.info ?? {}) as Record<string, unknown>;

	const total = pdf.numPages;
	const read: number[] = [];
	const scannedPages: number[] = [];
	const ocrLayerPages: number[] = [];
	const vectorPages: number[] = [];
	const parts: string[] = [];

	for (let number = 1; number <= total; number++) {
		if (options.selects && !options.selects(number)) continue;
		read.push(number);
		const page = await pdf.getPage(number);
		const content = await page.getTextContent();
		let text = "";
		for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
			if (typeof item.str !== "string") continue;
			text += item.str;
			if (item.hasEOL) text += "\n";
		}
		text = text
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim();
		const shape = await measurePage(page, ops);
		const visibleChars = text.replace(/\s/g, "").length;
		const scanned = shape.coverage >= SCANNED_COVERAGE;
		if (scanned && shape.invisibleText && visibleChars > 0) {
			ocrLayerPages.push(number);
		} else if (
			scanned &&
			(visibleChars < SCANNED_TEXT_CHARS || isGarbled(text))
		) {
			scannedPages.push(number);
		} else if (
			visibleChars === 0 &&
			shape.coverage === 0 &&
			shape.pathOps >= VECTOR_PATH_OPS
		) {
			vectorPages.push(number);
		} else if (isGarbled(text)) {
			scannedPages.push(number);
		}

		const links: string[] = [];
		if (options.wantImages) {
			const images = await extractImages(pdf, number).catch(() => []);
			let n = 0;
			for (const image of images) {
				if (image.width < MIN_IMAGE_SIDE || image.height < MIN_IMAGE_SIDE)
					continue;
				n++;
				const added = options.images.add({
					data: toPng(encodePng, image),
					stem: `p${number}-${n}`,
					mediaType: "image/png",
					width: image.width,
					height: image.height,
					source: `page ${number}`,
				});
				if (added) links.push(imageMarkdown(added));
			}
		}
		parts.push(
			[`## Page ${number}`, text, ...links]
				.filter((part) => part.length > 0)
				.join("\n\n"),
		);
		page.cleanup();
	}
	// Ends the in-process worker and frees the parsed document.
	await pdf.loadingTask.destroy();

	return {
		markdown: parts.join("\n\n"),
		reader: "unpdf (pdf.js)",
		...(typeof info.Title === "string" && info.Title.trim()
			? { title: info.Title.trim() }
			: {}),
		...(typeof info.Author === "string" && info.Author.trim()
			? { author: info.Author.trim() }
			: {}),
		units: { name: "page", total, read },
		...(scannedPages.length ? { scannedPages } : {}),
		...(ocrLayerPages.length ? { ocrLayerPages } : {}),
		...(vectorPages.length ? { vectorPages } : {}),
	};
}
