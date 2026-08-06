// Ollama vendor backed by the native Ollama API (`/api/chat`) via the
// `ollama-ai-provider-v2` AI SDK provider.
//
// The package is vendored with a patch. Two of its contracts are wrong for a
// server that resolves thinking budgets: `think` is typed as a boolean and any
// effort level is collapsed to `true`, which on Ollama means *unbounded*; and
// the request options are a closed allowlist that silently drops anything it
// does not name, `think_budget` included. The patch widens `think` to accept a
// level and gives the options schema a catchall.
//
// Ollama cannot be driven through the generic OpenAI-compatible path
// (`/v1/chat/completions`): that endpoint ignores Ollama's proprietary
// `options.num_ctx` field, so every model loads with the server default
// context window (4096) regardless of the model's actual capacity or the
// user's configured context size. The native API accepts
// `options.num_ctx` per request; this boundary maps the provider-neutral
// model `contextWindow` onto it.

import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
	GatewayStreamRequest,
} from "@cline/shared";
import { type CallSettings, wrapLanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { buildAiSdkStreamConfig } from "../ai-sdk";
import { OLLAMA_DEFAULT_CONTEXT_WINDOW } from "../builtins";
import type { ProviderSamplingOptions } from "../config";
import { ensureFetch, resolveApiKey } from "../http";
import { createRetryEmptyResponseMiddleware } from "../middleware/retry-empty-response";
import { splitToolImagesMiddleware } from "../middleware/split-tool-images";
import type { ProviderFactoryResult } from "./types";

/** See {@link OLLAMA_DEFAULT_CONTEXT_WINDOW} — re-exported under the wire-format name. */
export const OLLAMA_DEFAULT_NUM_CTX = OLLAMA_DEFAULT_CONTEXT_WINDOW;

/**
 * Normalize a configured base URL to the `baseURL` this provider expects.
 *
 * The API prefix belongs *in* the base URL here: the package appends bare
 * paths (`/chat`, `/show`) and its own default is
 * `http://127.0.0.1:11434/api`. This is the opposite of the `ollama` client
 * the previous provider used, which took a bare origin as its `host` and
 * appended `/api/...` itself — so returning an origin sends every request to
 * `/chat`, which Ollama answers with a plain `404 page not found`.
 *
 * Users configure hosts like `http://localhost:11434` or `https://ollama.com`;
 * configs saved by the 4.0.0 OpenAI-compatible routing may carry a `/v1`
 * suffix, and native-API configs an `/api` one. All three normalize to the
 * same origin, and `/api` is then appended exactly once.
 */
export function normalizeOllamaBaseUrl(
	baseUrl: string | undefined,
): string | undefined {
	const trimmed = baseUrl?.trim().replace(/\/+$/, "");
	if (!trimmed) {
		return undefined;
	}
	return `${trimmed.replace(/\/(?:v1|api)$/, "")}/api`;
}

/**
 * Resolve the `num_ctx` to request from the resolved model's context window.
 * `num_ctx` stays an Ollama wire-format detail: callers express intent through
 * the provider-neutral model `contextWindow` (from the model catalog or the
 * user's configured context window), and this boundary maps it onto the wire.
 */
export function readOllamaNumCtx(context: GatewayProviderContext): number {
	const value = context.model?.contextWindow ?? context.model?.maxInputTokens;
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		return Math.floor(value);
	}
	return OLLAMA_DEFAULT_NUM_CTX;
}

/**
 * Time to wait for the response to start when no timeout is configured.
 *
 * Deliberately generous: Ollama holds `/api/chat` open while it cold-loads
 * the model and only sends response headers once loading finishes, so with a
 * large model (or a large `num_ctx`, which this vendor requests) the first
 * request of a session routinely takes minutes before the stream starts.
 * A tight budget here turns every cold load into a user-facing timeout error
 * (see cline/cline#12829 — the legacy handler's 30s default was only
 * tolerable because its retry decorator silently re-issued the request until
 * the model was loaded). Unreachable servers are not this timeout's job:
 * connection-level failures (refused, DNS) reject on their own immediately,
 * and users can always cancel a request from the UI. This only bounds the
 * accepted-but-silent case, and 5 minutes matches the header-timeout default
 * other AI SDK-based agents use.
 */
export const OLLAMA_DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Read the configured request timeout (the legacy `requestTimeoutMs`
 * setting); zero/invalid values fall back to the default.
 */
export function readOllamaTimeoutMs(
	config: GatewayResolvedProviderConfig,
): number {
	const timeoutMs = config.timeoutMs;
	if (
		typeof timeoutMs === "number" &&
		Number.isFinite(timeoutMs) &&
		timeoutMs > 0
	) {
		return Math.floor(timeoutMs);
	}
	return OLLAMA_DEFAULT_TIMEOUT_MS;
}

/**
 * Wrap a fetch so the *response* must start within `timeoutMs`. Once headers
 * arrive the timer is cleared — streaming the body is never interrupted.
 * Mirrors the legacy handler, which raced the chat call (stream start)
 * against a timeout rather than bounding the whole generation.
 */
/**
 * A dispatcher with Node's stream timeouts switched off, or undefined where
 * there is none to configure.
 *
 * Node's `fetch` is undici, and undici applies a `bodyTimeout` (5 minutes by
 * default) *between body chunks* — it is not a budget for the whole response,
 * only for how long any single gap in it may be.
 *
 * Thinking itself is not the gap: Ollama streams reasoning deltas, so a model
 * that is thinking is sending chunks. The gap is before the first token —
 * prompt prefill, which the server does after the response headers are out.
 * At a large context that is minutes of silence on an otherwise healthy
 * connection, and undici aborts it with `UND_ERR_BODY_TIMEOUT`.
 *
 * This interacts with our own transcript rewrites, which is why it surfaced
 * now. A stale-read rewrite changes bytes mid-transcript and invalidates the
 * provider's prefix cache from that point, so the next request re-prefills
 * what would otherwise have been cached — the longest possible gap, produced
 * by the cleanup that is supposed to help. `headersTimeout` goes for the
 * related cold-load reason: Ollama holds the response open while it loads a
 * model and sends no headers until it is ready.
 *
 * Removing these is safe precisely because this vendor already brings its own
 * bound: `withOllamaResponseTimeout` fails a request that never *starts*. What
 * is being given up is only the rule that a started response must keep
 * arriving at a fixed rate, which is the rule a thinking model breaks by
 * design.
 *
 * Resolved once, lazily, and never rethrows: a runtime without undici (a
 * browser, a custom fetch) simply gets no dispatcher and keeps its own
 * behaviour.
 */
let cachedDispatcher: unknown;
let dispatcherResolved = false;
async function resolveNoStreamTimeoutDispatcher(): Promise<unknown> {
	if (dispatcherResolved) {
		return cachedDispatcher;
	}
	dispatcherResolved = true;
	try {
		// The specifier is a variable on purpose: a literal makes `undici` a hard
		// build-time dependency of this package, and this package also builds for
		// the browser, where there is no undici to depend on. Kept optional and
		// resolved at runtime, it stays a capability rather than a requirement.
		const specifier = "undici";
		const undici = (await import(specifier)) as {
			Agent?: new (options: Record<string, unknown>) => unknown;
		};
		cachedDispatcher = undici.Agent
			? new undici.Agent({ bodyTimeout: 0, headersTimeout: 0 })
			: undefined;
	} catch {
		cachedDispatcher = undefined;
	}
	return cachedDispatcher;
}

export function withOllamaResponseTimeout(
	baseFetch: typeof fetch,
	timeoutMs: number,
	dispatcher?: unknown,
): typeof fetch {
	return (async (input, init) => {
		const timeoutController = new AbortController();
		const timer = setTimeout(
			() =>
				timeoutController.abort(
					new Error(
						`Ollama request timed out after ${timeoutMs / 1000} seconds`,
					),
				),
			timeoutMs,
		);
		// AbortSignal.any keeps upstream cancellation live for the entire
		// request (including body streaming after the timer is cleared) and
		// cleans up its own listeners — no manual listener management.
		const upstreamSignal = init?.signal;
		const signal = upstreamSignal
			? AbortSignal.any([upstreamSignal, timeoutController.signal])
			: timeoutController.signal;
		// `dispatcher` is an undici extension to RequestInit; a runtime that does
		// not know the key ignores it, and it is undefined where there is no
		// undici to configure. Resolved by the caller rather than awaited here:
		// an await before `baseFetch` moves the call after any synchronous
		// abort, so a signal that fires immediately would be attached too late.
		try {
			return await baseFetch(input, {
				...init,
				signal,
				...(dispatcher ? { dispatcher } : {}),
			} as RequestInit);
		} finally {
			clearTimeout(timer);
		}
	}) as typeof fetch;
}

/**
 * Ollama's wire names for the sampling parameters, in the order the API docs
 * list them.
 *
 * Spelled out rather than derived from the camelCase keys: `top_k` is not what
 * a naive transform produces from `topK`, and a settings screen that silently
 * sends `topk` looks exactly like one whose values do nothing.
 */
const OLLAMA_SAMPLING_WIRE_NAMES = {
	temperature: "temperature",
	topK: "top_k",
	topP: "top_p",
	minP: "min_p",
	typicalP: "typical_p",
	repeatLastN: "repeat_last_n",
	repeatPenalty: "repeat_penalty",
	presencePenalty: "presence_penalty",
	frequencyPenalty: "frequency_penalty",
	seed: "seed",
	numPredict: "num_predict",
	numKeep: "num_keep",
	stop: "stop",
	thinkBudget: "think_budget",
	thinkBudgetMessage: "think_budget_message",
} as const satisfies Record<keyof ProviderSamplingOptions, string>;

/**
 * Translate configured sampling parameters onto the wire.
 *
 * Only fields the user actually set are sent. An unset field is not a zero: a
 * local model carries a sampler in its Modelfile — often one that was tuned and
 * measured against that quant — and a client that sends a complete set on every
 * request silently replaces it. An empty `stop` list is dropped for the same
 * reason.
 */
export function buildOllamaSamplingOptions(
	sampling: ProviderSamplingOptions | undefined,
): Record<string, unknown> {
	if (!sampling) {
		return {};
	}
	const options: Record<string, unknown> = {};
	for (const [key, wireName] of Object.entries(OLLAMA_SAMPLING_WIRE_NAMES)) {
		const value = sampling[key as keyof ProviderSamplingOptions];
		if (value === undefined || value === null) {
			continue;
		}
		if (typeof value === "number" && !Number.isFinite(value)) {
			continue;
		}
		if (typeof value === "string" && value.trim() === "") {
			continue;
		}
		if (Array.isArray(value)) {
			const entries = value.filter((entry) => entry.trim() !== "");
			if (entries.length === 0) {
				continue;
			}
			options[wireName] = entries;
			continue;
		}
		options[wireName] = value;
	}
	return options;
}

/** Read the sampling parameters carried on the resolved provider config. */
export function readOllamaSamplingOptions(
	config: GatewayResolvedProviderConfig,
): ProviderSamplingOptions | undefined {
	const sampling = config.options?.sampling;
	return sampling && typeof sampling === "object"
		? (sampling as ProviderSamplingOptions)
		: undefined;
}

export async function createOllamaProviderModule(
	config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): Promise<ProviderFactoryResult> {
	// An API key is only needed for Ollama Cloud (ollama.com); local servers
	// accept unauthenticated requests, so a missing key is not an error. This
	// provider takes auth through headers rather than an `apiKey` field, so the
	// bearer is built here; an explicitly configured header still wins.
	const apiKey = await resolveApiKey(config);
	const baseURL = normalizeOllamaBaseUrl(config.baseUrl);
	const headers = {
		...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		...config.headers,
	};
	const provider = createOllama({
		...(baseURL ? { baseURL } : {}),
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		compatibility: "strict",
		fetch: withOllamaResponseTimeout(
			ensureFetch(config.fetch),
			readOllamaTimeoutMs(config),
			await resolveNoStreamTimeoutDispatcher(),
		),
	});
	// `num_ctx` and the sampler no longer ride on the model: this package has no
	// model-level options hook, so they reach the wire as request-scoped
	// provider options built by `provider.ollama.native-options`. That rule is
	// also the only place they can be merged rather than replace what the
	// option-rule pipeline already composed.
	// Retry empty responses (a common local-backend glitch that otherwise
	// hard-fails the task). Outermost so each retry re-runs the whole request.
	// `splitToolImagesMiddleware` is inner, for the same reason as the
	// OpenAI-compatible vendor: the downstream converter stringifies
	// multimodal tool-result content, losing image bytes.
	const retryEmptyResponseMiddleware = createRetryEmptyResponseMiddleware({
		logger: context.logger,
	});
	return {
		model: (modelId) =>
			wrapLanguageModel({
				model: provider.chat(modelId) as LanguageModelV4,
				middleware: [retryEmptyResponseMiddleware, splitToolImagesMiddleware],
			}),
		buildStreamConfig: buildOllamaStreamConfig,
	};
}

/**
 * The effort a request stands for when it does not name one.
 *
 * `medium` rather than the strongest: asking a model to think is not asking it
 * to think as hard as it can. On Ollama an effort level also bounds how much of
 * the response the model may spend inside the thinking block, so the middle of
 * the scale is the reading that leaves room for an answer.
 *
 * Exported because the level decides the thinking budget the server will
 * enforce, and anything that wants to report that budget has to ask about the
 * level that will actually be sent.
 */
export const OLLAMA_DEFAULT_REASONING_EFFORT = "medium" as const;

/**
 * Ollama's stream config: the shared one, plus a level whenever the request did
 * not settle on one.
 *
 * The AI SDK's vocabulary is a scale of efforts — `none`, `minimal`, `low`,
 * `medium`, `high`, `xhigh` — with no plain "on". `provider-default` is the
 * nearest thing, but it means "whatever the model was constructed with", and
 * this vendor constructs models with no reasoning setting precisely so
 * reasoning stays a per-request decision.
 *
 * The level is supplied for an absent reasoning config as well as an enabled
 * one, because on this provider those are the same situation. Nothing writes
 * the field: the extension's Ollama settings are `provider`, `model`,
 * `contextWindow` and `timeout`, and its settings UI has no reasoning control
 * at all, so `reasoning` is not "off", it is "never asked". Treating that as
 * off sends a reasoning model to Ollama with `think` unset, and a model that
 * thinks anyway then does it into `content`, unbounded, with no level for a
 * thinking budget to derive a cap from. Measured: a turn at ~51k input, 32,000
 * output tokens available, ended on "Model reached the maximum output token
 * limit before completing the turn" with `think` absent from the wire.
 *
 * An explicit `enabled: false` still means off — it reaches
 * `buildAiSdkStreamConfig` as `"none"`, so `config.reasoning` is already set
 * and this leaves it alone. Only the unset case is filled in, and only here:
 * Ollama is the provider whose wire format has a `think` field, so it is the
 * provider that has to say what silence means.
 *
 */
export function buildOllamaStreamConfig(
	request: GatewayStreamRequest,
	context: GatewayProviderContext,
): Partial<CallSettings> {
	const config = buildAiSdkStreamConfig(request, context);
	if (config.reasoning !== undefined) {
		return config;
	}
	return { ...config, reasoning: OLLAMA_DEFAULT_REASONING_EFFORT };
}
