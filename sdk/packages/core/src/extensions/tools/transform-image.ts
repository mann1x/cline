/**
 * Resize, crop and convert an image that is already a file.
 *
 * Asked for by the first person to generate images with this in earnest: "the
 * harness needs the ability to dynamically change the image size", and to crop.
 * An image model draws at the sizes it knows, a README wants 1200 pixels across
 * and an installer wants an `.ico`, and until now the model's only way from one
 * to the other was a shell command for a program that might not be installed.
 *
 * The work is done by the browser `render_image` already uses: it decodes
 * every format a page can show and encodes the three that matter. So there is
 * no image library here, and nothing new to ship.
 */

import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { type AgentTool, createTool } from "@cline/shared";
import {
	resolveInsideWorkspace,
	saveAndReportImage,
	type ToolOutput,
} from "./image-generation";
import {
	parseCrop,
	RENDER_ROOT_ID,
	type RenderDriver,
	type RenderRegion,
	type RenderResult,
} from "./render-image";

export const TRANSFORM_IMAGE_TOOL_NAME = "transform_image";

export const TRANSFORM_IMAGE_TOOL_DESCRIPTION = `Resize, crop or convert an image file in the workspace and save the result as a new file. Use it to change an image's dimensions, cut a region out of it, change its format, or make an icon file from it. The source is never modified.

- \`image\` — workspace path of the source: PNG, JPEG, WebP, GIF, BMP, AVIF, ICO or SVG.
- \`path\` — where to save, relative to the workspace. The extension chooses the format: \`.png\`, \`.jpg\`, \`.webp\`, \`.ico\` or \`.icns\`. Optional; defaults to a file beside the source with the new size in its name.
- \`width\`, \`height\` — the new size in pixels. Give one and the other follows the proportions.
- \`fit\` — with both given: \`inside\` (default; the whole image, within the box, proportions kept), \`cover\` (fills the box, the overflow cut off), \`pad\` (the whole image, padded to exactly the box) or \`stretch\`.
- \`crop\` — \`"x,y,width,height"\` in pixels of the source, taken before resizing.
- \`background\` — a CSS colour for padding and for what was transparent. Optional; transparency is kept where the format has it, and JPEG gets white.
- \`quality\` — 1 to 100 for \`.jpg\` and \`.webp\`, default 90.
- \`sizes\` — for \`.ico\` and \`.icns\`, the sizes to hold, e.g. \`"16,32,48,256"\`. Optional; the usual set when left out.`;

export const TRANSFORM_IMAGE_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		image: {
			type: "string",
			description: "Workspace path of the source image.",
		},
		path: {
			type: "string",
			description:
				"Where to save (.png, .jpg, .webp, .ico or .icns), relative to the workspace. Optional.",
		},
		width: { type: "number", description: "New width in pixels. Optional." },
		height: { type: "number", description: "New height in pixels. Optional." },
		fit: {
			type: "string",
			enum: ["inside", "cover", "pad", "stretch"],
			description: "How the image meets a box of both sizes. Optional.",
		},
		crop: {
			type: "string",
			description: '"x,y,width,height" in source pixels. Optional.',
		},
		background: {
			type: "string",
			description: "A CSS colour. Optional.",
		},
		quality: {
			type: "number",
			description: "1 to 100, for .jpg and .webp. Optional.",
		},
		sizes: {
			type: "string",
			description: 'For .ico and .icns: sizes to hold, e.g. "16,32,48,256".',
		},
	},
	required: ["image"],
} as const;

export type ImageFit = "inside" | "cover" | "pad" | "stretch";

export interface TransformPlan {
	/** The part of the source that is drawn. */
	sx: number;
	sy: number;
	sw: number;
	sh: number;
	/** The size of the result. */
	width: number;
	height: number;
	/** Where the source lands in it. */
	dx: number;
	dy: number;
	dw: number;
	dh: number;
}

/**
 * Where a source of this size goes in a result of that one.
 *
 * Written to stand alone, with nothing declared outside it and no function
 * inside it: the page that draws the image runs this same text.
 */
export function planTransform(
	sourceWidth: number,
	sourceHeight: number,
	crop: { x: number; y: number; width: number; height: number } | null,
	width: number | null,
	height: number | null,
	fit: string,
): TransformPlan | null {
	let sx = 0;
	let sy = 0;
	let sw = sourceWidth;
	let sh = sourceHeight;
	if (crop) {
		sx = Math.min(Math.max(0, crop.x), sourceWidth);
		sy = Math.min(Math.max(0, crop.y), sourceHeight);
		sw = Math.min(crop.width, sourceWidth - sx);
		sh = Math.min(crop.height, sourceHeight - sy);
	}
	if (!(sw > 0) || !(sh > 0)) {
		return null;
	}
	if (width === null && height === null) {
		const w = Math.round(sw);
		const h = Math.round(sh);
		return { sx, sy, sw, sh, width: w, height: h, dx: 0, dy: 0, dw: w, dh: h };
	}
	if (width === null || height === null) {
		const scale = width !== null ? width / sw : (height as number) / sh;
		const w = Math.max(1, Math.round(sw * scale));
		const h = Math.max(1, Math.round(sh * scale));
		return { sx, sy, sw, sh, width: w, height: h, dx: 0, dy: 0, dw: w, dh: h };
	}
	if (fit === "stretch") {
		return {
			sx,
			sy,
			sw,
			sh,
			width,
			height,
			dx: 0,
			dy: 0,
			dw: width,
			dh: height,
		};
	}
	if (fit === "cover") {
		const scale = Math.max(width / sw, height / sh);
		const takenWidth = width / scale;
		const takenHeight = height / scale;
		return {
			sx: sx + (sw - takenWidth) / 2,
			sy: sy + (sh - takenHeight) / 2,
			sw: takenWidth,
			sh: takenHeight,
			width,
			height,
			dx: 0,
			dy: 0,
			dw: width,
			dh: height,
		};
	}
	const scale = Math.min(width / sw, height / sh);
	const dw = Math.max(1, Math.round(sw * scale));
	const dh = Math.max(1, Math.round(sh * scale));
	if (fit === "pad") {
		return {
			sx,
			sy,
			sw,
			sh,
			width,
			height,
			dx: Math.floor((width - dw) / 2),
			dy: Math.floor((height - dh) / 2),
			dw,
			dh,
		};
	}
	return { sx, sy, sw, sh, width: dw, height: dh, dx: 0, dy: 0, dw, dh };
}

export interface TransformSpec {
	crop?: RenderRegion;
	width?: number;
	height?: number;
	fit: ImageFit;
	/** Painted under the image, over the whole result. */
	background?: string;
}

/** The page that draws one image at its new size. */
export function buildTransformDocument(
	sourceUrl: string,
	spec: TransformSpec,
): string {
	const parameters = JSON.stringify({
		crop: spec.crop ?? null,
		width: spec.width ?? null,
		height: spec.height ?? null,
		fit: spec.fit,
		background: spec.background ?? null,
	}).replace(/</g, "\\u003c");
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
html, body { margin: 0; padding: 0; background: transparent; }
#${RENDER_ROOT_ID} { display: inline-block; vertical-align: top; line-height: 0; }
canvas { display: block; }
</style>
</head>
<body><div id="${RENDER_ROOT_ID}"></div><img id="source" alt="" style="display:none" src="${sourceUrl.replace(/"/g, "%22")}">
<script>
${planTransform.toString()}
addEventListener("load", function () {
	var p = ${parameters};
	var source = document.getElementById("source");
	var plan = planTransform(source.naturalWidth, source.naturalHeight, p.crop, p.width, p.height, p.fit);
	if (!plan) { return; }
	var canvas = document.createElement("canvas");
	canvas.width = plan.width;
	canvas.height = plan.height;
	canvas.style.width = plan.width + "px";
	canvas.style.height = plan.height + "px";
	var context = canvas.getContext("2d");
	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = "high";
	if (p.background) { context.fillStyle = p.background; context.fillRect(0, 0, plan.width, plan.height); }
	context.drawImage(source, plan.sx, plan.sy, plan.sw, plan.sh, plan.dx, plan.dy, plan.dw, plan.dh);
	document.getElementById("${RENDER_ROOT_ID}").appendChild(canvas);
});
</script>
</body>
</html>`;
}

/** One image, drawn at a new size by the host's browser. */
export async function transformWithDriver(
	driver: RenderDriver,
	input: {
		sourcePath: string;
		baseDir: string;
		spec: TransformSpec;
		format?: "png" | "jpeg" | "webp";
		quality?: number;
		signal?: AbortSignal;
	},
): Promise<RenderResult> {
	const format = input.format ?? "png";
	return driver.render({
		html: buildTransformDocument(
			pathToFileURL(input.sourcePath).href,
			// JPEG has no transparency: what was clear has to be some colour.
			format === "jpeg" && !input.spec.background
				? { ...input.spec, background: "#ffffff" }
				: input.spec,
		),
		baseDir: input.baseDir,
		// The canvas is the result, pixel for pixel: one CSS pixel each.
		width: 1280,
		fitContent: true,
		scale: 1,
		transparent: format !== "jpeg",
		wantSvg: false,
		format,
		...(input.quality !== undefined ? { quality: input.quality } : {}),
		...(input.signal ? { signal: input.signal } : {}),
	});
}

/** An `.ico`: a directory of images, each one a PNG. */
export function encodeIco(images: { size: number; png: Buffer }[]): Buffer {
	const header = Buffer.alloc(6 + 16 * images.length);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(images.length, 4);
	let offset = header.length;
	images.forEach((image, index) => {
		const at = 6 + 16 * index;
		// One byte each, and 256 is written as 0.
		header.writeUInt8(image.size >= 256 ? 0 : image.size, at);
		header.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
		header.writeUInt8(0, at + 2);
		header.writeUInt8(0, at + 3);
		header.writeUInt16LE(1, at + 4);
		header.writeUInt16LE(32, at + 6);
		header.writeUInt32LE(image.png.length, at + 8);
		header.writeUInt32LE(offset, at + 12);
		offset += image.png.length;
	});
	return Buffer.concat([header, ...images.map((image) => image.png)]);
}

const ICNS_TYPES: Record<number, string> = {
	16: "icp4",
	32: "icp5",
	64: "icp6",
	128: "ic07",
	256: "ic08",
	512: "ic09",
	1024: "ic10",
};

/** An `.icns`: the same idea, with a name per size. */
export function encodeIcns(images: { size: number; png: Buffer }[]): Buffer {
	const entries = images.flatMap((image) => {
		const type = ICNS_TYPES[image.size];
		if (!type) {
			return [];
		}
		const head = Buffer.alloc(8);
		head.write(type, 0, "ascii");
		head.writeUInt32BE(image.png.length + 8, 4);
		return [head, image.png];
	});
	const head = Buffer.alloc(8);
	head.write("icns", 0, "ascii");
	head.writeUInt32BE(
		8 + entries.reduce((total, entry) => total + entry.length, 0),
		4,
	);
	return Buffer.concat([head, ...entries]);
}

export const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
export const ICNS_SIZES = [16, 32, 64, 128, 256, 512, 1024];

/** The sizes an icon file is asked to hold, or why not those. */
export function parseIconSizes(
	value: unknown,
	container: "ico" | "icns",
): number[] | { error: string } {
	const allowed = container === "ico" ? undefined : ICNS_SIZES;
	if (value === undefined || value === null || value === "") {
		return container === "ico" ? ICO_SIZES : ICNS_SIZES;
	}
	const parts = Array.isArray(value)
		? value
		: String(value)
				.split(/[\s,;]+/)
				.filter(Boolean);
	const sizes = [...new Set(parts.map((part) => Number(part)))].sort(
		(a, b) => a - b,
	);
	if (
		sizes.length === 0 ||
		sizes.some((size) => !Number.isInteger(size) || size < 1)
	) {
		return {
			error: '`sizes` is a list of whole numbers, e.g. "16,32,48,256".',
		};
	}
	if (container === "ico" && sizes.some((size) => size > 256)) {
		return { error: "An `.ico` holds images up to 256 pixels." };
	}
	if (allowed && sizes.some((size) => !allowed.includes(size))) {
		return { error: `An \`.icns\` holds these sizes: ${allowed.join(", ")}.` };
	}
	return sizes;
}

/** Every size of an icon, from one source, as square PNGs. */
export async function renderIconSizes(
	driver: RenderDriver,
	input: {
		sourcePath: string;
		baseDir: string;
		sizes: number[];
		crop?: RenderRegion;
		background?: string;
		signal?: AbortSignal;
	},
): Promise<{ size: number; png: Buffer }[]> {
	const images: { size: number; png: Buffer }[] = [];
	for (const size of input.sizes) {
		const result = await transformWithDriver(driver, {
			sourcePath: input.sourcePath,
			baseDir: input.baseDir,
			spec: {
				width: size,
				height: size,
				fit: "pad",
				...(input.crop ? { crop: input.crop } : {}),
				...(input.background ? { background: input.background } : {}),
			},
			...(input.signal ? { signal: input.signal } : {}),
		});
		if (result.width !== size || result.height !== size) {
			throw new UnreadableImageError();
		}
		images.push({ size, png: result.data });
	}
	return images;
}

export class UnreadableImageError extends Error {
	constructor() {
		super("the source could not be read as an image");
	}
}

export interface TransformImageToolOptions {
	cwd: string;
	createDriver: () => RenderDriver | Promise<RenderDriver>;
	/** Whether the source is there: the browser says nothing useful about a missing file. */
	fileExists: (absolutePath: string) => Promise<boolean>;
	writeFile: (absolutePath: string, data: Buffer) => Promise<void>;
	onError?: (message: string, error: unknown) => void;
}

interface TransformImageToolInput {
	image?: unknown;
	path?: unknown;
	width?: unknown;
	height?: unknown;
	fit?: unknown;
	crop?: unknown;
	background?: unknown;
	quality?: unknown;
	sizes?: unknown;
}

const MAX_SIDE = 16_000;
const FORMATS: Record<string, "png" | "jpeg" | "webp" | "ico" | "icns"> = {
	".png": "png",
	".jpg": "jpeg",
	".jpeg": "jpeg",
	".webp": "webp",
	".ico": "ico",
	".icns": "icns",
};

function wholeNumber(value: unknown): number | undefined {
	const parsed =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim() !== ""
				? Number(value)
				: Number.NaN;
	return Number.isFinite(parsed) && parsed >= 1
		? Math.round(parsed)
		: undefined;
}

/** Create the `transform_image` tool. */
export function createTransformImageTool(
	options: TransformImageToolOptions,
): AgentTool {
	let driver: RenderDriver | undefined;

	return createTool({
		name: TRANSFORM_IMAGE_TOOL_NAME,
		description: TRANSFORM_IMAGE_TOOL_DESCRIPTION,
		inputSchema: TRANSFORM_IMAGE_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown, context): Promise<ToolOutput> => {
			const request = (input ?? {}) as TransformImageToolInput;
			const sourceAsked =
				typeof request.image === "string" ? request.image.trim() : "";
			if (!sourceAsked) {
				return "`transform_image` needs `image`: the workspace path of the image to change.";
			}
			const sourcePath = resolveInsideWorkspace(options.cwd, sourceAsked);
			if (!sourcePath) {
				return `\`${sourceAsked}\` is outside the workspace.`;
			}
			if (!(await options.fileExists(sourcePath))) {
				return `There is no file at \`${sourceAsked}\`.`;
			}

			const width = wholeNumber(request.width);
			const height = wholeNumber(request.height);
			if ((width ?? 0) > MAX_SIDE || (height ?? 0) > MAX_SIDE) {
				return `An image can be at most ${MAX_SIDE} pixels on a side.`;
			}
			const fitAsked =
				typeof request.fit === "string" ? request.fit.trim().toLowerCase() : "";
			if (
				fitAsked &&
				!["inside", "cover", "pad", "stretch"].includes(fitAsked)
			) {
				return `\`fit\` is \`inside\`, \`cover\`, \`pad\` or \`stretch\`; \`${fitAsked}\` is none of them.`;
			}
			const fit = (fitAsked || "inside") as ImageFit;
			const crop =
				request.crop === undefined || request.crop === ""
					? undefined
					: parseCrop(request.crop);
			if (request.crop !== undefined && request.crop !== "" && !crop) {
				return '`crop` is `"x,y,width,height"` in pixels of the source, all four numbers, with a width and a height above zero.';
			}
			const background =
				typeof request.background === "string" && request.background.trim()
					? request.background.trim()
					: undefined;
			if (background && /[;{}<>"'\\]/.test(background)) {
				return "`background` is one CSS colour (`#0d1117`, `white`, `rgb(0 0 0 / 50%)`).";
			}
			const quality = Math.min(100, wholeNumber(request.quality) ?? 90);

			const askedPath =
				typeof request.path === "string" && request.path.trim()
					? request.path.trim()
					: undefined;
			const sourceExtension = nodePath.extname(sourceAsked).toLowerCase();
			const extension = askedPath
				? nodePath.extname(askedPath).toLowerCase()
				: FORMATS[sourceExtension] && FORMATS[sourceExtension] !== "ico"
					? sourceExtension
					: ".png";
			const format = FORMATS[extension];
			if (!format) {
				return `\`transform_image\` writes \`.png\`, \`.jpg\`, \`.webp\`, \`.ico\` and \`.icns\`; \`${askedPath}\` is none of them.`;
			}

			const signal = context?.signal;
			const sourceName = sourceAsked.slice(
				0,
				sourceAsked.length - sourceExtension.length,
			);
			const finish = async (
				shown: Buffer,
				shownType: string,
				written: Buffer,
				size: string,
				described: string,
			): Promise<ToolOutput> => {
				const requestedPath = askedPath ?? `${sourceName}-${size}${extension}`;
				const absolutePath = resolveInsideWorkspace(options.cwd, requestedPath);
				if (!absolutePath) {
					return `\`${requestedPath}\` is outside the workspace. Save the image somewhere under the project.`;
				}
				if (absolutePath === sourcePath) {
					return "That would write over the source. Give `path` another name.";
				}
				await options.writeFile(absolutePath, written);
				return saveAndReportImage({
					image: { data: shown, mediaType: shownType },
					verb: "Transformed",
					// The path is settled: nothing here renames it by its bytes.
					askedPath: requestedPath,
					requestedPath,
					absolutePath,
					size: described,
					writeFile: async () => undefined,
					context,
				});
			};

			try {
				driver ??= await options.createDriver();
				if (format === "ico" || format === "icns") {
					const sizes = parseIconSizes(request.sizes, format);
					if ("error" in sizes) {
						return sizes.error;
					}
					const images = await renderIconSizes(driver, {
						sourcePath,
						baseDir: options.cwd,
						sizes,
						...(crop ? { crop } : {}),
						...(background ? { background } : {}),
						...(signal ? { signal } : {}),
					});
					const largest = images[images.length - 1] as {
						size: number;
						png: Buffer;
					};
					return await finish(
						largest.png,
						"image/png",
						format === "ico" ? encodeIco(images) : encodeIcns(images),
						`${largest.size}x${largest.size}`,
						`holds ${sizes.join(", ")}`,
					);
				}
				const result = await transformWithDriver(driver, {
					sourcePath,
					baseDir: options.cwd,
					spec: {
						fit,
						...(crop ? { crop } : {}),
						...(width !== undefined ? { width } : {}),
						...(height !== undefined ? { height } : {}),
						...(background ? { background } : {}),
					},
					format,
					...(format !== "png" ? { quality } : {}),
					...(signal ? { signal } : {}),
				});
				if (result.width <= 0 || result.height <= 0) {
					return `\`${sourceAsked}\` could not be read as an image, or the crop lies outside it.`;
				}
				const size = `${result.width}x${result.height}`;
				return await finish(
					result.data,
					`image/${format}`,
					result.data,
					size,
					size,
				);
			} catch (error) {
				if (signal?.aborted) {
					return "Stopped before the image was written.";
				}
				if (error instanceof UnreadableImageError) {
					return `\`${sourceAsked}\` could not be read as an image, or the crop lies outside it.`;
				}
				options.onError?.("[transform_image] failed", error);
				const message = error instanceof Error ? error.message : String(error);
				return `The image could not be changed: ${message}`;
			}
		},
	});
}
