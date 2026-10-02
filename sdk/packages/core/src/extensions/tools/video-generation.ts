/**
 * A tool that makes a short video clip.
 *
 * The fourth media tool, and the one that is not a single request. An image
 * takes seconds and comes back in the response; a clip takes from most of a
 * minute to many, so the OpenAI videos API is a job: `POST {endpoint}/videos`
 * answers at once with an id, `GET {endpoint}/videos/{id}` says how far it
 * is, and `GET {endpoint}/videos/{id}/content` hands over the bytes when it is
 * done. opencoti serves exactly that (its M7.5), and keeps a finished clip for
 * ten minutes by default, so the content is fetched the moment the job
 * completes.
 *
 * A job outlives the request that made it. So a call that is stopped -- by
 * the user, or by this tool's own limit -- deletes its job, or the engine
 * would go on rendering a clip nobody is waiting for while the next request
 * queues behind it.
 */

import * as nodePath from "node:path";
import { type AgentTool, createTool } from "@cline/shared";
import {
	parseSize,
	resolveInsideWorkspace,
	sniffMediaType,
} from "./image-generation";
import {
	MediaRequestTimeoutError,
	normalizeBaseUrl,
	sendMediaRequest,
} from "./media-endpoint";

export const GENERATE_VIDEO_TOOL_NAME = "generate_video";

export const GENERATE_VIDEO_TOOL_DESCRIPTION = `Generate a short video clip from a text description and save it as a file in the workspace. Use it for a few seconds of footage you would otherwise have to ask the user to make elsewhere: a background loop, a product shot, a placeholder for a scene, an animated version of an image you already have.

The clip is written to a file and its path is returned. You cannot watch it, so tell the user where it is and let them judge it.

Arguments:
- \`prompt\` — what the clip shows: the subject, what moves and how, the camera, the style. One scene; these models do not follow a storyboard.
- \`image\` — optional workspace path of an image to start from. The clip animates it. Only some video models take one; the backend says so if it does not.
- \`path\` — where to save the clip, relative to the workspace. Optional; defaults to a file under \`.cline/generated-videos/\`.
- \`size\` — \`WxH\` in pixels, e.g. \`832x480\`. Optional; the backend has a default and supports only a few shapes.
- \`seconds\` — the length of the clip. Optional; a few seconds is what these models make, and longer costs more than proportionally.
- \`seed\` — optional integer. The same request with the same seed gives the same clip.

This is slow: a clip takes from most of a minute to many minutes, and on a hosted backend it costs money. Generate one only when the task needs it, and do not retry to "improve" a clip you have not been told is wrong.`;

export const GENERATE_VIDEO_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		prompt: {
			type: "string",
			description:
				"What the clip shows: the subject, what moves and how, the camera, the style.",
		},
		image: {
			type: "string",
			description:
				"Workspace path of an image to start from. Optional; only some video models take one.",
		},
		path: {
			type: "string",
			description:
				"Where to save the clip, relative to the workspace. Optional; defaults to a file under .cline/generated-videos/.",
		},
		size: {
			type: "string",
			description: 'Pixel size as "WIDTHxHEIGHT", e.g. "832x480". Optional.',
		},
		seconds: {
			type: "number",
			description: "The length of the clip in seconds. Optional.",
		},
		seed: {
			type: "integer",
			description:
				"Optional. The same request with the same seed gives the same clip.",
		},
	},
	required: ["prompt"],
} as const;

export interface VideoGenerationEndpoint {
	/** Base URL, with or without a trailing `/v1`. */
	baseUrl: string;
	model: string;
	apiKey?: string;
	/** Default for calls that name no size. */
	size?: string;
	/** Default for calls that name no length. */
	seconds?: number;
	/** The container to ask for, e.g. `mp4`. The engine's own when unset. */
	format?: string;
}

export interface GenerateVideoToolOptions {
	cwd: string;
	getEndpoint: () =>
		| VideoGenerationEndpoint
		| undefined
		| Promise<VideoGenerationEndpoint | undefined>;
	readFile: (absolutePath: string) => Promise<Buffer>;
	writeFile: (absolutePath: string, data: Buffer) => Promise<void>;
	fetchImpl?: typeof fetch;
	/**
	 * Milliseconds one clip may take from the request to the bytes, queueing
	 * included. Defaults to 60 minutes.
	 */
	timeoutMs?: number;
	/** Milliseconds between two looks at the job. Defaults to 5 seconds. */
	pollMs?: number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	onError?: (message: string, error: unknown) => void;
}

/** The video object, as far as this tool reads it. */
interface VideoJob {
	id?: string;
	status?: string;
	progress?: number;
	seconds?: string | number;
	size?: string;
	fps?: number;
	frames?: number;
	queue_position?: number;
	error?: { code?: string; message?: string } | null;
}

/**
 * What the bytes are, according to the bytes, as a file extension.
 *
 * The engine decides the container: opencoti answers mp4 with its codec
 * sidecar loaded and AVI without it, whatever the file was going to be called.
 */
export function sniffVideoExtension(data: Buffer): string | undefined {
	if (data.length < 12) {
		return undefined;
	}
	if (data.subarray(4, 8).toString("latin1") === "ftyp") {
		return data.subarray(8, 11).toString("latin1") === "qt " ? ".mov" : ".mp4";
	}
	if (
		data[0] === 0x1a &&
		data[1] === 0x45 &&
		data[2] === 0xdf &&
		data[3] === 0xa3
	) {
		return ".webm";
	}
	if (
		data.subarray(0, 4).toString("latin1") === "RIFF" &&
		data.subarray(8, 12).toString("latin1") === "AVI "
	) {
		return ".avi";
	}
	if (data.subarray(0, 6).toString("latin1").startsWith("GIF8")) {
		return ".gif";
	}
	return undefined;
}

const VIDEO_EXTENSIONS: Record<string, string> = {
	"video/mp4": ".mp4",
	"video/webm": ".webm",
	"video/x-msvideo": ".avi",
	"video/avi": ".avi",
	"video/quicktime": ".mov",
	"image/gif": ".gif",
};

/** A filename that says what the clip shows. */
export function defaultVideoPath(prompt: string, now: number): string {
	const slug =
		prompt
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.split("-")
			.filter(Boolean)
			.slice(0, 6)
			.join("-") || "video";
	return nodePath.posix.join(
		".cline",
		"generated-videos",
		`${slug}-${now}.mp4`,
	);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function positive(value: unknown): number | undefined {
	const number =
		typeof value === "number"
			? value
			: typeof value === "string" && value.trim()
				? Number(value)
				: Number.NaN;
	return Number.isFinite(number) && number > 0 ? number : undefined;
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});
}

async function errorDetail(response: Response): Promise<string> {
	const raw = (await response.text().catch(() => "")).slice(0, 600);
	try {
		const parsed = JSON.parse(raw) as {
			error?: { message?: unknown } | string;
		};
		const message =
			typeof parsed.error === "string" ? parsed.error : parsed.error?.message;
		if (typeof message === "string" && message) {
			return message;
		}
	} catch {
		// Not JSON: the text is the detail.
	}
	return raw;
}

/** How many looks at a job may fail in a row before the tool gives up on it. */
const MAX_POLL_FAILURES = 5;

/**
 * Create the `generate_video` tool.
 *
 * Like the other media tools, the host leaves it out when nothing is
 * configured, and `getEndpoint` returning nothing is handled anyway.
 */
export function createGenerateVideoTool(
	options: GenerateVideoToolOptions,
): AgentTool {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 60 * 60_000;
	const pollMs = options.pollMs ?? 5_000;
	const sleep = options.sleep ?? sleepFor;

	return createTool({
		name: GENERATE_VIDEO_TOOL_NAME,
		description: GENERATE_VIDEO_TOOL_DESCRIPTION,
		inputSchema: GENERATE_VIDEO_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown, context): Promise<string> => {
			const request = (input ?? {}) as Record<string, unknown>;
			const prompt = text(request.prompt);
			if (!prompt) {
				return "`generate_video` needs a `prompt`: describe what the clip shows.";
			}
			const endpoint = await options.getEndpoint();
			if (!endpoint?.baseUrl || !endpoint.model) {
				return (
					"No video generation endpoint is configured, so no clip was made. " +
					"The user names one on the Video tab of the API configuration settings; " +
					"tell them that rather than trying again."
				);
			}

			const imagePath = text(request.image);
			let reference:
				| { name: string; data: Buffer; mediaType: string }
				| undefined;
			if (imagePath) {
				const absoluteImage = resolveInsideWorkspace(options.cwd, imagePath);
				if (!absoluteImage) {
					return `\`${imagePath}\` is outside the workspace. Start from an image that is under the project.`;
				}
				let data: Buffer;
				try {
					data = await options.readFile(absoluteImage);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					return `Could not read \`${imagePath}\`: ${message}`;
				}
				const mediaType = sniffMediaType(data);
				if (!mediaType) {
					return `\`${imagePath}\` is not an image this tool can send (PNG, JPEG, WebP, GIF or BMP).`;
				}
				reference = { name: nodePath.basename(absoluteImage), data, mediaType };
			}

			const askedPath = text(request.path) || undefined;
			const requestedPath = askedPath ?? defaultVideoPath(prompt, Date.now());
			if (!resolveInsideWorkspace(options.cwd, requestedPath)) {
				return `\`${requestedPath}\` is outside the workspace. Save the clip somewhere under the project.`;
			}

			const size = parseSize(request.size) ?? parseSize(endpoint.size);
			const seconds = positive(request.seconds) ?? positive(endpoint.seconds);
			const seed =
				typeof request.seed === "number" && Number.isInteger(request.seed)
					? request.seed
					: undefined;
			const format = text(endpoint.format).toLowerCase().replace(/^\./, "");

			const base = normalizeBaseUrl(endpoint.baseUrl);
			const auth: Record<string, string> = endpoint.apiKey
				? { Authorization: `Bearer ${endpoint.apiKey}` }
				: {};
			const callerSignal = context?.signal;
			// One clock for the whole clip: the request, the queue, the render and
			// the download. A stop from the caller and the clock running out end
			// it the same way, and both delete the job.
			const deadline = new AbortController();
			const timer = setTimeout(() => deadline.abort(), timeoutMs);
			const onCallerAbort = () => deadline.abort();
			callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
			if (callerSignal?.aborted) deadline.abort();
			const signal = deadline.signal;
			const stopped = () =>
				`The video generation was stopped before it finished (the limit is ${Math.round(timeoutMs / 60_000)} min).`;

			let jobId: string | undefined;
			let finished = false;
			try {
				const create = (outputFormat: string | undefined) =>
					sendMediaRequest(
						`${base}/videos`,
						(): RequestInit => {
							if (!reference) {
								return {
									method: "POST",
									headers: { "Content-Type": "application/json", ...auth },
									body: JSON.stringify({
										model: endpoint.model,
										prompt,
										...(size ? { size } : {}),
										// A string, as OpenAI's own API takes it.
										...(seconds ? { seconds: String(seconds) } : {}),
										...(seed !== undefined ? { seed } : {}),
										...(outputFormat ? { output_format: outputFormat } : {}),
									}),
								};
							}
							const form = new FormData();
							form.append("model", endpoint.model);
							form.append("prompt", prompt);
							if (size) form.append("size", size);
							if (seconds) form.append("seconds", String(seconds));
							if (seed !== undefined) form.append("seed", String(seed));
							if (outputFormat) form.append("output_format", outputFormat);
							form.append(
								"input_reference",
								new Blob([new Uint8Array(reference.data)], {
									type: reference.mediaType,
								}),
								reference.name,
							);
							// No Content-Type: fetch writes the multipart boundary.
							return { method: "POST", headers: auth, body: form };
						},
						{
							fetchImpl,
							signal,
							onBusy: (waitMs) =>
								context?.emitUpdate?.({
									status: `The video engine's queue is full; asking again in ${Math.round(waitMs / 1000)}s.`,
								}),
						},
					);

				let created = await create(format || undefined);
				// The container is the engine's to refuse: opencoti without its
				// codec sidecar has no mp4. The clip is what was wanted, so ask
				// again for whatever it does write.
				if (format && (created.status === 400 || created.status === 501)) {
					const refusal = await created
						.clone()
						.text()
						.catch(() => "");
					if (/output_format|\bformat\b|codec/i.test(refusal)) {
						created = await create(undefined);
					}
				}
				if (created.status === 503) {
					return "The video engine's queue is still full after a long wait, so no clip was made. Nothing is wrong with the request; try again later.";
				}
				if (!created.ok) {
					const detail = await errorDetail(created);
					return `The video endpoint refused the request (HTTP ${created.status}).${detail ? `\n\n${detail}` : ""}`;
				}
				let job = (await created.json()) as VideoJob;
				if (!job.id) {
					return "The video endpoint accepted the request but returned no job id, so there is no clip to wait for.";
				}
				jobId = job.id;

				let lastStatus = "";
				let failures = 0;
				while (job.status !== "completed") {
					if (job.status === "failed" || job.status === "cancelled") {
						finished = true;
						const reason = job.error?.message || job.error?.code || "";
						return `The video engine ${job.status === "cancelled" ? "cancelled" : "failed"} the clip${reason ? `: ${reason}` : "."}`;
					}
					const status =
						job.status === "queued"
							? `Waiting for the video engine${job.queue_position ? ` (${job.queue_position} ahead)` : ""}.`
							: `Rendering the clip${typeof job.progress === "number" ? `: ${Math.round(job.progress)}%` : ""}.`;
					if (status !== lastStatus) {
						lastStatus = status;
						context?.emitUpdate?.({ status });
					}
					await sleep(pollMs, signal);
					if (signal.aborted) {
						return stopped();
					}
					try {
						const polled = await fetchImpl(
							`${base}/videos/${encodeURIComponent(jobId)}`,
							{
								headers: auth,
								signal,
							},
						);
						if (polled.status === 404 || polled.status === 410) {
							finished = true;
							return `The video endpoint no longer has the job (HTTP ${polled.status}), so the clip is lost. ${await errorDetail(polled)}`.trim();
						}
						if (!polled.ok) {
							throw new Error(`HTTP ${polled.status}`);
						}
						job = (await polled.json()) as VideoJob;
						failures = 0;
					} catch (error) {
						if (signal.aborted) {
							return stopped();
						}
						// The job runs on the server whether or not one look at it
						// got through, so a dropped poll is not a failed clip.
						failures += 1;
						if (failures >= MAX_POLL_FAILURES) {
							throw error;
						}
					}
				}

				const content = await fetchImpl(
					`${base}/videos/${encodeURIComponent(jobId)}/content`,
					{ headers: auth, signal },
				);
				if (!content.ok) {
					const detail = await errorDetail(content);
					return `The clip was rendered but could not be downloaded (HTTP ${content.status}).${detail ? `\n\n${detail}` : ""}`;
				}
				const data = Buffer.from(await content.arrayBuffer());
				finished = true;
				if (data.length === 0) {
					return "The video endpoint returned an empty clip.";
				}

				const header = (content.headers.get("content-type") ?? "")
					.split(";")[0]
					.trim()
					.toLowerCase();
				const extension =
					sniffVideoExtension(data) ?? VIDEO_EXTENSIONS[header] ?? ".mp4";
				const current = nodePath.extname(requestedPath);
				const savedPath =
					current.toLowerCase() === extension
						? requestedPath
						: `${current ? requestedPath.slice(0, -current.length) : requestedPath}${extension}`;
				const absoluteSaved = resolveInsideWorkspace(options.cwd, savedPath);
				if (!absoluteSaved) {
					return `\`${savedPath}\` is outside the workspace. Save the clip somewhere under the project.`;
				}
				await options.writeFile(absoluteSaved, data);

				const length = positive(job.seconds);
				const facts = [
					extension.slice(1),
					job.size || size,
					length ? `${length} s` : undefined,
					job.fps ? `${job.fps} fps` : undefined,
					data.length >= 1024 * 1024
						? `${(data.length / (1024 * 1024)).toFixed(1)} MB`
						: `${Math.max(1, Math.round(data.length / 1024))} KB`,
				].filter(Boolean);
				const notes: string[] = [];
				if (format && extension.slice(1) !== format) {
					notes.push(
						`The backend wrote ${extension.slice(1)}, not the ${format} that was asked for.`,
					);
				}
				if (askedPath && savedPath !== askedPath) {
					notes.push(
						`The file was saved as \`${savedPath}\` so its name matches its contents.`,
					);
				}
				return (
					`Generated and saved to \`${savedPath}\` (${facts.join(", ")}).` +
					`${notes.length ? `\n\n${notes.join(" ")}` : ""}`
				);
			} catch (error) {
				if (error instanceof MediaRequestTimeoutError || signal.aborted) {
					return stopped();
				}
				options.onError?.("[generate_video] request failed", error);
				const message = error instanceof Error ? error.message : String(error);
				return `Could not reach the video endpoint: ${message}`;
			} finally {
				clearTimeout(timer);
				callerSignal?.removeEventListener("abort", onCallerAbort);
				// A job nobody is waiting for still holds the engine. Deleting a
				// finished one is left to the server's own expiry.
				if (jobId && !finished) {
					void fetchImpl(`${base}/videos/${encodeURIComponent(jobId)}`, {
						method: "DELETE",
						headers: auth,
						signal: AbortSignal.timeout(10_000),
					}).catch(() => {});
				}
			}
		},
	});
}
