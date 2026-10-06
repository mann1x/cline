/**
 * PDF through pdf.js (`pdfjs-dist`, legacy build, in this thread: no canvas,
 * no worker file). See `pdfjs.ts` for why not unpdf.
 */

import type {
	PDFDocumentProxy,
	PDFPageProxy,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import type { DocumentReadResult, PageImage, ReadOptions } from "./formats";
import { imageMarkdown } from "./images";
import { loadPdfjs, pdfjsDocumentOptions } from "./pdfjs";

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
/**
 * A picture covering less of a scanned page than this is a logo or a stamp,
 * not the page: recognizing it adds noise and costs a second pass.
 */
const OCR_MIN_COVERAGE = 0.1;

/** pdf.js's `ImageKind`: how an image's pixels are laid out. */
const GRAYSCALE_1BPP = 1;
const RGB_24BPP = 2;
const RGBA_32BPP = 3;

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

/** Pixels as pdf.js decodes them. */
interface DecodedImage {
	width: number;
	height: number;
	/** An `ImageKind`; image masks are 1 bit per pixel, like GRAYSCALE_1BPP. */
	kind?: number;
	data?: Uint8Array | Uint8ClampedArray;
}

/** An image the page paints: by name in the page's objects, or inline. */
type ImageDraw =
	| { key: string; area: number }
	| { image: DecodedImage; mask: boolean; area: number };

interface PageShape {
	/** Share of the page covered by images, 0-1. */
	coverage: number;
	/** Whether text is drawn in render mode 3 (invisible): an OCR layer. */
	invisibleText: boolean;
	pathOps: number;
	pageArea: number;
	draws: ImageDraw[];
}

/**
 * What a page draws: how much of it is pictures, which pictures, and whether
 * it hides text.
 *
 * Read from the operator list rather than guessed from the text: a picture's
 * area on the page is its transform's determinant, since pdf.js paints every
 * image into the unit square.
 */
async function measurePage(
	page: PDFPageProxy,
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
	const draws: ImageDraw[] = [];
	for (let i = 0; i < list.fnArray.length; i++) {
		const fn = list.fnArray[i];
		const args = list.argsArray[i] as unknown[];
		const area = () => Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
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
			fn === ops.paintImageXObjectRepeat
		) {
			imageArea += area();
			if (typeof args[0] === "string") {
				draws.push({ key: args[0], area: area() / pageArea });
			}
		} else if (fn === ops.paintInlineImageXObject) {
			imageArea += area();
			draws.push({
				image: args[0] as DecodedImage,
				mask: false,
				area: area() / pageArea,
			});
		} else if (fn === ops.paintImageMaskXObject) {
			imageArea += area();
			draws.push({
				image: args[0] as DecodedImage,
				mask: true,
				area: area() / pageArea,
			});
		} else if (fn === ops.constructPath) {
			pathOps++;
		}
	}
	return {
		coverage: Math.min(1, imageArea / pageArea),
		invisibleText,
		pathOps,
		pageArea,
		draws,
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
	const bad = letters.match(/[-�\u0000-\u0008]/g)?.length ?? 0;
	return bad / letters.length > 0.3;
}

/** How long one picture may take to decode before it is left out. */
const IMAGE_DECODE_LIMIT_MS = 60_000;

function objectOf(
	page: PDFPageProxy,
	key: string,
): Promise<DecodedImage | null | "no answer"> {
	const objects = key.startsWith("g_") ? page.commonObjs : page.objs;
	return new Promise((resolve) => {
		// pdf.js calls back when the picture is decoded, and never when its
		// decoder failed: without a limit one such picture holds the whole read.
		const timer = setTimeout(() => resolve("no answer"), IMAGE_DECODE_LIMIT_MS);
		const done = (value: DecodedImage | null) => {
			clearTimeout(timer);
			resolve(value);
		};
		try {
			objects.get(key, (value: unknown) =>
				done((value as DecodedImage) ?? null),
			);
		} catch {
			done(null);
		}
	});
}

/**
 * An image's pixels as a PNG, or undefined for a layout this cannot write.
 *
 * One bit per pixel (a bilevel scan, or a stencil mask) is widened to 8-bit
 * gray. pdf.js packs both with 1 for paper and 0 for ink, each row padded to a
 * byte.
 */
function toPng(
	encodePng: typeof import("fast-png").encode,
	image: DecodedImage,
	mask: boolean,
): Uint8Array | undefined {
	const { width, height, data } = image;
	if (!data || !width || !height) return undefined;
	const bilevel = mask || image.kind === GRAYSCALE_1BPP;
	if (bilevel) {
		const row = (width + 7) >> 3;
		if (data.length < row * height) return undefined;
		const gray = new Uint8Array(width * height);
		for (let y = 0; y < height; y++) {
			const offset = y * row;
			for (let x = 0; x < width; x++) {
				gray[y * width + x] =
					((data[offset + (x >> 3)] ?? 0) >> (7 - (x & 7))) & 1 ? 255 : 0;
			}
		}
		return encodePng({ width, height, data: gray, channels: 1, depth: 8 });
	}
	const channels =
		image.kind === RGB_24BPP
			? 3
			: image.kind === RGBA_32BPP
				? 4
				: data.length / (width * height);
	if (channels !== 1 && channels !== 3 && channels !== 4) return undefined;
	return encodePng({
		width,
		height,
		data: new Uint8Array(
			data.buffer,
			data.byteOffset,
			width * height * channels,
		),
		channels,
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
	const pdfjs = await loadPdfjs();
	const { encode: encodePng } = await import("fast-png");
	const task = pdfjs.getDocument({
		...pdfjsDocumentOptions(),
		// A copy: pdf.js takes ownership of what it is given.
		data: data.slice(),
		...(options.password ? { password: options.password } : {}),
	});
	let pdf: PDFDocumentProxy;
	try {
		pdf = await task.promise;
	} catch (error) {
		await task.destroy().catch(() => {});
		throw passwordError(error, options.password) ?? error;
	}
	try {
		return await readPages(
			pdf,
			pdfjs.OPS as unknown as Record<string, number>,
			encodePng,
			options,
		);
	} finally {
		// Ends the in-thread worker and frees the parsed document.
		await task.destroy().catch(() => {});
	}
}

async function readPages(
	pdf: PDFDocumentProxy,
	ops: Record<string, number>,
	encodePng: typeof import("fast-png").encode,
	options: ReadOptions,
): Promise<DocumentReadResult> {
	const meta = await pdf.getMetadata().catch(() => undefined);
	const info = (meta?.info ?? {}) as Record<string, unknown>;

	const total = pdf.numPages;
	const read: number[] = [];
	const scannedPages: number[] = [];
	const recognizedPages: number[] = [];
	const ocrLayerPages: number[] = [];
	const vectorPages: number[] = [];
	const parts: string[] = [];

	let taken = 0;
	const progress = (at: number, activity?: string) =>
		options.onProgress?.({
			unit: "page",
			at,
			total,
			pictures: taken,
			...(activity ? { activity } : {}),
		});

	for (let number = 1; number <= total; number++) {
		if (options.selects && !options.selects(number)) continue;
		options.signal?.throwIfAborted();
		progress(number);
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
		const covered = shape.coverage >= SCANNED_COVERAGE;
		let scanned = false;
		if (covered && shape.invisibleText && visibleChars > 0) {
			ocrLayerPages.push(number);
		} else if (
			covered &&
			(visibleChars < SCANNED_TEXT_CHARS || isGarbled(text))
		) {
			scanned = true;
		} else if (
			visibleChars === 0 &&
			shape.coverage === 0 &&
			shape.pathOps >= VECTOR_PATH_OPS
		) {
			vectorPages.push(number);
		} else if (isGarbled(text)) {
			scanned = true;
		}
		if (scanned) scannedPages.push(number);

		// Decoded once, for the images folder and for recognition both.
		const wantPixels = options.wantImages || (scanned && !!options.recognize);
		const pictures: (PageImage & { stem: string })[] = [];
		if (wantPixels) {
			let n = 0;
			for (const draw of shape.draws) {
				const decoded =
					"key" in draw ? await objectOf(page, draw.key) : draw.image;
				if (decoded === "no answer") {
					options.problems?.push(
						`page ${number}: a picture was left out, the PDF decoder gave no answer for it in ${IMAGE_DECODE_LIMIT_MS / 1000}s`,
					);
					continue;
				}
				if (!decoded) {
					options.problems?.push(
						`page ${number}: a picture was left out, the PDF decoder could not decode it`,
					);
					continue;
				}
				// Rules, bullets and icons: not pictures of the book.
				if (decoded.width < MIN_IMAGE_SIDE || decoded.height < MIN_IMAGE_SIDE)
					continue;
				const png = toPng(encodePng, decoded, "mask" in draw && draw.mask);
				if (!png) {
					options.problems?.push(
						`page ${number}: a ${decoded.width}x${decoded.height} picture was left out, its pixel layout is one this cannot write`,
					);
					continue;
				}
				n++;
				taken++;
				pictures.push({
					png,
					width: decoded.width,
					height: decoded.height,
					coverage: draw.area,
					stem: `p${number}-${n}`,
				});
			}
		}

		let recognized: string | undefined;
		if (scanned && options.recognize) {
			const pageImages = pictures.filter(
				(picture) => picture.coverage >= OCR_MIN_COVERAGE,
			);
			if (pageImages.length > 0) progress(number, "recognizing text");
			const result =
				pageImages.length > 0
					? await options.recognize(number, pageImages)
					: undefined;
			if (result?.text.trim()) {
				recognizedPages.push(number);
				recognized = `[Text recognized from the page image by ${result.by}]\n\n${result.text.trim()}`;
			}
		}

		const links: string[] = [];
		if (options.wantImages) {
			for (const picture of pictures) {
				const added = options.images.add({
					data: picture.png,
					stem: picture.stem,
					mediaType: "image/png",
					width: picture.width,
					height: picture.height,
					source: `page ${number}`,
				});
				if (added) links.push(imageMarkdown(added));
			}
		}
		parts.push(
			[`## Page ${number}`, text, recognized ?? "", ...links]
				.filter((part) => part.length > 0)
				.join("\n\n"),
		);
		page.cleanup();
	}

	return {
		markdown: parts.join("\n\n"),
		reader: "pdf.js",
		...(typeof info.Title === "string" && info.Title.trim()
			? { title: info.Title.trim() }
			: {}),
		...(typeof info.Author === "string" && info.Author.trim()
			? { author: info.Author.trim() }
			: {}),
		units: { name: "page", total, read },
		...(scannedPages.length ? { scannedPages } : {}),
		...(recognizedPages.length ? { recognizedPages } : {}),
		...(ocrLayerPages.length ? { ocrLayerPages } : {}),
		...(vectorPages.length ? { vectorPages } : {}),
	};
}
