/**
 * A tool that makes a picture.
 *
 * Cline can write the CSS for a theme and the loader for a sprite, and then has
 * nothing to say about what either one looks like. Every visual question --
 * "which of these layouts", "an icon for this app", "a placeholder texture" --
 * left the session: the user generated the asset somewhere else and came back
 * with a path. That is the gap mann1x/cline#53 describes.
 *
 * The half of it that already worked is the display: a tool result may carry an
 * `image` content part, the browser tool has returned screenshots that way for
 * a while, and the webview renders them inline. What was missing was anything
 * that produces one.
 *
 * The wire format is the OpenAI images API (`POST {endpoint}/images/generations`)
 * because it is the one every local server already speaks -- LocalAI, an
 * Automatic1111 or ComfyUI shim, a llama.cpp image build -- as well as the
 * hosted services. Deliberately not Ollama-specific: this fork's own Ollama
 * refuses image models outright ("image generation models are not currently
 * supported"), so a tool that only spoke to Ollama would have no backend at all
 * on Linux.
 */

import * as nodePath from "node:path";
import { type AgentTool, createTool } from "@cline/shared";

/**
 * A text part, optionally followed by an image the model can actually see.
 *
 * Declared here as it is in `browser.ts`, and for the same reason: this is the
 * shape a tool result takes, not something `@cline/shared` publishes.
 */
type ToolOutput =
	| string
	| Array<
			| { type: "text"; text: string }
			| { type: "image"; data: string; mediaType: string }
	  >;

export const GENERATE_IMAGE_TOOL_NAME = "generate_image";

export const GENERATE_IMAGE_TOOL_DESCRIPTION = `Generate an image from a text description and save it into the workspace. Use it for visual work you would otherwise have to ask the user to do elsewhere: an app icon, a placeholder texture or sprite, a logo, a background, or a mockup of a layout or theme you are about to build.

The image is written to a file and, if you can see images, returned to you as well — so you can look at what you made and generate again with a changed prompt if it is wrong.

Arguments:
- \`prompt\` — what to draw. Describe the subject, the style and the background. Say "flat vector icon, solid background, no text" rather than "an icon": these models render text badly, so ask for lettering only when you must.
- \`path\` — where to save it, relative to the workspace. Optional; defaults to a file under \`.cline/generated-images/\`. Give a real path when the image is an asset the project will use.
- \`size\` — \`WxH\` in pixels, e.g. \`1024x1024\`. Optional, and the backend may round it.

This costs real time — seconds to a minute per image — and on a hosted backend it costs money. Generate one image and look at it before generating variations.`;

export const GENERATE_IMAGE_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		prompt: {
			type: "string",
			description:
				"What to draw, including style and background. Be specific; avoid asking for text in the image.",
		},
		path: {
			type: "string",
			description:
				"Where to save it, relative to the workspace. Optional; defaults to a file under .cline/generated-images/.",
		},
		size: {
			type: "string",
			description: 'Pixel size as "WIDTHxHEIGHT", e.g. "1024x1024". Optional.',
		},
	},
	required: ["prompt"],
} as const;

export interface GenerateImageToolInput {
	prompt?: unknown;
	path?: unknown;
	size?: unknown;
}

/**
 * Where images are generated and what to call the model there.
 *
 * Read per call rather than captured once: the settings behind these can change
 * mid-session, and a tool built at session start would go on using the endpoint
 * that was configured then.
 */
export interface ImageGenerationEndpoint {
	/** Base URL, with or without a trailing `/v1`. */
	baseUrl: string;
	model: string;
	apiKey?: string;
	/** Default for calls that do not ask for a size. */
	size?: string;
}

export interface GenerateImageToolOptions {
	cwd: string;
	getEndpoint: () => ImageGenerationEndpoint | undefined;
	writeFile: (absolutePath: string, data: Buffer) => Promise<void>;
	fetchImpl?: typeof fetch;
	/** Milliseconds before a generation is abandoned. Defaults to 3 minutes. */
	timeoutMs?: number;
	onError?: (message: string, error: unknown) => void;
}

/** `.../v1`, whether or not the user typed it. */
export function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/**
 * A filename that says what the image is.
 *
 * From the prompt rather than a counter, because these accumulate in a
 * directory nobody curates and `image-4.png` tells you nothing a month later.
 */
export function defaultImagePath(prompt: string, now: number): string {
	const slug =
		prompt
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.split("-")
			.filter(Boolean)
			.slice(0, 6)
			.join("-") || "image";
	return nodePath.posix.join(
		".cline",
		"generated-images",
		`${slug}-${now}.png`,
	);
}

/**
 * Keep the written file inside the workspace.
 *
 * The path comes from the model, and `../../.ssh/authorized_keys` is a path.
 * Resolved and compared rather than pattern-matched, so a symlinked prefix or a
 * doubled separator cannot slip past.
 */
export function resolveInsideWorkspace(
	cwd: string,
	relativePath: string,
): string | undefined {
	const resolved = nodePath.resolve(cwd, relativePath);
	const root = nodePath.resolve(cwd);
	const withSeparator = root.endsWith(nodePath.sep)
		? root
		: `${root}${nodePath.sep}`;
	return resolved === root || resolved.startsWith(withSeparator)
		? resolved
		: undefined;
}

/** `"1024x1024"` and nothing else -- a backend given nonsense returns nonsense. */
export function parseSize(size: unknown): string | undefined {
	if (typeof size !== "string") {
		return undefined;
	}
	const match = /^\s*(\d{2,5})\s*[x×]\s*(\d{2,5})\s*$/i.exec(size);
	return match ? `${match[1]}x${match[2]}` : undefined;
}

interface ImagesApiResponse {
	data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
	error?: { message?: string } | string;
}

/**
 * Pull the bytes out of whatever the server sent back.
 *
 * `b64_json` is asked for, but plenty of servers ignore `response_format` and
 * return a URL regardless, so both are handled. A response with neither is a
 * failure worth naming rather than an empty file.
 */
export async function readGeneratedImage(
	body: ImagesApiResponse,
	fetchImpl: typeof fetch,
	signal: AbortSignal | undefined,
): Promise<{ data: Buffer; mediaType: string } | { error: string }> {
	const entry = body.data?.[0];
	if (!entry) {
		const message =
			typeof body.error === "string" ? body.error : body.error?.message;
		return {
			error: message
				? `The image endpoint returned an error: ${message}`
				: "The image endpoint returned no image.",
		};
	}
	if (entry.b64_json) {
		return {
			data: Buffer.from(entry.b64_json, "base64"),
			mediaType: "image/png",
		};
	}
	if (entry.url) {
		// A data URL is a URL, and some shims answer with one.
		const inline = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(entry.url);
		if (inline) {
			return {
				data: Buffer.from(inline[2], "base64"),
				mediaType: inline[1],
			};
		}
		const response = await fetchImpl(entry.url, { signal });
		if (!response.ok) {
			return {
				error: `The image endpoint returned a URL that could not be fetched (HTTP ${response.status}).`,
			};
		}
		const mediaType = response.headers.get("content-type") ?? "image/png";
		return {
			data: Buffer.from(await response.arrayBuffer()),
			mediaType: mediaType.split(";")[0].trim(),
		};
	}
	return {
		error:
			"The image endpoint returned an entry with neither image data nor a URL.",
	};
}

/**
 * Create the `generate_image` tool.
 *
 * The host is expected to omit this tool entirely when no endpoint is
 * configured; `getEndpoint` returning nothing is handled anyway, because the
 * setting can be cleared while a session is running and the model would
 * otherwise get a stack trace where an explanation belongs.
 */
export function createGenerateImageTool(
	options: GenerateImageToolOptions,
): AgentTool {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 180_000;

	return createTool({
		name: GENERATE_IMAGE_TOOL_NAME,
		description: GENERATE_IMAGE_TOOL_DESCRIPTION,
		inputSchema: GENERATE_IMAGE_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown, context): Promise<ToolOutput> => {
			const request = (input ?? {}) as GenerateImageToolInput;
			const prompt =
				typeof request.prompt === "string" ? request.prompt.trim() : "";
			if (!prompt) {
				return "`generate_image` needs a `prompt`: describe what to draw, including the style and the background.";
			}

			const endpoint = options.getEndpoint();
			if (!endpoint?.baseUrl || !endpoint.model) {
				return (
					"No image generation endpoint is configured, so no image was generated. " +
					"The user sets `cline.imageGeneration.endpoint` and `cline.imageGeneration.model` in VS Code settings; " +
					"tell them that rather than trying again."
				);
			}

			const requestedPath =
				typeof request.path === "string" && request.path.trim()
					? request.path.trim()
					: defaultImagePath(prompt, Date.now());
			const absolutePath = resolveInsideWorkspace(options.cwd, requestedPath);
			if (!absolutePath) {
				return `\`${requestedPath}\` is outside the workspace. Save the image somewhere under the project.`;
			}

			const size = parseSize(request.size) ?? parseSize(endpoint.size);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			// The caller's cancellation has to reach the request too, or a
			// stopped task sits waiting on a minute of image generation.
			const onAbort = () => controller.abort();
			context?.signal?.addEventListener("abort", onAbort);

			try {
				const response = await fetchImpl(
					`${normalizeBaseUrl(endpoint.baseUrl)}/images/generations`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							...(endpoint.apiKey
								? { Authorization: `Bearer ${endpoint.apiKey}` }
								: {}),
						},
						body: JSON.stringify({
							model: endpoint.model,
							prompt,
							n: 1,
							response_format: "b64_json",
							...(size ? { size } : {}),
						}),
						signal: controller.signal,
					},
				);

				if (!response.ok) {
					const detail = (await response.text().catch(() => "")).slice(0, 400);
					return `The image endpoint refused the request (HTTP ${response.status}).${detail ? `\n\n${detail}` : ""}`;
				}

				const body = (await response.json()) as ImagesApiResponse;
				const image = await readGeneratedImage(
					body,
					fetchImpl,
					controller.signal,
				);
				if ("error" in image) {
					return image.error;
				}

				await options.writeFile(absolutePath, image.data);

				const text =
					`Generated and saved to \`${requestedPath}\`` +
					`${size ? ` (${size})` : ""}.` +
					`${body.data?.[0]?.revised_prompt ? `\n\nThe backend rewrote the prompt as: ${body.data[0].revised_prompt}` : ""}`;

				// Same rule the browser tool applies to screenshots: an image
				// sent to a text-only model spends the context window on
				// something it cannot read.
				if (context?.metadata?.modelSupportsImages !== true) {
					return `${text}\n\nYou cannot see images, so look at the file only if you need to — describe what you asked for when reporting this.`;
				}
				return [
					{ type: "text", text },
					{
						type: "image",
						data: image.data.toString("base64"),
						mediaType: image.mediaType,
					},
				];
			} catch (error) {
				if (controller.signal.aborted) {
					return `Image generation was stopped before it finished (the limit is ${Math.round(timeoutMs / 1000)}s).`;
				}
				options.onError?.("[generate_image] request failed", error);
				const message = error instanceof Error ? error.message : String(error);
				return `Could not reach the image endpoint: ${message}`;
			} finally {
				clearTimeout(timer);
				context?.signal?.removeEventListener("abort", onAbort);
			}
		},
	});
}
