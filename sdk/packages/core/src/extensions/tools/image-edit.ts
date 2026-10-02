/**
 * A tool that changes a picture.
 *
 * `generate_image` makes one from nothing, and the next thing anyone wants is
 * to keep most of it: the same icon on a transparent ground, the same mockup
 * with the sidebar on the other side, a logo placed on a photograph. Asking a
 * generator again gets a different picture, not a corrected one.
 *
 * The wire format is the OpenAI images API's edit route
 * (`POST {endpoint}/images/edits`, multipart), which opencoti and xOllama
 * serve beside the generation route and which the hosted services serve too.
 * The images go as `image[]`, one or several: an edit model takes the extra
 * ones as references. What "edit" means is the model's: an instruction-edit
 * model (FLUX.2 klein, Qwen-Image) follows the prompt, a plain diffusion model
 * redraws over the source (img2img), and a `mask` limits either to a region.
 */

import * as nodePath from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import {
	defaultImagePath,
	type ImageGenerationEndpoint,
	type ImagesApiResponse,
	parseSize,
	readGeneratedImage,
	resolveInsideWorkspace,
	saveAndReportImage,
	sniffMediaType,
	type ToolOutput,
} from "./image-generation";
import {
	MediaRequestTimeoutError,
	normalizeBaseUrl,
	sendMediaRequest,
} from "./media-endpoint";

export const EDIT_IMAGE_TOOL_NAME = "edit_image";

export const EDIT_IMAGE_TOOL_DESCRIPTION = `Edit an existing image in the workspace according to a text instruction and save the result as a new file. Use it to change a picture you already have rather than generate a different one: recolour or restyle an icon, change one element of a mockup, combine a subject with a background.

The result is written to a file and, if you can see images, returned to you as well — so you can check the edit and try again with a changed instruction if it is wrong. The source images are never modified.

Arguments:
- \`prompt\` — what to change, as an instruction: "make the background transparent", "replace the red door with a blue one". Say what must stay the same when it matters.
- \`images\` — the image files to edit, as workspace paths. The first is the image being edited; any others are references the model may draw from (a style, a subject to place). Most backends take one to three.
- \`mask\` — optional workspace path of a mask image the same size as the first image. Only the masked region is changed.
- \`path\` — where to save the result, relative to the workspace. Optional; defaults to a file under \`.cline/generated-images/\`.
- \`size\` — \`WxH\` in pixels, e.g. \`1024x1024\`. Optional, and the backend may round it or keep the source's size.

How far an edit goes depends on the backend: some follow the instruction, others redraw over the source and only make small changes. Look at the result before relying on it. This costs real time — seconds to a minute per image — and on a hosted backend it costs money.`;

export const EDIT_IMAGE_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		prompt: {
			type: "string",
			description:
				"What to change, as an instruction. Say what must stay the same when it matters.",
		},
		images: {
			type: "array",
			items: { type: "string" },
			description:
				"Workspace paths of the images. The first is the one being edited; the rest are references.",
		},
		mask: {
			type: "string",
			description:
				"Workspace path of a mask the same size as the first image. Optional; only the masked region is changed.",
		},
		path: {
			type: "string",
			description:
				"Where to save the result, relative to the workspace. Optional; defaults to a file under .cline/generated-images/.",
		},
		size: {
			type: "string",
			description: 'Pixel size as "WIDTHxHEIGHT", e.g. "1024x1024". Optional.',
		},
	},
	required: ["prompt", "images"],
} as const;

export interface EditImageToolInput {
	prompt?: unknown;
	images?: unknown;
	mask?: unknown;
	path?: unknown;
	size?: unknown;
}

export interface EditImageToolOptions {
	cwd: string;
	/** Where edits go. The same shape as generation's: URL, model, key, size. */
	getEndpoint: () =>
		| ImageGenerationEndpoint
		| undefined
		| Promise<ImageGenerationEndpoint | undefined>;
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, data: Buffer) => Promise<void>;
	fetchImpl?: typeof fetch;
	/** Milliseconds one edit may take. Defaults to 3 minutes. */
	timeoutMs?: number;
	onError?: (message: string, error: unknown) => void;
}

/** More than this is a mistake in the call, not a request a backend takes. */
const MAX_SOURCE_IMAGES = 8;

/** The paths the model named, as a list, whichever way it wrote them. */
export function parseImagePaths(value: unknown): string[] {
	const list = Array.isArray(value)
		? value
		: typeof value === "string"
			? [value]
			: [];
	return list
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

interface SourceImage {
	name: string;
	data: Buffer;
	mediaType: string;
}

async function loadSource(
	options: EditImageToolOptions,
	relativePath: string,
): Promise<SourceImage | { error: string }> {
	const absolutePath = resolveInsideWorkspace(options.cwd, relativePath);
	if (!absolutePath) {
		return {
			error: `\`${relativePath}\` is outside the workspace. Edit an image that is under the project.`,
		};
	}
	let data: Buffer;
	try {
		data = await options.readFile(absolutePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { error: `Could not read \`${relativePath}\`: ${message}` };
	}
	const mediaType = sniffMediaType(data);
	if (!mediaType) {
		return {
			error: `\`${relativePath}\` is not an image this tool can send (PNG, JPEG, WebP, GIF or BMP).`,
		};
	}
	return { name: nodePath.basename(absolutePath), data, mediaType };
}

function asBlob(image: SourceImage): Blob {
	return new Blob([new Uint8Array(image.data)], { type: image.mediaType });
}

/**
 * Create the `edit_image` tool.
 *
 * Like `generate_image`, the host leaves it out when nothing is configured,
 * and `getEndpoint` returning nothing is handled anyway.
 */
export function createEditImageTool(options: EditImageToolOptions): AgentTool {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 180_000;

	return createTool({
		name: EDIT_IMAGE_TOOL_NAME,
		description: EDIT_IMAGE_TOOL_DESCRIPTION,
		inputSchema: EDIT_IMAGE_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown, context): Promise<ToolOutput> => {
			const request = (input ?? {}) as EditImageToolInput;
			const prompt =
				typeof request.prompt === "string" ? request.prompt.trim() : "";
			if (!prompt) {
				return "`edit_image` needs a `prompt`: say what to change in the image.";
			}
			const imagePaths = parseImagePaths(request.images);
			if (imagePaths.length === 0) {
				return "`edit_image` needs `images`: the workspace path of the image to edit, and any reference images after it.";
			}
			if (imagePaths.length > MAX_SOURCE_IMAGES) {
				return `\`edit_image\` takes at most ${MAX_SOURCE_IMAGES} images; ${imagePaths.length} were given.`;
			}

			const endpoint = await options.getEndpoint();
			if (!endpoint?.baseUrl || !endpoint.model) {
				return (
					"No image editing endpoint is configured, so nothing was edited. " +
					"The user names one on the Images tab of the API configuration settings; " +
					"tell them that rather than trying again."
				);
			}

			const sources: SourceImage[] = [];
			for (const imagePath of imagePaths) {
				const source = await loadSource(options, imagePath);
				if ("error" in source) return source.error;
				sources.push(source);
			}
			const maskPath =
				typeof request.mask === "string" && request.mask.trim()
					? request.mask.trim()
					: undefined;
			const mask = maskPath ? await loadSource(options, maskPath) : undefined;
			if (mask && "error" in mask) return mask.error;

			const askedPath =
				typeof request.path === "string" && request.path.trim()
					? request.path.trim()
					: undefined;
			const requestedPath = askedPath ?? defaultImagePath(prompt, Date.now());
			const absolutePath = resolveInsideWorkspace(options.cwd, requestedPath);
			if (!absolutePath) {
				return `\`${requestedPath}\` is outside the workspace. Save the image somewhere under the project.`;
			}

			const size = parseSize(request.size) ?? parseSize(endpoint.size);
			const signal = context?.signal;

			try {
				const response = await sendMediaRequest(
					`${normalizeBaseUrl(endpoint.baseUrl)}/images/edits`,
					// Built per attempt: a multipart body is spent by the request
					// that sent it, and a busy engine is asked again.
					(): RequestInit => {
						const form = new FormData();
						form.append("model", endpoint.model);
						form.append("prompt", prompt);
						form.append("n", "1");
						form.append("response_format", "b64_json");
						if (size) form.append("size", size);
						for (const source of sources) {
							form.append("image[]", asBlob(source), source.name);
						}
						if (mask) form.append("mask", asBlob(mask), mask.name);
						// No Content-Type: fetch writes the multipart boundary.
						const headers: Record<string, string> = {};
						if (endpoint.apiKey) {
							headers.Authorization = `Bearer ${endpoint.apiKey}`;
						}
						return { method: "POST", headers, body: form };
					},
					{
						fetchImpl,
						signal,
						attemptTimeoutMs: timeoutMs,
						onBusy: (waitMs) =>
							context?.emitUpdate?.({
								status: `The image engine is busy; asking again in ${Math.round(waitMs / 1000)}s.`,
							}),
					},
				);

				if (response.status === 503) {
					return "The image engine is still busy with other requests after a long wait, so nothing was edited. Nothing is wrong with the request; try again later.";
				}
				if (!response.ok) {
					const detail = (await response.text().catch(() => "")).slice(0, 400);
					return `The image endpoint refused the edit (HTTP ${response.status}).${detail ? `\n\n${detail}` : ""}`;
				}

				const body = (await response.json()) as ImagesApiResponse;
				const image = await readGeneratedImage(body, fetchImpl, signal);
				if ("error" in image) {
					return image.error;
				}
				return await saveAndReportImage({
					image,
					verb: "Edited",
					askedPath,
					requestedPath,
					absolutePath,
					size,
					revisedPrompt: body.data?.[0]?.revised_prompt,
					writeFile: options.writeFile,
					context,
				});
			} catch (error) {
				if (error instanceof MediaRequestTimeoutError || signal?.aborted) {
					return `The image edit was stopped before it finished (the limit is ${Math.round(timeoutMs / 1000)}s).`;
				}
				options.onError?.("[edit_image] request failed", error);
				const message = error instanceof Error ? error.message : String(error);
				return `Could not reach the image endpoint: ${message}`;
			}
		},
	});
}
