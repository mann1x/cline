/**
 * Where a media tool sends its request, and whether it should exist at all.
 *
 * `generate_image` had its own answer to this -- a typed URL, a typed model --
 * and four more tools need one: image edits, transcription, speech and video.
 * They share everything but the route: the same OpenAI-shaped servers, the same
 * question of what a server serves, the same `503` while an engine is busy.
 *
 * Three kinds of server answer these routes, and they say different amounts:
 *  - **opencoti** names what is loaded in `features` on `/props`
 *    (`images_generate_v1`, `images_edit_v1`, `audio_transcriptions_v1`,
 *    `audio_speech_v1`, `videos_generate_v1`), and its `/v1/models` rows carry
 *    `capabilities`. One process can serve the LLM and every media kind.
 *  - **xOllama** answers `/api/xollama`, and its `/v1/models` rows carry
 *    `input_modalities` / `output_modalities` for models with media.
 *  - anything else that lists `/v1/models` says nothing, and nothing is not
 *    "no": such a server is taken to serve whatever it is asked for.
 *
 * The owner's rule for which endpoint a tool uses (2026-10-02):
 *  1. with the "use the configured provider" flag on, the session's own
 *     opencoti or xOllama provider, when it serves this kind;
 *  2. otherwise the typed URL;
 *  3. a typed URL that is empty, or an endpoint that does not answer, means the
 *     tool is not offered.
 */

export type MediaKind =
	| "image_generation"
	| "image_edit"
	| "transcription"
	| "speech"
	| "video";

export const MEDIA_KINDS: readonly MediaKind[] = [
	"image_generation",
	"image_edit",
	"transcription",
	"speech",
	"video",
];

export type MediaServer = "opencoti" | "xollama" | "openai";

export interface MediaEndpoint {
	/** Base URL, with or without a trailing `/v1`. */
	baseUrl: string;
	model: string;
	apiKey?: string;
}

export interface MediaModel {
	id: string;
	/** What the server says this model serves. Absent when it says nothing. */
	kinds?: MediaKind[];
}

export interface MediaEndpointProbe {
	server: MediaServer;
	/**
	 * `true` served, `false` the server says it is not, absent unknown. Only
	 * opencoti and xOllama ever say `false`.
	 */
	kinds: Partial<Record<MediaKind, boolean>>;
	models: MediaModel[];
}

/** `.../v1`, whether or not the user typed it. */
export function normalizeBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (/\/api$/.test(trimmed)) {
		return `${trimmed.slice(0, -"/api".length)}/v1`;
	}
	return /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** The server's root, under which `/props` and `/api/xollama` live. */
export function mediaServerOrigin(baseUrl: string): string {
	return baseUrl
		.trim()
		.replace(/\/+$/, "")
		.replace(/\/(?:v\d+|api)$/, "");
}

const OPENCOTI_FEATURES: Record<string, MediaKind> = {
	images_generate_v1: "image_generation",
	images_edit_v1: "image_edit",
	audio_transcriptions_v1: "transcription",
	audio_speech_v1: "speech",
	videos_generate_v1: "video",
};

/** Both servers' names for a capability, as one. */
const CAPABILITY_KINDS: Record<string, MediaKind> = {
	image_generation: "image_generation",
	image_edit: "image_edit",
	transcription: "transcription",
	audio_transcription: "transcription",
	speech: "speech",
	audio_speech: "speech",
	video: "video",
	video_generation: "video",
};

function strings(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((entry): entry is string => typeof entry === "string")
		: [];
}

/**
 * What one `/v1/models` row says it serves, or nothing when it says nothing.
 *
 * Capabilities are exact and win. Modalities are xOllama's listing and need
 * reading: an edit model takes an image and returns one, a transcription model
 * takes audio and returns text.
 */
export function mediaKindsOfModelRow(row: unknown): MediaKind[] | undefined {
	const entry = row as {
		capabilities?: unknown;
		input_modalities?: unknown;
		output_modalities?: unknown;
	};
	const kinds = new Set<MediaKind>();
	const capabilities = strings(entry?.capabilities);
	for (const capability of capabilities) {
		const kind = CAPABILITY_KINDS[capability];
		if (kind) kinds.add(kind);
	}
	const hasModalities =
		Array.isArray(entry?.input_modalities) ||
		Array.isArray(entry?.output_modalities);
	if (kinds.size === 0 && hasModalities) {
		const input = strings(entry.input_modalities);
		const output = strings(entry.output_modalities);
		if (output.includes("image")) {
			kinds.add("image_generation");
			if (input.includes("image")) kinds.add("image_edit");
		}
		if (output.includes("audio")) kinds.add("speech");
		if (input.includes("audio") && output.includes("text")) {
			kinds.add("transcription");
		}
		if (output.includes("video")) kinds.add("video");
	}
	if (Array.isArray(entry?.capabilities) || hasModalities) {
		return [...kinds];
	}
	return undefined;
}

function modelsOfListing(payload: unknown): MediaModel[] {
	const data = (payload as { data?: unknown })?.data;
	if (!Array.isArray(data)) return [];
	const models = new Map<string, MediaModel>();
	for (const row of data) {
		const id = (row as { id?: unknown })?.id;
		if (typeof id !== "string" || !id.trim()) continue;
		const kinds = mediaKindsOfModelRow(row);
		models.set(id.trim(), { id: id.trim(), ...(kinds ? { kinds } : {}) });
	}
	return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export interface MediaProbeOptions {
	apiKey?: string;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	/** Milliseconds each of the three reads may take. Defaults to 5 seconds. */
	timeoutMs?: number;
}

async function readJson(
	url: string,
	options: MediaProbeOptions,
): Promise<unknown | undefined> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? 5_000,
	);
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort);
	try {
		const response = await fetchImpl(url, {
			headers: options.apiKey
				? { Authorization: `Bearer ${options.apiKey}` }
				: {},
			signal: controller.signal,
		});
		return response.ok ? await response.json() : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * What answers at `baseUrl` and what it serves, or nothing when nothing does.
 *
 * Three reads at once rather than one after another: the picker waits on this,
 * and two of the three are 404s on any given server.
 */
export async function probeMediaEndpoint(
	baseUrl: string,
	options: MediaProbeOptions = {},
): Promise<MediaEndpointProbe | undefined> {
	if (!baseUrl.trim()) return undefined;
	const origin = mediaServerOrigin(baseUrl);
	const [props, xollama, listing] = await Promise.all([
		readJson(`${origin}/props`, options),
		readJson(`${origin}/api/xollama`, options),
		readJson(`${normalizeBaseUrl(baseUrl)}/models`, options),
	]);
	const models = modelsOfListing(listing);

	if ((xollama as { xollama?: unknown })?.xollama === true) {
		// xOllama says what each model serves, so a model with no media row
		// serves none, and a kind no model serves is not served.
		const kinds: Partial<Record<MediaKind, boolean>> = {};
		for (const kind of MEDIA_KINDS) {
			kinds[kind] = models.some((model) => model.kinds?.includes(kind));
		}
		return {
			server: "xollama",
			kinds,
			models: models.map((model) => ({ ...model, kinds: model.kinds ?? [] })),
		};
	}

	const features = (props as { features?: unknown })?.features;
	const buildInfo = (props as { build_info?: unknown })?.build_info;
	const isOpencoti =
		Array.isArray(features) &&
		((typeof buildInfo === "string" && buildInfo.includes("opencoti")) ||
			typeof (props as { opencoti?: unknown })?.opencoti === "object" ||
			strings(features).some((feature) => feature in OPENCOTI_FEATURES));
	if (isOpencoti) {
		const kinds: Partial<Record<MediaKind, boolean>> = {};
		for (const kind of MEDIA_KINDS) kinds[kind] = false;
		for (const feature of strings(features)) {
			const kind = OPENCOTI_FEATURES[feature];
			if (kind) kinds[kind] = true;
		}
		return { server: "opencoti", kinds, models };
	}

	if (listing === undefined) return undefined;
	return { server: "openai", kinds: {}, models };
}

/**
 * The models to offer in a picker for one kind: those the server says serve
 * it, and those it says nothing about.
 */
export function listMediaModels(
	probe: MediaEndpointProbe,
	kind: MediaKind,
): string[] {
	return probe.models
		.filter((model) => model.kinds === undefined || model.kinds.includes(kind))
		.map((model) => model.id);
}

/** The session's own provider, as far as a media tool cares. */
export interface MediaSessionProvider {
	providerId: string;
	baseUrl?: string;
	apiKey?: string;
	modelId?: string;
}

export interface ResolveMediaEndpointInput {
	kind: MediaKind;
	/** The tab's "use the configured opencoti or xOllama provider" flag. */
	useProvider: boolean;
	provider?: MediaSessionProvider;
	/** What the tab holds: the typed URL, and the model named for this kind. */
	typed?: { baseUrl?: string; model?: string; apiKey?: string };
	probe: (
		baseUrl: string,
		apiKey: string | undefined,
	) => Promise<MediaEndpointProbe | undefined>;
}

export type ResolvedMediaEndpoint =
	| {
			endpoint: MediaEndpoint;
			source: "provider" | "typed";
			server: MediaServer;
	  }
	| { disabled: string };

/**
 * The model to ask on the session's provider: the one the tab names, then the
 * session's own, then the only one there is. Never a guess among several.
 */
function providerModel(
	probe: MediaEndpointProbe,
	kind: MediaKind,
	named: string | undefined,
	sessionModel: string | undefined,
): string | undefined {
	const serving = probe.models.filter((model) => model.kinds?.includes(kind));
	const serves = (id: string | undefined) =>
		id ? serving.find((model) => model.id === id)?.id : undefined;
	if (serves(named)) return named;
	if (serves(sessionModel)) return sessionModel;
	if (serving.length === 1) return serving[0]?.id;
	// opencoti loads one engine per kind, and an older build's listing may not
	// carry capabilities: the feature flag already said the kind is served.
	if (probe.server === "opencoti" && serving.length === 0) {
		return named || sessionModel;
	}
	return undefined;
}

export async function resolveMediaEndpoint(
	input: ResolveMediaEndpointInput,
): Promise<ResolvedMediaEndpoint> {
	const named = input.typed?.model?.trim() || undefined;
	const provider = input.provider;
	// Said instead of "no endpoint is configured" when the provider does serve
	// this and only the choice of model is missing: that is what to fix.
	let unnamed: string | undefined;
	if (input.useProvider && provider?.baseUrl?.trim()) {
		const probe = await input.probe(provider.baseUrl, provider.apiKey);
		if (
			probe &&
			probe.server !== "openai" &&
			probe.kinds[input.kind] === true
		) {
			const model = providerModel(probe, input.kind, named, provider.modelId);
			if (model) {
				return {
					endpoint: {
						baseUrl: provider.baseUrl,
						model,
						...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
					},
					source: "provider",
					server: probe.server,
				};
			}
			unnamed = `the session's ${probe.server} provider serves this with several models, and none is named`;
		}
	}

	const baseUrl = input.typed?.baseUrl?.trim();
	if (!baseUrl) {
		return { disabled: unnamed ?? "no endpoint is configured" };
	}
	if (!named) {
		return { disabled: "the endpoint has no model named" };
	}
	const apiKey = input.typed?.apiKey?.trim() || undefined;
	const probe = await input.probe(baseUrl, apiKey);
	if (!probe) {
		return { disabled: `the endpoint at ${baseUrl} does not answer` };
	}
	if (probe.kinds[input.kind] === false) {
		return {
			disabled: `the ${probe.server} server at ${baseUrl} does not serve this`,
		};
	}
	return {
		endpoint: { baseUrl, model: named, ...(apiKey ? { apiKey } : {}) },
		source: "typed",
		server: probe.server,
	};
}

/** `Retry-After` in milliseconds: seconds or a date, bounded, 5 s by default. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
	const fallback = 5_000;
	const longest = 60_000;
	if (!header) return fallback;
	const seconds = Number(header);
	if (Number.isFinite(seconds)) {
		return Math.min(longest, Math.max(1_000, seconds * 1_000));
	}
	const at = Date.parse(header);
	return Number.isFinite(at)
		? Math.min(longest, Math.max(1_000, at - now))
		: fallback;
}

export interface MediaRequestOptions {
	fetchImpl?: typeof fetch;
	/** The caller's cancellation. The only thing that ends the waiting. */
	signal?: AbortSignal;
	/**
	 * Milliseconds one attempt may take. Waiting on a busy engine is not
	 * counted: the limit is on the work, not on the queue in front of it.
	 */
	attemptTimeoutMs?: number;
	/**
	 * How long to keep asking a busy engine, 30 minutes by default. xOllama
	 * answers `503` only once 16 requests wait or one has waited 10 minutes, so
	 * this is several full queues; past it the `503` is handed back, and the
	 * tool says the engine is still busy rather than that it failed.
	 */
	maxBusyMs?: number;
	/** Told each time the engine was busy, before the wait. */
	onBusy?: (waitMs: number, attempt: number) => void;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** An attempt ran past `attemptTimeoutMs`. */
export class MediaRequestTimeoutError extends Error {
	constructor(readonly timeoutMs: number) {
		super(`the request took longer than ${Math.round(timeoutMs / 1000)}s`);
		this.name = "MediaRequestTimeoutError";
	}
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * One media request, waited out while the engine is busy.
 *
 * opencoti and xOllama run one request per engine and answer `503` with
 * `Retry-After` to the rest. That is the server saying when to come back, not
 * a failure, so it is not handed to the model as one: the request is sent
 * again until it is taken, the caller stops, or `maxBusyMs` of waiting has
 * passed. Nothing else is retried: a `400` is a model that does not do this, a
 * `404` no such model, a `500` an engine that failed to start. `init` is a function because a
 * multipart body is spent by the attempt that sent it.
 */
export async function sendMediaRequest(
	url: string,
	init: () => RequestInit,
	options: MediaRequestOptions = {},
): Promise<Response> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const sleep = options.sleep ?? sleepFor;
	const maxBusyMs = options.maxBusyMs ?? 30 * 60_000;
	let waitedMs = 0;
	for (let attempt = 1; ; attempt += 1) {
		const controller = new AbortController();
		const onAbort = () => controller.abort(options.signal?.reason);
		if (options.signal?.aborted) onAbort();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		let timedOut = false;
		const timer = options.attemptTimeoutMs
			? setTimeout(() => {
					timedOut = true;
					controller.abort();
				}, options.attemptTimeoutMs)
			: undefined;
		let response: Response;
		try {
			response = await fetchImpl(url, {
				...init(),
				signal: controller.signal,
			});
			if (response.status !== 503 || waitedMs >= maxBusyMs) {
				// The body is read by the caller, under the same limit.
				const body = await response.arrayBuffer();
				return new Response(body, {
					status: response.status,
					statusText: response.statusText,
					headers: response.headers,
				});
			}
		} catch (error) {
			if (timedOut && options.attemptTimeoutMs) {
				throw new MediaRequestTimeoutError(options.attemptTimeoutMs);
			}
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
		}
		// Drained so the connection is released before the wait.
		await response.text().catch(() => "");
		const waitMs = retryAfterMs(response.headers.get("retry-after"));
		options.onBusy?.(waitMs, attempt);
		await sleep(waitMs, options.signal);
		waitedMs += waitMs;
	}
}
