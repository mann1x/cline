/**
 * The media tools as one set, built from one configuration.
 *
 * Five tools -- `generate_image`, `edit_image`, `transcribe_audio`,
 * `synthesize_speech`, `generate_video` -- share one rule for where a request
 * goes (see `media-endpoint.ts`), and two hosts offer them: the extension from
 * its settings tabs and the CLI from a file. If each host wrote its own
 * "which tools, pointed where", the two would drift the first time one of them
 * changed. So the hosts differ only in how they *read* a `MediaToolsConfig`;
 * which tools that makes, and where each one goes, is decided here.
 *
 * A section that is absent is a tool that is not wanted: it is the host's
 * "use an endpoint for ..." switch. A section that is present is offered as
 * soon as it names somewhere to go, whether or not that server answers now.
 */

import type { AgentTool } from "@cline/shared";
import {
	createSynthesizeSpeechTool,
	createTranscribeAudioTool,
	type SpeechEndpoint,
	type TranscriptionEndpoint,
} from "./audio-tools";
import { createEditImageTool } from "./image-edit";
import {
	createGenerateImageTool,
	type ImageGenerationEndpoint,
} from "./image-generation";
import {
	type MediaEndpointProbe,
	type MediaKind,
	type MediaSessionProvider,
	probeMediaEndpoint,
	type ResolvedMediaEndpoint,
	resolveMediaEndpoint,
} from "./media-endpoint";
import {
	createGenerateVideoTool,
	type VideoGenerationEndpoint,
} from "./video-generation";

/** What every media section holds. */
export interface MediaSectionSettings {
	/** Use the session's own opencoti or xOllama when it serves this. */
	useProvider?: boolean;
	/** Where requests go otherwise. */
	baseUrl?: string;
	model?: string;
	apiKey?: string;
}

export interface MediaToolsConfig {
	/** `generate_image`, and `edit_image` unless `edit` is `false`. */
	image?: MediaSectionSettings & {
		/** Default size, as `WIDTHxHEIGHT`. */
		size?: string;
		/**
		 * Edits go where generation goes unless this names another endpoint or
		 * model. `false` keeps `generate_image` without `edit_image`.
		 */
		edit?: false | { baseUrl?: string; model?: string };
	};
	/** `transcribe_audio`. */
	transcription?: MediaSectionSettings;
	/** `synthesize_speech`. */
	speech?: MediaSectionSettings & { voice?: string; format?: string };
	/** `generate_video`. */
	video?: MediaSectionSettings & {
		size?: string;
		seconds?: number;
		format?: string;
	};
}

export const MEDIA_TOOL_NAMES = [
	"generate_image",
	"edit_image",
	"transcribe_audio",
	"synthesize_speech",
	"generate_video",
] as const;
export type MediaToolName = (typeof MEDIA_TOOL_NAMES)[number];

interface MediaToolEndpoints {
	generate_image: ImageGenerationEndpoint;
	edit_image: ImageGenerationEndpoint;
	transcribe_audio: TranscriptionEndpoint;
	synthesize_speech: SpeechEndpoint;
	generate_video: VideoGenerationEndpoint;
}

export type ResolvedMediaTool<T extends MediaToolName = MediaToolName> =
	| (Omit<Exclude<ResolvedMediaEndpoint, { disabled: string }>, "endpoint"> & {
			endpoint: MediaToolEndpoints[T];
	  })
	| { disabled: string };

export type MediaProbe = (
	baseUrl: string,
	apiKey: string | undefined,
) => Promise<MediaEndpointProbe | undefined>;

const PROBE_TTL_MS = 30_000;
/** A server that did not answer is asked again sooner: it may be starting. */
const DEAD_PROBE_TTL_MS = 5_000;

/**
 * One probe per server for half a minute. Five tools resolve at session start,
 * and on an opencoti serving everything they all ask the same three routes.
 */
export function createMediaProbeCache(
	options: { fetchImpl?: typeof fetch; now?: () => number } = {},
): MediaProbe {
	const now = options.now ?? Date.now;
	const probes = new Map<
		string,
		{ at: number; probe: Promise<MediaEndpointProbe | undefined> }
	>();
	return (baseUrl, apiKey) => {
		const url = baseUrl.trim();
		const key = `${url}\u0000${apiKey ?? ""}`;
		const cached = probes.get(key);
		if (cached && now() - cached.at < PROBE_TTL_MS) {
			return cached.probe;
		}
		const entry = {
			at: now(),
			probe: probeMediaEndpoint(url, {
				apiKey,
				...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
			}),
		};
		probes.set(key, entry);
		void entry.probe.then((probe) => {
			if (probe === undefined && probes.get(key) === entry) {
				entry.at = now() - PROBE_TTL_MS + DEAD_PROBE_TTL_MS;
			}
		});
		return entry.probe;
	};
}

const SWITCHED_OFF: Record<MediaToolName, string> = {
	generate_image: "image generation is switched off",
	edit_image: "image editing is switched off",
	transcribe_audio: "speech-to-text is switched off",
	synthesize_speech: "text-to-speech is switched off",
	generate_video: "video generation is switched off",
};

const KINDS: Record<MediaToolName, MediaKind> = {
	generate_image: "image_generation",
	edit_image: "image_edit",
	transcribe_audio: "transcription",
	synthesize_speech: "speech",
	generate_video: "video",
};

/** The section a tool reads, as the shared resolution takes it. */
function sectionOf(
	tool: MediaToolName,
	config: MediaToolsConfig,
): MediaSectionSettings | undefined {
	switch (tool) {
		case "generate_image":
			return config.image;
		case "edit_image": {
			const image = config.image;
			if (!image || image.edit === false) {
				return undefined;
			}
			return {
				useProvider: image.useProvider,
				baseUrl: image.edit?.baseUrl?.trim() || image.baseUrl,
				model: image.edit?.model?.trim() || image.model,
				// The section has one key, sent to both endpoints.
				apiKey: image.apiKey,
			};
		}
		case "transcribe_audio":
			return config.transcription;
		case "synthesize_speech":
			return config.speech;
		case "generate_video":
			return config.video;
	}
}

/**
 * Where one media tool goes, or why it is not offered.
 *
 * The endpoint carries the section's defaults (size, voice, format, length),
 * so what comes back is what the tool's `getEndpoint` returns.
 */
export async function resolveMediaTool<T extends MediaToolName>(
	tool: T,
	config: MediaToolsConfig,
	provider: MediaSessionProvider | undefined,
	probe: MediaProbe,
): Promise<ResolvedMediaTool<T>> {
	const section = sectionOf(tool, config);
	if (!section) {
		return { disabled: SWITCHED_OFF[tool] };
	}
	const resolved = await resolveMediaEndpoint({
		kind: KINDS[tool],
		useProvider: section.useProvider === true,
		provider,
		typed: {
			baseUrl: section.baseUrl,
			model: section.model,
			apiKey: section.apiKey?.trim() || undefined,
		},
		probe,
	});
	if ("disabled" in resolved) {
		return resolved;
	}
	const defaults: Record<string, unknown> = {};
	const set = (key: string, value: unknown) => {
		if (typeof value === "string" ? value.trim() : value) {
			defaults[key] = typeof value === "string" ? value.trim() : value;
		}
	};
	if (tool === "generate_image" || tool === "edit_image") {
		set("size", config.image?.size);
	} else if (tool === "synthesize_speech") {
		set("voice", config.speech?.voice);
		set("format", config.speech?.format);
	} else if (tool === "generate_video") {
		set("size", config.video?.size);
		set("seconds", config.video?.seconds);
		set("format", config.video?.format);
	}
	return {
		...resolved,
		endpoint: { ...resolved.endpoint, ...defaults },
	} as ResolvedMediaTool<T>;
}

export interface CreateMediaToolsOptions {
	cwd: string;
	/**
	 * Read again on every call as well as at session start: a settings tab can
	 * change mid-session, and the probe behind the resolution is cached.
	 */
	getConfig: () => MediaToolsConfig;
	/** The provider the session runs on, for the sections that may use it. */
	provider?: MediaSessionProvider;
	probe?: MediaProbe;
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Must create the directory: the default paths are under `.cline/`. */
	writeFile: (absolutePath: string, data: Buffer) => Promise<void>;
	fetchImpl?: typeof fetch;
	onError?: (message: string, error: unknown) => void;
	/** One line per tool: where it goes, or why it was left out. */
	log?: (message: string) => void;
}

/**
 * The media tools this configuration offers, each pointed where it resolves.
 *
 * A tool is left out only when its section is absent or names nowhere to go.
 * An endpoint that is down, or says it lacks the kind, is offered with a
 * warning in the log: these servers are started on request.
 */
export async function createMediaTools(
	options: CreateMediaToolsOptions,
): Promise<AgentTool[]> {
	const probe =
		options.probe ?? createMediaProbeCache({ fetchImpl: options.fetchImpl });
	const resolve = <T extends MediaToolName>(tool: T) =>
		resolveMediaTool(tool, options.getConfig(), options.provider, probe);
	const endpointOf =
		<T extends MediaToolName>(tool: T) =>
		async (): Promise<MediaToolEndpoints[T] | undefined> => {
			const resolved = await resolve(tool);
			return "disabled" in resolved ? undefined : resolved.endpoint;
		};
	const shared = {
		cwd: options.cwd,
		...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
		...(options.onError ? { onError: options.onError } : {}),
	};
	const build: { [T in MediaToolName]: () => AgentTool } = {
		generate_image: () =>
			createGenerateImageTool({
				...shared,
				getEndpoint: endpointOf("generate_image"),
				writeFile: options.writeFile,
			}),
		edit_image: () =>
			createEditImageTool({
				...shared,
				getEndpoint: endpointOf("edit_image"),
				readFile: options.readFile,
				writeFile: options.writeFile,
			}),
		transcribe_audio: () =>
			createTranscribeAudioTool({
				...shared,
				getEndpoint: endpointOf("transcribe_audio"),
				readFile: options.readFile,
				writeFile: options.writeFile,
			}),
		synthesize_speech: () =>
			createSynthesizeSpeechTool({
				...shared,
				getEndpoint: endpointOf("synthesize_speech"),
				writeFile: options.writeFile,
			}),
		generate_video: () =>
			createGenerateVideoTool({
				...shared,
				getEndpoint: endpointOf("generate_video"),
				readFile: options.readFile,
				writeFile: options.writeFile,
			}),
	};

	const tools: AgentTool[] = [];
	for (const tool of MEDIA_TOOL_NAMES) {
		const resolved = await resolve(tool);
		if ("disabled" in resolved) {
			options.log?.(`${tool} omitted: ${resolved.disabled}`);
			continue;
		}
		options.log?.(
			`${tool} uses the ${resolved.source === "provider" ? "session's provider" : "typed endpoint"} (${resolved.server}), model ${resolved.endpoint.model}${resolved.warning ? `; ${resolved.warning}` : ""}`,
		);
		tools.push(build[tool]());
	}
	return tools;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function section(
	raw: unknown,
	base: MediaSectionSettings,
): MediaSectionSettings | undefined {
	// `true` is "on, with the shared settings"; `false` and absent are off.
	const given = raw === true ? {} : record(raw);
	if (!given) {
		return undefined;
	}
	const useProvider =
		typeof given.useProvider === "boolean"
			? given.useProvider
			: base.useProvider;
	const baseUrl = str(given.baseUrl) ?? base.baseUrl;
	const apiKey = str(given.apiKey) ?? base.apiKey;
	const model = str(given.model);
	return {
		...(useProvider ? { useProvider: true } : {}),
		...(baseUrl ? { baseUrl } : {}),
		...(model ? { model } : {}),
		...(apiKey ? { apiKey } : {}),
	};
}

/**
 * A `MediaToolsConfig` from a JSON document, for a host with no settings tabs.
 *
 * ```json
 * {
 *   "useProvider": true,
 *   "baseUrl": "http://127.0.0.1:8080",
 *   "image": { "model": "flux2-klein", "size": "1024x1024" },
 *   "transcription": true,
 *   "speech": { "voice": "alloy" },
 *   "video": { "baseUrl": "http://other:8090", "model": "wan2.1" }
 * }
 * ```
 *
 * The top-level `useProvider`, `baseUrl` and `apiKey` are what each section
 * starts from, since one server usually serves them all; a section overrides
 * them. A section is on when it is an object or `true`. `all: true` switches
 * every section on that the document does not mention -- the "use whatever the
 * session's provider serves" setting.
 */
export function parseMediaToolsConfig(
	raw: unknown,
	options: { all?: boolean; useProvider?: boolean } = {},
): MediaToolsConfig {
	const doc = record(raw) ?? {};
	const all = options.all === true || doc.all === true;
	const base: MediaSectionSettings = {
		...(options.useProvider === true || doc.useProvider === true
			? { useProvider: true }
			: {}),
		...(str(doc.baseUrl) ? { baseUrl: str(doc.baseUrl) } : {}),
		...(str(doc.apiKey) ? { apiKey: str(doc.apiKey) } : {}),
	};
	const on = (key: string) => (doc[key] === undefined && all ? true : doc[key]);
	const config: MediaToolsConfig = {};

	const image = section(on("image"), base);
	if (image) {
		const given = record(doc.image) ?? {};
		const edit = given.edit === false ? false : record(given.edit);
		config.image = {
			...image,
			...(str(given.size) ? { size: str(given.size) } : {}),
			...(edit === false
				? { edit: false as const }
				: edit
					? {
							edit: {
								...(str(edit.baseUrl) ? { baseUrl: str(edit.baseUrl) } : {}),
								...(str(edit.model) ? { model: str(edit.model) } : {}),
							},
						}
					: {}),
		};
	}
	const transcription = section(on("transcription"), base);
	if (transcription) {
		config.transcription = transcription;
	}
	const speech = section(on("speech"), base);
	if (speech) {
		const given = record(doc.speech) ?? {};
		config.speech = {
			...speech,
			...(str(given.voice) ? { voice: str(given.voice) } : {}),
			...(str(given.format)
				? { format: str(given.format)?.toLowerCase() }
				: {}),
		};
	}
	const video = section(on("video"), base);
	if (video) {
		const given = record(doc.video) ?? {};
		const seconds = Number(given.seconds);
		config.video = {
			...video,
			...(str(given.size) ? { size: str(given.size) } : {}),
			...(Number.isFinite(seconds) && seconds > 0 ? { seconds } : {}),
			...(str(given.format)
				? { format: str(given.format)?.toLowerCase() }
				: {}),
		};
	}
	return config;
}
