/**
 * Icons: several proposals to choose from, then every file an icon is.
 *
 * `generate_image` can draw an icon, and the first person to use it for one
 * was pleased that it could. What it left him with was one PNG at the size the
 * model draws, when an icon is a choice between candidates and then a dozen
 * files: an `.ico` holding seven sizes, an `.icns`, and the PNGs a web page and
 * a phone ask for by size.
 *
 * So this is two steps under one name. With a `prompt` it draws several
 * proposals and shows them on one numbered sheet, for the user to pick from.
 * With `pick` it writes the chosen one out in every format. The model asks the
 * question in between: choosing is the user's part.
 */

import * as nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { type AgentTool, createTool } from "@cline/shared";
import {
	extensionForMediaType,
	type ImageGenerationEndpoint,
	parseSize,
	requestGeneratedImage,
	resolveInsideWorkspace,
	type ToolOutput,
} from "./image-generation";
import { MediaRequestTimeoutError } from "./media-endpoint";
import { buildRenderDocument, type RenderDriver } from "./render-image";
import {
	encodeIcns,
	encodeIco,
	ICNS_SIZES,
	ICO_SIZES,
	renderIconSizes,
	transformWithDriver,
	UnreadableImageError,
} from "./transform-image";

export const GENERATE_ICON_TOOL_NAME = "generate_icon";

export const GENERATE_ICON_TOOL_DESCRIPTION = `Make an icon for an application, a site or a file type: several proposals for the user to choose from, then the chosen one saved in every format an icon needs. Two steps, one call each.

1. Proposals. Give \`prompt\`: what the icon shows and the feeling it should have ("a paper plane, friendly, blue on white"). Several candidates are drawn and returned on one numbered sheet, each saved as its own file. Show the user the sheet and ask which one they want (\`ask_question\`, with the numbers as the options); do not choose for them. If none is right, call again with a changed prompt.
2. Files. Give \`pick\`: the path of the chosen proposal (or of any square image in the workspace), and \`path\`: where the icon belongs, without an extension, e.g. \`assets/icon\`. That writes \`assets/icon.ico\`, \`assets/icon.icns\`, \`assets/icon.png\` and \`assets/icon-<size>.png\` for the usual sizes.

Arguments:
- \`prompt\` — step 1: the subject and the mood. The rules of an icon (one centred subject, bold shapes, no text) are added for you.
- \`count\` — step 1: how many proposals, 1 to 6. Optional, default 4.
- \`style\` — step 1: e.g. \`flat vector\`, \`glossy 3D\`, \`line art\`, \`pixel art\`. Optional, default flat vector.
- \`pick\` — step 2: workspace path of the image to make the icon from.
- \`path\` — step 2: where to save, without an extension.
- \`formats\` — step 2: which of \`ico\`, \`icns\`, \`png\`, \`webp\` to write. Optional, default \`ico,icns,png\`.
- \`sizes\` — step 2: the PNG sizes to write beside the main one. Optional, default \`16,32,48,64,128,180,192,256,512\`.
- \`background\` — step 2: a CSS colour to put behind the icon. Optional; left as the proposal has it.

Each proposal costs what an image costs: seconds to a minute, and money on a hosted backend.`;

export const GENERATE_ICON_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		prompt: {
			type: "string",
			description: "Step 1: what the icon shows, and its mood.",
		},
		count: {
			type: "number",
			description: "Step 1: how many proposals, 1 to 6. Default 4.",
		},
		style: {
			type: "string",
			description: "Step 1: the drawing style. Default flat vector.",
		},
		pick: {
			type: "string",
			description: "Step 2: workspace path of the chosen image.",
		},
		path: {
			type: "string",
			description:
				"Step 2: where the icon is saved, without an extension, e.g. assets/icon.",
		},
		formats: {
			type: "string",
			description: "Step 2: any of ico, icns, png, webp. Default ico,icns,png.",
		},
		sizes: {
			type: "string",
			description: "Step 2: PNG sizes to write beside the main one.",
		},
		background: {
			type: "string",
			description: "Step 2: a CSS colour behind the icon. Optional.",
		},
	},
	required: [],
} as const;

export interface GenerateIconToolOptions {
	cwd: string;
	getEndpoint: () =>
		| ImageGenerationEndpoint
		| undefined
		| Promise<ImageGenerationEndpoint | undefined>;
	createDriver: () => RenderDriver | Promise<RenderDriver>;
	fileExists: (absolutePath: string) => Promise<boolean>;
	writeFile: (absolutePath: string, data: Buffer) => Promise<void>;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	now?: () => number;
	onError?: (message: string, error: unknown) => void;
}

interface GenerateIconToolInput {
	prompt?: unknown;
	count?: unknown;
	style?: unknown;
	pick?: unknown;
	path?: unknown;
	formats?: unknown;
	sizes?: unknown;
	background?: unknown;
}

const DEFAULT_COUNT = 4;
const MAX_COUNT = 6;
const DEFAULT_PNG_SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512];
const MAIN_PNG_SIZE = 1024;
const ICON_FORMATS = ["ico", "icns", "png", "webp"];

/**
 * What sets one proposal apart from the next. Words about the drawing and
 * never a number: a model asked for "variation 2" draws a 2.
 */
const VARIATIONS = [
	"",
	" A different composition.",
	" A simpler, more geometric take.",
	" A different colour palette.",
	" A bolder, heavier silhouette.",
	" The most minimal version.",
];

/** The prompt an icon is drawn from: the subject, then what makes it an icon. */
export function buildIconPrompt(
	subject: string,
	style: string,
	index: number,
): string {
	return `${subject.replace(/[.\s]+$/, "")}. An app icon in ${style} style: one centred subject filling most of the square, simple bold shapes that still read at 16 pixels, a plain solid background, no text, no letters, no border, no mockup of a device.${VARIATIONS[index % VARIATIONS.length]}`;
}

function slugOf(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.split("-")
			.filter(Boolean)
			.slice(0, 4)
			.join("-") || "icon"
	);
}

/** The proposals on one sheet, each under its number. */
export function buildProposalSheet(fileUrls: string[]): string {
	const tiles = fileUrls
		.map(
			(url, index) =>
				`<figure><img src="${url.replace(/"/g, "%22")}" alt=""><figcaption>${index + 1}</figcaption></figure>`,
		)
		.join("");
	return `<div class="sheet">${tiles}</div>
<style>
.sheet { display: grid; grid-template-columns: repeat(${Math.min(fileUrls.length, 3)}, 256px); gap: 16px; padding: 16px; background: #ffffff; font-family: system-ui, sans-serif; }
figure { margin: 0; }
img { display: block; width: 256px; height: 256px; object-fit: contain; border-radius: 12px; box-shadow: 0 0 0 1px #d0d7de; }
figcaption { text-align: center; padding-top: 6px; font-size: 20px; font-weight: 600; color: #1f2328; }
</style>`;
}

function parseList(value: unknown): string[] {
	return Array.isArray(value)
		? value.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean)
		: typeof value === "string"
			? value
					.split(/[\s,;]+/)
					.map((entry) => entry.trim().toLowerCase())
					.filter(Boolean)
			: [];
}

/** Create the `generate_icon` tool. */
export function createGenerateIconTool(
	options: GenerateIconToolOptions,
): AgentTool {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 180_000;
	const now = options.now ?? Date.now;
	let driver: RenderDriver | undefined;

	const show = (
		context:
			| {
					metadata?: Record<string, unknown>;
					emitUpdate?: (update: unknown) => void;
			  }
			| undefined,
		text: string,
		picture: Buffer | undefined,
	): ToolOutput => {
		if (!picture) {
			return text;
		}
		const image = {
			type: "image" as const,
			data: picture.toString("base64"),
			mediaType: "image/png",
		};
		if (context?.metadata?.modelSupportsImages !== true) {
			// The person watching sees the sheet on the tool's row either way.
			context?.emitUpdate?.({ displayImages: [image] });
			return `${text}\n\nYou cannot see images: the user can, on this tool's row.`;
		}
		return [{ type: "text", text }, image];
	};

	const propose = async (
		request: GenerateIconToolInput,
		prompt: string,
		context: Parameters<AgentTool["execute"]>[1],
	): Promise<ToolOutput> => {
		const endpoint = await options.getEndpoint();
		if (!endpoint?.baseUrl || !endpoint.model) {
			return (
				"No image generation endpoint is configured, so no icon was drawn. " +
				"The user names one on the Images tab of the API configuration settings; " +
				"tell them that rather than trying again. An icon that already exists as an image can still be saved in every format: pass it as `pick`."
			);
		}
		const asked = Number(request.count);
		const count = Number.isFinite(asked)
			? Math.min(MAX_COUNT, Math.max(1, Math.round(asked)))
			: DEFAULT_COUNT;
		const style =
			typeof request.style === "string" && request.style.trim()
				? request.style.trim()
				: "flat vector";
		// Square whatever the tab says: an icon has one shape.
		const configured = parseSize(endpoint.size);
		const side = configured
			? Math.min(...configured.split("x").map(Number))
			: 1024;
		const size = `${side}x${side}`;
		const stem = nodePath.posix.join(
			".cline",
			"generated-images",
			"icons",
			`${slugOf(prompt)}-${now()}`,
		);
		const signal = context?.signal;

		const saved: { path: string; absolute: string }[] = [];
		const failures: string[] = [];
		for (let index = 0; index < count; index += 1) {
			if (signal?.aborted) {
				break;
			}
			context?.emitUpdate?.({
				status: `Drawing proposal ${index + 1} of ${count}.`,
			});
			try {
				const made = await requestGeneratedImage({
					endpoint,
					prompt: buildIconPrompt(prompt, style, index),
					size,
					fetchImpl,
					timeoutMs,
					signal,
					onBusy: (waitMs) =>
						context?.emitUpdate?.({
							status: `The image engine is busy; asking again in ${Math.round(waitMs / 1000)}s.`,
						}),
				});
				if ("error" in made) {
					failures.push(made.error);
					// A refusal is the same for the next one: stop asking.
					if (saved.length === 0) {
						break;
					}
					continue;
				}
				const path = `${stem}-${saved.length + 1}${extensionForMediaType(made.image.mediaType)}`;
				const absolute = resolveInsideWorkspace(options.cwd, path);
				if (!absolute) {
					return "The workspace has no place for the proposals.";
				}
				await options.writeFile(absolute, made.image.data);
				saved.push({ path, absolute });
			} catch (error) {
				if (signal?.aborted) {
					break;
				}
				if (error instanceof MediaRequestTimeoutError) {
					failures.push(
						`A proposal was not finished within ${Math.round(timeoutMs / 1000)}s.`,
					);
				} else {
					options.onError?.("[generate_icon] request failed", error);
					failures.push(
						`Could not reach the image endpoint: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				if (saved.length === 0) {
					break;
				}
			}
		}
		if (saved.length === 0) {
			return signal?.aborted
				? "Stopped before any proposal was drawn."
				: (failures[0] ?? "No proposal was drawn.");
		}

		let sheet: Buffer | undefined;
		try {
			driver ??= await options.createDriver();
			const rendered = await driver.render({
				html: buildRenderDocument({
					kind: "html",
					source: buildProposalSheet(
						saved.map((entry) => pathToFileURL(entry.absolute).href),
					),
				}),
				baseDir: options.cwd,
				width: 1280,
				fitContent: true,
				scale: 1,
				transparent: false,
				wantSvg: false,
				...(signal ? { signal } : {}),
			});
			sheet = rendered.width > 0 ? rendered.data : undefined;
		} catch (error) {
			// The proposals exist as files; the sheet is the convenience.
			options.onError?.("[generate_icon] proposal sheet failed", error);
		}

		const list = saved
			.map((entry, index) => `${index + 1}. \`${entry.path}\``)
			.join("\n");
		const short =
			saved.length < count
				? `\n\n${count - saved.length} of the ${count} asked for could not be drawn: ${failures[failures.length - 1] ?? "stopped"}`
				: "";
		return show(
			context,
			`Drew ${saved.length} icon proposal${saved.length === 1 ? "" : "s"}:\n\n${list}${short}\n\nShow the user the numbered sheet and ask which one they want. Then call \`generate_icon\` with \`pick\` set to that file and \`path\` to where the icon belongs. If none is right, call it again with a changed \`prompt\`.`,
			sheet,
		);
	};

	const write = async (
		request: GenerateIconToolInput,
		pickAsked: string,
		context: Parameters<AgentTool["execute"]>[1],
	): Promise<ToolOutput> => {
		const sourcePath = resolveInsideWorkspace(options.cwd, pickAsked);
		if (!sourcePath) {
			return `\`${pickAsked}\` is outside the workspace.`;
		}
		if (!(await options.fileExists(sourcePath))) {
			return `There is no file at \`${pickAsked}\`.`;
		}
		const pathAsked =
			typeof request.path === "string" ? request.path.trim() : "";
		if (!pathAsked) {
			return "`generate_icon` with `pick` needs `path`: where the icon is saved, without an extension, e.g. `assets/icon`.";
		}
		// A path given with an extension means that base name all the same.
		const base = pathAsked.replace(/\.(ico|icns|png|webp|jpe?g|svg)$/i, "");
		const formats = parseList(request.formats);
		const wanted = formats.length > 0 ? formats : ["ico", "icns", "png"];
		const unknown = wanted.filter((format) => !ICON_FORMATS.includes(format));
		if (unknown.length > 0) {
			return `\`formats\` takes ${ICON_FORMATS.map((format) => `\`${format}\``).join(", ")}; \`${unknown[0]}\` is none of them.`;
		}
		const sizesAsked = parseList(request.sizes).map(Number);
		if (
			sizesAsked.some(
				(size) => !Number.isInteger(size) || size < 1 || size > 2048,
			)
		) {
			return '`sizes` is a list of whole numbers up to 2048, e.g. "16,32,180,512".';
		}
		const pngSizes =
			sizesAsked.length > 0
				? [...new Set(sizesAsked)].sort((a, b) => a - b)
				: DEFAULT_PNG_SIZES;
		const background =
			typeof request.background === "string" && request.background.trim()
				? request.background.trim()
				: undefined;
		if (background && /[;{}<>"'\\]/.test(background)) {
			return "`background` is one CSS colour (`#0d1117`, `white`).";
		}

		const needed = new Set<number>();
		if (wanted.includes("ico")) {
			for (const size of ICO_SIZES) needed.add(size);
		}
		if (wanted.includes("icns")) {
			for (const size of ICNS_SIZES) needed.add(size);
		}
		if (wanted.includes("png")) {
			needed.add(MAIN_PNG_SIZE);
			for (const size of pngSizes) needed.add(size);
		}
		needed.add(256);
		const signal = context?.signal;

		try {
			driver ??= await options.createDriver();
			context?.emitUpdate?.({ status: "Writing the icon's sizes." });
			const images = await renderIconSizes(driver, {
				sourcePath,
				baseDir: options.cwd,
				sizes: [...needed].sort((a, b) => a - b),
				...(background ? { background } : {}),
				...(signal ? { signal } : {}),
			});
			const bySize = new Map(images.map((image) => [image.size, image.png]));
			const pick = (sizes: number[]) =>
				sizes.map((size) => ({ size, png: bySize.get(size) as Buffer }));

			const files: { path: string; data: Buffer; note: string }[] = [];
			if (wanted.includes("ico")) {
				files.push({
					path: `${base}.ico`,
					data: encodeIco(pick(ICO_SIZES)),
					note: `Windows and favicons; holds ${ICO_SIZES.join(", ")}`,
				});
			}
			if (wanted.includes("icns")) {
				files.push({
					path: `${base}.icns`,
					data: encodeIcns(pick(ICNS_SIZES)),
					note: `macOS; holds ${ICNS_SIZES.join(", ")}`,
				});
			}
			if (wanted.includes("png")) {
				files.push({
					path: `${base}.png`,
					data: bySize.get(MAIN_PNG_SIZE) as Buffer,
					note: `${MAIN_PNG_SIZE}x${MAIN_PNG_SIZE}`,
				});
				for (const size of pngSizes) {
					files.push({
						path: `${base}-${size}.png`,
						data: bySize.get(size) as Buffer,
						note: `${size}x${size}`,
					});
				}
			}
			if (wanted.includes("webp")) {
				const webp = await transformWithDriver(driver, {
					sourcePath,
					baseDir: options.cwd,
					spec: {
						width: 512,
						height: 512,
						fit: "pad",
						...(background ? { background } : {}),
					},
					format: "webp",
					quality: 92,
					...(signal ? { signal } : {}),
				});
				files.push({ path: `${base}.webp`, data: webp.data, note: "512x512" });
			}

			const resolved = files.map((file) => ({
				...file,
				absolute: resolveInsideWorkspace(options.cwd, file.path),
			}));
			const outside = resolved.find((file) => !file.absolute);
			if (outside) {
				return `\`${outside.path}\` is outside the workspace. Save the icon somewhere under the project.`;
			}
			if (resolved.some((file) => file.absolute === sourcePath)) {
				return "That would write over the image the icon is made from. Give `path` another name.";
			}
			for (const file of resolved) {
				await options.writeFile(file.absolute as string, file.data);
			}
			return show(
				context,
				`Saved the icon from \`${pickAsked}\`:\n\n${files.map((file) => `- \`${file.path}\` (${file.note})`).join("\n")}`,
				bySize.get(256),
			);
		} catch (error) {
			if (signal?.aborted) {
				return "Stopped before the icon was written.";
			}
			if (error instanceof UnreadableImageError) {
				return `\`${pickAsked}\` could not be read as an image.`;
			}
			options.onError?.("[generate_icon] writing failed", error);
			return `The icon could not be written: ${error instanceof Error ? error.message : String(error)}`;
		}
	};

	return createTool({
		name: GENERATE_ICON_TOOL_NAME,
		description: GENERATE_ICON_TOOL_DESCRIPTION,
		inputSchema: GENERATE_ICON_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown, context): Promise<ToolOutput> => {
			const request = (input ?? {}) as GenerateIconToolInput;
			const pick = typeof request.pick === "string" ? request.pick.trim() : "";
			if (pick) {
				return write(request, pick, context);
			}
			const prompt =
				typeof request.prompt === "string" ? request.prompt.trim() : "";
			if (!prompt) {
				return "`generate_icon` needs a `prompt` (to draw proposals) or a `pick` (to save a chosen image as an icon).";
			}
			return propose(request, prompt, context);
		},
	});
}
