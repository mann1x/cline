import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { wrapLanguageModel } from "ai";
import { splitToolImagesMiddleware } from "../middleware/split-tool-images";
import { localStreamFetch, resolveLocalStreamDispatcher } from "./ollama";
import { PolykvSaturatedError } from "./polykv";

/**
 * opencoti-llamafile: llama.cpp's wire format with a KV control plane attached.
 *
 * The chat endpoint is OpenAI-compatible, so most of this is the compatible
 * provider. What is not: two body extras, `pool_id` and `session_id`, which
 * attach the request to a pinned prefix already resident on the server instead
 * of re-sending it. That is the whole point of routing through this vendor
 * rather than the generic one -- see `polykv.ts` for the tree those ids name.
 *
 * The engine also answers `429`/`503` with `Retry-After` when a pool is
 * saturated. Left as a bare HTTP error that reads as a network fault, which is
 * how the equivalent condition presented on the Ollama path: a stall that was
 * really the server declining to admit more work.
 */

export interface OpencotiRequestOptions {
	/** Pool to attach this request to. Absent means an unpooled request. */
	poolId?: string;
	/**
	 * Session identity, stable across the turns of one conversation.
	 *
	 * The engine keys per-session tps, slot affinity and admission on it, and
	 * treats a known session as a continuation rather than a new admission --
	 * so a stable id is what keeps a long conversation from being gated
	 * mid-run.
	 */
	sessionId?: string;
	/**
	 * Explicit shared-prefix length. Optional by design: the server computes
	 * the longest hash-match itself (auto-P), which is what removed the
	 * mis-set-P footgun. Send it only when it is known to be right.
	 */
	sharedPrefixTokens?: number;
	/** Bypass admission for this request, explicitly and visibly. */
	overcommit?: boolean;
}

/** What the engine reports back about the pool it served the request from. */
export interface OpencotiResponseFacts {
	poolId?: string;
	/** Prefix tokens served from cache rather than prefilled again. */
	cachedTokens?: number;
	sessionTps?: number;
	backpressure?: boolean;
}

/**
 * Add the PolyKV fields to an outgoing chat request, and read the facts back.
 *
 * Done in a fetch wrapper rather than through provider options because the
 * fields belong on the request body root, next to `messages` -- the
 * compatible provider has no route for arbitrary body extras that survives its
 * own serialization.
 */
export function createOpencotiFetch(options: {
	fetch?: typeof fetch;
	dispatcher?: unknown;
	request?: OpencotiRequestOptions;
	onFacts?: (facts: OpencotiResponseFacts) => void;
}): typeof fetch {
	const base = options.fetch ?? fetch;
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		let nextInit = init;
		const extras = options.request;
		if (extras && init?.body && typeof init.body === "string") {
			try {
				const body = JSON.parse(init.body) as Record<string, unknown>;
				if (extras.poolId !== undefined) {
					body.pool_id = extras.poolId;
				}
				if (extras.sessionId !== undefined) {
					body.session_id = extras.sessionId;
				}
				if (extras.sharedPrefixTokens !== undefined) {
					body.shared_prefix_n_tokens = extras.sharedPrefixTokens;
				}
				if (extras.overcommit !== undefined) {
					body.overcommit = extras.overcommit;
				}
				nextInit = { ...init, body: JSON.stringify(body) };
			} catch {
				// A body that is not JSON is not ours to rewrite. The request goes
				// as it was: an unpooled turn is slower, a mangled one is broken.
				nextInit = init;
			}
		}
		const response = await base(input, {
			...nextInit,
			// Prefill is the reason this matters: creating or attaching a pool
			// can compute a very long prefix, and undici's default header
			// timeout is five minutes.
			...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
		} as RequestInit);

		if (response.status === 429 || response.status === 503) {
			const retryAfter = response.headers.get("retry-after");
			const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
			throw new PolykvSaturatedError(
				`opencoti declined the request (${response.status}); the pool is at capacity`,
				Number.isFinite(seconds) ? seconds * 1000 : undefined,
				response.headers.get("x-polykv-reason") ?? undefined,
			);
		}

		if (options.onFacts) {
			const facts: OpencotiResponseFacts = {
				poolId: response.headers.get("x-pool-id") ?? undefined,
				cachedTokens: numberOrUndefined(
					response.headers.get("x-cached-prefix-tokens"),
				),
				sessionTps: numberOrUndefined(response.headers.get("x-session-tps")),
				backpressure: response.headers.get("x-sessions-remaining") === "0",
			};
			if (
				facts.poolId !== undefined ||
				facts.cachedTokens !== undefined ||
				facts.sessionTps !== undefined
			) {
				options.onFacts(facts);
			}
		}
		return response;
	}) as typeof fetch;
}

function numberOrUndefined(value: string | null): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/** Read the per-request PolyKV options a caller put on the provider config. */
export function readOpencotiRequestOptions(
	context: GatewayProviderContext,
): OpencotiRequestOptions {
	const options = (context.config?.options ?? {}) as Record<string, unknown>;
	const read = (key: string): unknown => options[key];
	const poolId = read("polykvPoolId");
	const sessionId = read("polykvSessionId");
	const sharedPrefix = read("polykvSharedPrefixTokens");
	const overcommit = read("polykvOvercommit");
	return {
		...(typeof poolId === "string" && poolId ? { poolId } : {}),
		...(typeof sessionId === "string" && sessionId ? { sessionId } : {}),
		...(typeof sharedPrefix === "number" && Number.isFinite(sharedPrefix)
			? { sharedPrefixTokens: sharedPrefix }
			: {}),
		...(typeof overcommit === "boolean" ? { overcommit } : {}),
	};
}

/** `http://host:8240` and `http://host:8240/v1` both mean the same server. */
export function normalizeOpencotiBaseUrl(
	baseUrl: string | undefined,
): string | undefined {
	if (!baseUrl) {
		return baseUrl;
	}
	const trimmed = baseUrl.replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

export async function createOpencotiProviderModule(
	config: GatewayResolvedProviderConfig,
	context: GatewayProviderContext,
): Promise<{ model: (modelId: string) => LanguageModelV4 }> {
	const baseURL = normalizeOpencotiBaseUrl(config.baseUrl);
	const dispatcher = await resolveLocalStreamDispatcher();
	// Same precedence as Ollama's, and for the same measured reason: the
	// dispatcher means nothing to a fetch that does not read it, so when there
	// is one to honour, the fetch that honours it goes first.
	const injected = localStreamFetch();
	const suppliedFetch =
		config.fetch && config.fetch !== globalThis.fetch ? config.fetch : undefined;
	const baseFetch = dispatcher && injected ? injected : (suppliedFetch ?? injected);
	const request = readOpencotiRequestOptions(context);
	context.logger?.debug(
		`[opencoti] pool=${request.poolId ?? "none"} session=${
			request.sessionId ?? "none"
		} dispatcher=${dispatcher ? "attached" : "none"}`,
	);
	const providerFetch = createOpencotiFetch({
		...(baseFetch ? { fetch: baseFetch } : {}),
		dispatcher,
		request,
		onFacts: (facts) => {
			context.logger?.debug(
				`[opencoti] served from pool ${facts.poolId ?? "?"}: ${
					facts.cachedTokens ?? 0
				} prefix tokens cached${
					facts.sessionTps !== undefined ? `, ${facts.sessionTps} tok/s` : ""
				}`,
			);
		},
	});
	const provider = createOpenAICompatible({
		name: context.provider.id,
		...(config.apiKey ? { apiKey: config.apiKey } : { apiKey: "opencoti" }),
		...(baseURL ? { baseURL } : {}),
		...(config.headers ? { headers: config.headers } : {}),
		fetch: providerFetch,
		includeUsage: true,
	} as never);
	return {
		model: (modelId) =>
			wrapLanguageModel({
				model: provider(modelId) as LanguageModelV4,
				middleware: splitToolImagesMiddleware,
			}) as LanguageModelV4,
	};
}
