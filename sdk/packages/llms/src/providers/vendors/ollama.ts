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
	BasicLogger,
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
import { keepToolImagesMiddleware } from "../middleware/split-tool-images";
import {
	createOllamaHealthProbe,
	watchForStall,
	withStallWatchdog,
} from "./ollama-stall-watchdog";
import { rewriteOllamaChatBody } from "./ollama-tool-images";
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
	const declared = readDeclaredNumCtx(
		context.config?.baseUrl,
		context.model?.id,
	);
	if (declared !== undefined) {
		return declared;
	}
	return OLLAMA_DEFAULT_NUM_CTX;
}

/**
 * The `num_ctx` each model declares for itself, keyed by server and model.
 *
 * Local models are discovered from `/api/tags`, which reports names and
 * nothing else, so `model.contextWindow` is undefined for every one of them
 * and the default above used to be what they all got. Measured: a model whose
 * Modelfile says `num_ctx 128000` loaded at `runner.num_ctx=32768`, because
 * sending a default *overrides* the model's own value — Ollama cannot tell a
 * considered 32768 from a placeholder one.
 *
 * That is the same mistake as writing a temperature from client code. The
 * window a model was built with belongs to the model, so it is read from the
 * server rather than guessed, and the constant survives only as the answer for
 * a model that declares nothing.
 */
const declaredNumCtx = new Map<string, number | null>();

function declaredKey(baseUrl: string | undefined, modelId: string): string {
	return `${normalizeOllamaBaseUrl(baseUrl) ?? "default"}::${modelId}`;
}

/** The model's own `num_ctx`, if it has been looked up and it has one. */
export function readDeclaredNumCtx(
	baseUrl: string | undefined,
	modelId: string | undefined,
): number | undefined {
	if (!modelId) {
		return undefined;
	}
	return declaredNumCtx.get(declaredKey(baseUrl, modelId)) ?? undefined;
}

/** Parse `num_ctx` out of the `parameters` block `/api/show` returns. */
export function parseDeclaredNumCtx(payload: unknown): number | undefined {
	if (!payload || typeof payload !== "object") {
		return undefined;
	}
	const parameters = (payload as { parameters?: unknown }).parameters;
	if (typeof parameters !== "string") {
		return undefined;
	}
	// One `name value` pair per line; values are sometimes quoted.
	const found = parameters.match(/^[ \t]*num_ctx[ \t]+"?(\d+)"?[ \t]*$/m);
	if (!found) {
		return undefined;
	}
	const value = Number(found[1]);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Ask the server what the model's own context window is, once per model.
 *
 * Awaited by the factory rather than left to the first request: resolving it
 * late would send turn one at the default and every later turn at the real
 * value, and a changed `num_ctx` makes Ollama reload the model mid-task.
 *
 * Failure is not an error. A server that does not answer, or answers something
 * this cannot read, leaves the entry null and the caller falls back exactly as
 * it did before.
 */
export async function primeDeclaredNumCtx(
	baseUrl: string | undefined,
	modelId: string | undefined,
	fetchImpl: typeof fetch,
	logger?: BasicLogger,
): Promise<void> {
	if (!modelId) {
		return;
	}
	const key = declaredKey(baseUrl, modelId);
	if (declaredNumCtx.has(key)) {
		return;
	}
	const root = normalizeOllamaBaseUrl(baseUrl) ?? "http://localhost:11434/api";
	try {
		const response = await fetchImpl(`${root}/show`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: modelId }),
		});
		if (!response.ok) {
			declaredNumCtx.set(key, null);
			return;
		}
		const value = parseDeclaredNumCtx(await response.json());
		declaredNumCtx.set(key, value ?? null);
		if (value !== undefined) {
			logger?.debug?.(
				`[ollama] ${modelId} declares num_ctx ${value}; using it rather than the ${OLLAMA_DEFAULT_NUM_CTX} default`,
			);
		}
	} catch {
		declaredNumCtx.set(key, null);
	}
}

/** Test seam: forget every looked-up window. */
export function resetDeclaredNumCtx(): void {
	declaredNumCtx.clear();
}

/**
 * Resolve the `num_predict` to request from the resolved model's output cap.
 *
 * `ollama-ai-provider-v2` names `num_predict` in its provider-options schema
 * and nowhere else: it never derives one from the request's
 * `maxOutputTokens`. So the per-turn cap the agent computes — and states in the
 * system prompt — reached Ollama on no request at all, and two things followed
 * from that.
 *
 * The cap itself was not enforced. Worse, Ollama sizes the thinking budget from
 * `min(num_predict, num_ctx)`: with no `num_predict` the whole context window is
 * the base, so a 128k-context model on effort `medium` (one quarter) was
 * allowed 32,000 thinking tokens while the prompt told it 8,000 — the figure
 * `/api/show` reports when asked with the cap the session believes it is
 * sending. Measured on a real session: single thinking blocks of ~16,000
 * tokens, twice the stated bound, and runs ending on "reached the maximum
 * output token limit" with the entire allowance spent reasoning and no tool
 * call emitted.
 *
 * Sending it makes both numbers true at once, which is the point: the bound in
 * the prompt is only worth stating if the server holds the model to it.
 */
export function readOllamaNumPredict(
	request: Pick<GatewayStreamRequest, "maxTokens">,
	context: GatewayProviderContext,
): number | undefined {
	// The request's cap first, and not only as a fallback ordering: it is the
	// number `buildOutputBudgetSection` puts in the system prompt, including
	// when the gateway synthesized it from a default. A local model's catalog
	// entry usually carries no output cap at all, so reading the model alone
	// would leave this undefined on exactly the models that need it.
	for (const value of [request.maxTokens, context.model?.maxOutputTokens]) {
		if (typeof value === "number" && Number.isFinite(value) && value > 0) {
			return Math.floor(value);
		}
	}
	return undefined;
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
 *
 * The import alone is not enough in a bundled host, and that is not a
 * hypothetical. A variable specifier is invisible to a bundler by
 * construction — that is the point of it — so esbuild leaves `import("undici")`
 * in the output as a *runtime* resolution against the extension's own
 * directory. A packaged VSIX ships no `node_modules`, so it resolved nothing,
 * the catch below swallowed it, and every build shipped with undici's default
 * five-minute `bodyTimeout` still in force while reporting nothing at all.
 * `UND_ERR_BODY_TIMEOUT` kept ending runs across four releases that were
 * supposed to have fixed it.
 *
 * Hence {@link setOllamaNoStreamTimeoutDispatcher}: a host that already has
 * undici linked hands one in, and the dynamic import stays as the fallback for
 * hosts that do not. Nothing here reaches for a bundler-visible import, because
 * that is exactly what this package cannot have.
 */
let cachedDispatcher: unknown;
let dispatcherResolved = false;

/**
 * Supply the dispatcher instead of having this module find one.
 *
 * For hosts that bundle: the injected value is used as-is and no import is
 * attempted. Passing `undefined` clears an earlier injection and lets the
 * import run again, which is what tests need between cases.
 */
export function setOllamaNoStreamTimeoutDispatcher(dispatcher: unknown): void {
	cachedDispatcher = dispatcher;
	dispatcherResolved = dispatcher !== undefined;
}

/**
 * Whether a dispatcher is in force, for hosts that want to say so in a log.
 *
 * Exported because the absence of one is invisible from the outside and was
 * invisible for four releases: the wrapper works either way, and the only
 * symptom is a timeout minutes later that looks like a network fault.
 */
export function hasOllamaNoStreamTimeoutDispatcher(): boolean {
	return cachedDispatcher !== undefined;
}

/**
 * A fetch that is known to honour `init.dispatcher`, when the host has one.
 *
 * `dispatcher` is undici's extension to `RequestInit`, and it only does
 * anything if the fetch reading it *is* undici's. `globalThis.fetch` is undici
 * in plain Node, so passing the dispatcher there is enough — but not every host
 * leaves that global alone. A VS Code extension host installs its own
 * proxy-aware fetch over the global, and a wrapper that rebuilds the request
 * from the fields it knows about drops the ones it does not. The dispatcher
 * then goes out with every request and takes effect on none of them.
 *
 * That is not a hypothetical either. It is why `UND_ERR_BODY_TIMEOUT` survived
 * the fix that installed the dispatcher: the vendor logged `attached` on a
 * dispatcher that was silently discarded one layer up, and the default
 * five-minute `bodyTimeout` kept killing prefill. The log was true and useless.
 *
 * So a host that has undici hands over its `fetch` as well as its `Agent`, and
 * the two travel together.
 *
 * A caller-supplied `config.fetch` wins only when it is actually routing
 * something. The distinction matters because the VS Code host supplies one
 * unconditionally — `@/shared/net` documents its VS Code branch as "uses global
 * fetch (VSCode provides proxy configuration)" — so preferring any supplied
 * fetch meant preferring the global, and the dispatcher went on being ignored
 * with a log line reading `fetch: caller-supplied` to prove it. Where the
 * supplied fetch *is* the global there is nothing to defer to; where it is not,
 * it is a proxy agent or a test double and it keeps precedence.
 */
let injectedFetch: typeof fetch | undefined;

export function setOllamaFetch(value: typeof fetch | undefined): void {
	injectedFetch = value;
}

export function hasOllamaFetch(): boolean {
	return injectedFetch !== undefined;
}

/**
 * The same two facts, for the other vendors that talk to a local server.
 *
 * The undici problem is not Ollama's -- it belongs to any endpoint whose
 * prefill can outrun a five-minute header timeout, which is every local engine
 * serving a long agentic prompt. The state stays here rather than being
 * duplicated: one dispatcher, one fetch, one place a host installs them. The
 * names are the debt from this having been an Ollama-only concern first.
 */
export async function resolveLocalStreamDispatcher(): Promise<unknown> {
	return resolveNoStreamTimeoutDispatcher();
}

/** The fetch known to honour `init.dispatcher`, if a host handed one over. */
export function localStreamFetch(): typeof fetch | undefined {
	return injectedFetch;
}

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

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (typeof input === "string") {
		return input;
	}
	if (input instanceof URL) {
		return input.toString();
	}
	return (input as Request).url;
}

export function withOllamaResponseTimeout(
	baseFetch: typeof fetch,
	timeoutMs: number,
	dispatcher?: unknown,
	options?: { logger?: BasicLogger },
): typeof fetch {
	return (async (input, init) => {
		const url = requestUrl(input);
		// One parse serves both jobs: the images have to be folded back onto the
		// tool message they came from, and the health probe wants to name the
		// model it is waiting for. These bodies are a quarter of a megabyte.
		const rewritten = rewriteOllamaChatBody(init?.body);
		if (rewritten?.merged) {
			options?.logger?.debug?.(
				`[ollama] folded ${rewritten.merged} tool-result image message(s) back onto their tool messages`,
			);
		}
		const probe = createOllamaHealthProbe({
			url,
			fetch: baseFetch,
			model: rewritten?.model,
			dispatcher,
			logger: options?.logger,
		});
		const timeoutController = new AbortController();
		// The wait for the first byte is bounded by the server's own liveness
		// rather than by a constant. Prefill at a large context is silence of
		// exactly the shape a dead server makes, and the only thing that tells
		// the two apart is asking.
		const headerWatcher = watchForStall({
			probe,
			intervalMs: timeoutMs,
			logger: options?.logger,
			label: "response",
			onDead: (elapsedMs) =>
				timeoutController.abort(
					new Error(
						`Ollama did not start responding within ${Math.round(
							elapsedMs / 1000,
						)} seconds and stopped answering health checks`,
					),
				),
		});
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
		let response: Response;
		try {
			response = await baseFetch(input, {
				...init,
				...(rewritten ? { body: rewritten.body } : {}),
				signal,
				...(dispatcher ? { dispatcher } : {}),
				// The same rule again, arriving from the other runtime. Bun's fetch
				// applies its own bound on the gap between body chunks, and
				// `dispatcher` is undici's key — Bun does not read it, so everything
				// argued above about `bodyTimeout` was true and had no effect wherever
				// the CLI runs. Measured on Bun 1.3.14 against a local server: a stream
				// that goes silent dies at 300s with `TimeoutError: The operation timed
				// out.`; the same stream with this flag was still alive past 800s; and
				// a stream sending a chunk every 30s ran to completion at 600s. So it
				// is a bound on the gap rather than a budget for the whole response,
				// and the gap is what this vendor exists to allow.
				//
				// A timeout that names nothing is what makes this expensive. The
				// message carries no host, no URL and no subsystem, so it reads as a
				// network fault and gets blamed on the server. The two bounds that are
				// actually ours both say so — `Ollama did not start responding within
				// Ns` and `Ollama stopped responding: no response data for Ns` — and
				// both ask the server whether it is alive instead of trusting a
				// constant. Giving this one up costs nothing those two do not cover.
				//
				// Unknown keys in a fetch init are ignored, so this is inert on Node
				// for the same reason `dispatcher` is inert on Bun.
				timeout: false,
			} as RequestInit);
		} finally {
			headerWatcher.stop();
		}
		// The same rule, applied to the body. undici's `bodyTimeout` is switched
		// off wherever the dispatcher takes, and was never honoured where it did
		// not; either way the bound that matters is this one.
		return withStallWatchdog(response, {
			probe,
			logger: options?.logger,
			label: "response data",
		});
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
	// Reported at the point of use, not only where it is installed. A host that
	// injects one and a host that finds one are indistinguishable from here,
	// and so is a host that got neither — the wrapper works either way and the
	// only symptom is a stall minutes later that reads as a network fault.
	const streamDispatcher = await resolveNoStreamTimeoutDispatcher();
	// A supplied fetch that is merely the global is not a routing decision, and
	// the global is the one that discards `init.dispatcher`.
	const suppliedFetch =
		config.fetch && config.fetch !== globalThis.fetch ? config.fetch : undefined;
	// The dispatcher decides the order, not the supplier. `dispatcher` is
	// undici's own extension to `RequestInit`, so a wrapper that rebuilds the
	// request from the fields it knows about drops it -- and a caller-supplied
	// fetch is exactly such a wrapper, installed for proxy and CA config that a
	// local Ollama endpoint does not go through anyway. Preferring it silently
	// reinstated undici's five-minute `headersTimeout` on a request the log had
	// just called timeout-free. Measured: a 71,963-token prompt whose prefill
	// ran past that limit died 917 seconds later -- three attempts at 300
	// seconds -- reported as `UND_ERR_HEADERS_TIMEOUT` and reading as a network
	// fault. The dispatcher only means something to a fetch that reads it, so
	// when there is one to honour, that fetch goes first.
	const requestFetch =
		streamDispatcher && injectedFetch
			? injectedFetch
			: (suppliedFetch ?? injectedFetch);
	const usingSuppliedFetch = requestFetch === suppliedFetch;
	context.logger?.debug(
		streamDispatcher
			? `[ollama] stream dispatcher attached: undici body/headers timeouts disabled (fetch: ${
					usingSuppliedFetch
						? "caller-supplied — it may discard the dispatcher, leaving undici's defaults in force"
						: injectedFetch
							? "host undici"
							: "global — the dispatcher may be discarded by it"
				})`
			: "[ollama] no stream dispatcher: undici's default bodyTimeout applies to this request",
	);
	// Before the first request, so the window the model declares is in hand by
	// the time `provider.ollama.native-options` builds `num_ctx`. Awaited here
	// rather than resolved lazily: a `num_ctx` that changes between turns makes
	// Ollama reload the model mid-task.
	await primeDeclaredNumCtx(
		config.baseUrl,
		context.model?.id,
		ensureFetch(requestFetch),
		context.logger,
	);
	const provider = createOllama({
		...(baseURL ? { baseURL } : {}),
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		compatibility: "strict",
		fetch: withOllamaResponseTimeout(
			ensureFetch(requestFetch),
			readOllamaTimeoutMs(config),
			streamDispatcher,
			{ logger: context.logger },
		),
	});
	// `num_ctx` and the sampler no longer ride on the model: this package has no
	// model-level options hook, so they reach the wire as request-scoped
	// provider options built by `provider.ollama.native-options`. That rule is
	// also the only place they can be merged rather than replace what the
	// option-rule pipeline already composed.
	// Retry empty responses (a common local-backend glitch that otherwise
	// hard-fails the task). Outermost so each retry re-runs the whole request.
	//
	// `keepToolImagesMiddleware` is inner, and is the half of the shared media
	// handling that this vendor wants: the budget checks and base64 validation,
	// without the relocation to a synthetic user message. The native API carries
	// `images` on a tool message — the vendored converter is patched to fill it
	// — and relocating instead costs the model its entire reasoning history,
	// because a chat template replays thinking only from the last user turn
	// onward. See `ollama-tool-images.ts`, which folds the relocation back at
	// the wire layer if it ever reappears.
	const retryEmptyResponseMiddleware = createRetryEmptyResponseMiddleware({
		logger: context.logger,
	});
	return {
		model: (modelId) =>
			wrapLanguageModel({
				model: provider.chat(modelId) as LanguageModelV4,
				middleware: [retryEmptyResponseMiddleware, keepToolImagesMiddleware],
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
