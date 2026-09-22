import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type {
	GatewayProviderContext,
	GatewayResolvedProviderConfig,
} from "@cline/shared";
import { wrapLanguageModel } from "ai";
import type { PolykvOptions } from "../config";
import { splitToolImagesMiddleware } from "../middleware/split-tool-images";
import { primeTemplateReinjection } from "../reasoning-history";
import { llamaCppTimingsMetadataExtractor } from "./llamacpp-timings";
import { localStreamFetch, resolveLocalStreamDispatcher } from "./ollama";
import { getPolykvSession } from "./polykv";
import type { ProviderFactoryResult } from "./types";

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

/**
 * What the engine reports back, on the channel it actually uses.
 *
 * Deliberately short, and shorter than it used to be. The previous version read
 * `x-pool-id`, `x-cached-prefix-tokens` and `x-session-tps`, none of which the
 * server sets -- they were specified and then deferred, because headers must be
 * emitted before the body while the slot, and therefore the tps, is only
 * assigned after the task is queued. With all three always absent the callback
 * guarded on them never fired once, so the whole observability path was dead
 * while looking implemented.
 *
 * Whether the pool attached is the fact worth having, and on c7 it is not on
 * the response at all: read `/slots[].opencoti.n_pool_shared`. c8 puts an
 * `opencoti {pool_id, n_pool_shared}` block on the response itself.
 */
export interface OpencotiResponseFacts {
	/**
	 * Sessions the pool can still admit, as the warn arm reports it.
	 *
	 * Absent means "not computable", which is not zero -- and on c7 a reported
	 * `0` may itself be wrong. Neither may be read as saturation.
	 */
	sessionsRemaining?: number;
	/**
	 * The request outlived its settling hold and was let through on the clock.
	 *
	 * Worth distinguishing: every other admit is evidence the pool had room, and
	 * this one is evidence only that the timer expired.
	 */
	settleWaivedMs?: number;
	/**
	 * The pool the turn actually ran against, as the server names it.
	 *
	 * A string, because pool `0` -- the first pool on a fresh server -- is
	 * falsy as a number and is dropped by every `if (poolId)` between here and
	 * wherever it is used.
	 */
	poolId?: string;
	/**
	 * Tokens the prefix actually shared with the pool.
	 *
	 * The number that says whether pooling worked. **`0` with a pool named is a
	 * silently degraded attach**, not an absence: the turn succeeds, the answer
	 * is right, and the prefix was prefilled from scratch anyway. Nothing else
	 * in the client can tell that from a working attach, so it is reported
	 * rather than treated as nothing to say. `undefined` is the different fact
	 * that the server did not report one.
	 */
	poolSharedTokens?: number;
}

/**
 * Pull the attach out of the `opencoti` block a c8 response carries.
 *
 * Self-identifying, so it is read unconditionally rather than behind
 * `attach_in_response_v1`: a server that does not set the block simply has
 * none, and the flag is only needed to know whether *absence* means "did not
 * attach" or "does not report".
 */
function readAttachFacts(block: unknown): OpencotiResponseFacts {
	if (!block || typeof block !== "object") {
		return {};
	}
	const source = block as Record<string, unknown>;
	const poolId =
		source.pool_id === undefined || source.pool_id === null
			? undefined
			: String(source.pool_id);
	const shared = source.n_pool_shared;
	return {
		// `-1` is the engine's "no pool", not pool minus one.
		...(poolId !== undefined && poolId !== "" && poolId !== "-1"
			? { poolId }
			: {}),
		...(typeof shared === "number" && Number.isFinite(shared)
			? { poolSharedTokens: shared }
			: {}),
	};
}

/**
 * Watch an SSE body go past, without standing in its way.
 *
 * A pass-through transform rather than a `tee()`: the second branch of a tee
 * needs its own reader, and a reader nobody drains stalls the branch the caller
 * is actually reading. Here the scan sits inside the consumer's own pipeline,
 * so it advances exactly as fast as the consumer does and dies with it on an
 * abort.
 *
 * Cline streams, so this is the path that matters. A read that only worked on a
 * buffered response would be dead on arrival -- which is precisely how the
 * header-based observability this replaces failed.
 */
function scanEventStream(
	onBlock: (block: unknown) => void,
): TransformStream<Uint8Array, Uint8Array> {
	const decoder = new TextDecoder();
	let carry = "";
	const consider = (line: string): void => {
		// The cheap gate first: most frames are content deltas.
		if (!line.includes('"opencoti"')) {
			return;
		}
		const payload = line.startsWith("data:")
			? line.slice("data:".length).trim()
			: line.trim();
		if (!payload || payload === "[DONE]") {
			return;
		}
		try {
			onBlock((JSON.parse(payload) as Record<string, unknown>).opencoti);
		} catch {
			// A frame split across chunk boundaries is not a frame yet. It comes
			// back whole once its newline arrives, so there is nothing to do.
		}
	};
	return new TransformStream({
		transform(chunk, controller) {
			controller.enqueue(chunk);
			carry += decoder.decode(chunk, { stream: true });
			const lines = carry.split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) {
				consider(line);
			}
		},
		flush() {
			if (carry) {
				consider(carry);
			}
		},
	});
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

		// A refusal goes back as a response, not as a throw.
		//
		// The admission gate runs `enforced` by default, so `429` + `Retry-After`
		// is a normal operating condition on a busy server rather than a fault.
		// Thrown from inside the fetch it never reached the error classifier --
		// the layer that knows a refusal is worth waiting out -- and surfaced as
		// a transport failure, so the caller gave up on a server that had told it
		// exactly when to come back.
		//
		// Note what is NOT done here: the body is not consulted. On c7, the
		// published release, the refusal is a `429` carrying a body that says
		// `503`/`unavailable_error`; the status line is the half that is right on
		// both releases.
		if (!options.onFacts) {
			return response;
		}
		{
			const onFacts = options.onFacts;
			const facts: OpencotiResponseFacts = {
				...(numberOrUndefined(response.headers.get("x-sessions-remaining")) !==
				undefined
					? {
							sessionsRemaining: numberOrUndefined(
								response.headers.get("x-sessions-remaining"),
							) as number,
						}
					: {}),
				...(numberOrUndefined(
					response.headers.get("x-polykv-settle-waived"),
				) !== undefined
					? {
							settleWaivedMs: numberOrUndefined(
								response.headers.get("x-polykv-settle-waived"),
							) as number,
						}
					: {}),
			};

			// A stream cannot be read here and handed on intact, so the headers
			// go out now and the attach follows when the last frame passes. Two
			// calls on a streamed turn, one on a buffered one: the callback
			// takes observations as they are learned, not a single summary.
			const contentType = response.headers.get("content-type") ?? "";
			if (contentType.includes("text/event-stream") && response.body !== null) {
				if (Object.keys(facts).length > 0) {
					onFacts(facts);
				}
				return new Response(
					response.body.pipeThrough(
						scanEventStream((block) => {
							const attach = readAttachFacts(block);
							if (Object.keys(attach).length > 0) {
								onFacts(attach);
							}
						}),
					),
					{
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					},
				);
			}

			// Buffered: `clone()` so the body the caller gets is still unread.
			// A response that is not JSON simply has no block, which is the same
			// answer as a server that does not set one.
			let attach: OpencotiResponseFacts = {};
			try {
				const body = (await response.clone().json()) as Record<string, unknown>;
				attach = readAttachFacts(body?.opencoti);
			} catch {
				attach = {};
			}
			const merged = { ...facts, ...attach };
			if (Object.keys(merged).length > 0) {
				onFacts(merged);
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

/**
 * The PolyKV section this profile configured, if any.
 *
 * Read from the typed field the settings panel writes; the loose
 * `polykv*`-prefixed keys below are the older route and stay readable so a
 * caller that sets them directly is not silently ignored.
 */
export function readPolykvSettings(
	context: GatewayProviderContext,
): PolykvOptions | undefined {
	const section = context.config?.options?.polykv;
	return section && typeof section === "object"
		? (section as PolykvOptions)
		: undefined;
}

/** Read the per-request PolyKV options a caller put on the provider config. */
export function readOpencotiRequestOptions(
	context: GatewayProviderContext,
): OpencotiRequestOptions {
	const options = (context.config?.options ?? {}) as Record<string, unknown>;
	const read = (key: string): unknown => options[key];
	const settings = readPolykvSettings(context);
	const configuredPool = read("polykvPoolId");
	const sessionId = read("polykvSessionId");
	const sharedPrefix = read("polykvSharedPrefixTokens");
	// The section wins where it says anything; the loose key is the fallback.
	const overcommit = settings?.overcommit ?? read("polykvOvercommit");
	// The live pool wins over anything the config froze: after a compaction
	// re-roots the conversation the configured id names a pool that has been
	// released.
	const live = getPolykvSession(
		typeof sessionId === "string" ? sessionId : undefined,
	);
	const poolId =
		live?.poolId ??
		(typeof configuredPool === "string" && configuredPool
			? configuredPool
			: undefined);
	return {
		...(poolId ? { poolId } : {}),
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
): Promise<ProviderFactoryResult> {
	const baseURL = normalizeOpencotiBaseUrl(config.baseUrl);
	const dispatcher = await resolveLocalStreamDispatcher();
	// Same precedence as Ollama's, and for the same measured reason: the
	// dispatcher means nothing to a fetch that does not read it, so when there
	// is one to honour, the fetch that honours it goes first.
	const injected = localStreamFetch();
	const suppliedFetch =
		config.fetch && config.fetch !== globalThis.fetch
			? config.fetch
			: undefined;
	const baseFetch =
		dispatcher && injected ? injected : (suppliedFetch ?? injected);
	const request = readOpencotiRequestOptions(context);
	context.logger?.debug(
		`[opencoti] pool=${request.poolId ?? "none"} session=${
			request.sessionId ?? "none"
		} dispatcher=${dispatcher ? "attached" : "none"}`,
	);
	// Whether this server's chat template puts prior reasoning back into the
	// prompt. Unlike ollama's, this probe is free: `/apply-template` renders a
	// conversation server-side, CPU-only and without taking a slot, so the
	// answer comes from reading the server's own prompt rather than from
	// measuring its length -- and it is safe to call while the server is busy.
	if (context.model?.id) {
		await primeTemplateReinjection(
			baseURL,
			context.model.id,
			baseFetch ?? globalThis.fetch,
		);
	}
	const providerFetch = createOpencotiFetch({
		...(baseFetch ? { fetch: baseFetch } : {}),
		dispatcher,
		request,
		onFacts: (facts) => {
			// Whether the pool attached is not on this channel: on c7 it is
			// `/slots[].opencoti.n_pool_shared`, and on c8 the response's own
			// `opencoti` block. What is here is the admission arm's own reporting.
			const parts: string[] = [];
			if (facts.sessionsRemaining !== undefined) {
				parts.push(`${facts.sessionsRemaining} session(s) of headroom left`);
			}
			if (facts.settleWaivedMs !== undefined) {
				parts.push(
					`admitted on the ${facts.settleWaivedMs}ms settling timer, not on a measurement`,
				);
			}
			if (parts.length > 0) {
				context.logger?.debug(`[opencoti] ${parts.join("; ")}`);
			}
		},
	});
	const provider = createOpenAICompatible({
		name: context.provider.id,
		...(config.apiKey ? { apiKey: config.apiKey } : { apiKey: "opencoti" }),
		...(baseURL ? { baseURL } : {}),
		...(config.headers ? { headers: config.headers } : {}),
		fetch: providerFetch,
		includeUsage: true,
		metadataExtractor: llamaCppTimingsMetadataExtractor,
	} as never);
	return {
		operations: {
			language: (modelId: string) =>
				wrapLanguageModel({
					model: provider(modelId) as LanguageModelV4,
					middleware: splitToolImagesMiddleware,
				}) as LanguageModelV4,
		},
	};
}
