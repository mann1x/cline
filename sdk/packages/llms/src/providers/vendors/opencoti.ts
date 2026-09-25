import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
	classifyTurnFaultError,
	type GatewayProviderContext,
	type GatewayResolvedProviderConfig,
} from "@cline/shared";
import { wrapLanguageModel } from "ai";
import type { PolykvOptions } from "../config";
import { sleep as abortableSleep } from "../middleware/backoff";
import { DEFAULT_MAX_RETRY_AFTER_MS } from "../middleware/retry-rate-limit";
import { splitToolImagesMiddleware } from "../middleware/split-tool-images";
import { primeTemplateReinjection } from "../reasoning-history";
import { waitForServerHealth } from "../server-health";
import { llamaCppTimingsMetadataExtractor } from "./llamacpp-timings";
import { localStreamFetch, resolveLocalStreamDispatcher } from "./ollama";
import {
	type KeepaliveRequest,
	requestStreamKeepalive,
	superviseKeepaliveStream,
} from "./opencoti-liveness";
import { OpencotiWindowUnavailableError } from "./opencoti-window";
import {
	getPolykvGrantedWindow,
	getPolykvSession,
	hasOpencotiFeature,
	OPENCOTI_FEATURES,
	polykvAdmissionPolicy,
	polykvRoot,
	probeOpencotiProps,
	recordPolykvGrantedWindow,
	recordPolykvWindowObservation,
} from "./polykv";
import {
	hoistLeadEnvironment,
	markLeadWindowLive,
	prepareLeadPool,
} from "./polykv-lead";
import {
	engineSessionId,
	isWorkerWindowFull,
	markPolykvWorkerStarted,
	movePolykvWorker,
	notePolykvServerFault,
	type PolykvLeadRoom,
	type PolykvWorkerSpec,
	polykvRoomBackoffMs,
	polykvRootGeneration,
	polykvWorkerStarted,
	preparePolykvWorker,
	readPolykvLeadRoom,
	rememberOpencotiSession,
	reportPolykvNotice,
	reportPolykvRoomWait,
	reportPolykvStreamPhase,
} from "./polykv-swarm";
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
	/**
	 * Attach a lead conversation to the server-wide lead tree
	 * (`polykv-lead.ts`). Only requests whose system turn carries environment
	 * spans are a lead's; the rest ignore it.
	 */
	leadPool?: boolean;
	/**
	 * The context window to book, in tokens.
	 *
	 * Sent only when the user stated one. A guaranteed allocation is booked
	 * whole at admission and held for the session's life, so this is the number
	 * the conversation is sized against for as long as it lives.
	 *
	 * On a CONTINUATION -- a turn on a session the server already holds -- it is
	 * ignored rather than re-booked. You keep the window you were granted, and
	 * `X-Context-Window` reports that one, so a changed value here must be
	 * checked against what comes back rather than assumed to have taken.
	 */
	numCtx?: number;
	/**
	 * The floor below which a window is worse than no connection.
	 *
	 * The server settles this against `numCtx` in ONE admission: the largest
	 * window in the band, or a 429 naming `largest_admissible`. That matters
	 * beyond tidiness -- the client-side equivalent is to read
	 * `largest_admissible` off a refusal and retry at it, and another arrival
	 * can take those cells in the gap between the read and the retry. A single
	 * request has no gap to lose.
	 *
	 * On a RESUME, send it equal to `numCtx`: "the window I had, or refuse".
	 * A resumed conversation may never negotiate down, because its history no
	 * longer fits a smaller window and a silent shrink truncates mid-thread.
	 *
	 * Sent only where `/props` advertises `ctx_min_negotiation_v1`. Without it
	 * the fetch keeps the floor to itself and falls back to retrying ONCE at
	 * the refusal's `largest_admissible`, when that is at or above the floor.
	 */
	numCtxMin?: number;
	/**
	 * This session has been granted a window before: every admission from here
	 * on is "exactly that window, or refuse". A resume never negotiates down
	 * and never waits -- a refusal is the "Can't resume" card at once.
	 */
	resume?: boolean;
	/**
	 * The longest a NEW session below its floor waits, once, before it is
	 * refused. The profile's `maxRetryAfterMs`, the same bound the rate-limit
	 * middleware honours; the server's `Retry-After` inside it.
	 */
	maxRetryAfterMs?: number;
	/**
	 * The output cap a worker declares when the request carries none (P2).
	 *
	 * A worker is charged to its owner's window, and the engine can refuse it
	 * at arrival -- before a prefill is spent -- only if it knows how much the
	 * reply may take. The gateway sends no cap for a model the catalog knows
	 * nothing about, or when its estimate leaves no room, so this is the
	 * fallback that makes "workers always declare" true on the wire.
	 */
	workerMaxTokens?: number;
	/**
	 * This request is one agent of a swarm sharing a pool tree.
	 *
	 * Replaces `poolId` and `sessionId`: the pool is the deepest layer of the
	 * tree its own messages match, and the session is the agent's own. A worker
	 * books no window of its own -- the owner's is charged -- so `numCtx` is not
	 * sent either. See `polykv-swarm.ts`.
	 */
	worker?: PolykvWorkerSpec;
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
	/**
	 * How far the prompt matched the named pool, and the pool's length
	 * (`pool_match_in_response_v1`). `match < length` is a pool prompt that
	 * diverges from the rendered request: it was built wrong, and shares only
	 * the part before the divergence. The server log names the token.
	 */
	poolMatchTokens?: number;
	poolLengthTokens?: number;
	/**
	 * The window the server granted, from `X-Context-Window`.
	 *
	 * **Absent is not "unchanged".** The header rides every admitted response
	 * *while the server is in guaranteed mode*, so its absence means the
	 * request was not guaranteed -- an `overcommit`, or a server not enforcing
	 * -- and the honest reading is "unknown". Treating it as unchanged is a
	 * silent lie about the one number the conversation is sized against.
	 */
	contextWindow?: number;
	/**
	 * The window this request asked for on the wire (`num_ctx`), beside the
	 * grant, so "asked X, got Y" is one observation rather than two numbers
	 * from two places. Absent when the request asked for none.
	 */
	askedWindow?: number;
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
	const count = (value: unknown) =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const match = count(source.pool_match);
	const length = count(source.pool_len);
	return {
		...(match !== undefined ? { poolMatchTokens: match } : {}),
		...(length !== undefined ? { poolLengthTokens: length } : {}),
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
	/** Server root, for the swarm's control-plane calls and session close. */
	baseUrl?: string;
	headers?: Record<string, string>;
	/** Seam for tests: the one below-floor wait a new session is allowed. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): typeof fetch {
	const base = options.fetch ?? fetch;
	const worker = options.request?.worker;
	if (worker && options.baseUrl) {
		return createWorkerFetch({
			...options,
			worker,
			baseUrl: options.baseUrl,
			...(options.request?.workerMaxTokens !== undefined
				? { workerMaxTokens: options.request.workerMaxTokens }
				: {}),
		});
	}
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		let nextInit = init;
		const extras = options.request;
		let leadSession: string | undefined;
		let leadAskedWindow = false;
		/** The server generation of the lead pool id this request carries. */
		let leadGeneration: number | undefined;
		let body: Record<string, unknown> | undefined;
		let negotiation: WindowNegotiation | undefined;
		// The prefix the lead tree shares above a private budget, so the grant
		// can be read back as the window the conversation can actually fill.
		let sharedAboveBudget: number | undefined;
		/** Set when this request asked for the heartbeat. */
		let keepalive: KeepaliveRequest | undefined;
		if (init?.body && typeof init.body === "string") {
			try {
				body = JSON.parse(init.body) as Record<string, unknown>;
			} catch {
				// A body that is not JSON is not ours to rewrite. The request goes
				// as it was: an unpooled turn is slower, a mangled one is broken.
				body = undefined;
			}
		}
		if (body) {
			// Environment spans become a turn of their own on every request
			// that carries them, pooled or not: the system turn left behind is
			// the same for every conversation, which is what the engine's
			// prefix cache and the lead tree both key on.
			const isLead = hoistLeadEnvironment(body);
			if (extras) {
				// Held as a string on this side -- the first pool is 0, and a
				// numeric 0 is falsy -- but the engine parses the field as a
				// number and 400s a string. Anything that is not an integer is
				// not an id it issued: left off, the turn runs unpooled rather
				// than failing.
				const wirePoolId =
					extras.poolId !== undefined && /^\d+$/.test(extras.poolId)
						? Number(extras.poolId)
						: undefined;
				if (wirePoolId !== undefined) {
					body.pool_id = wirePoolId;
				}
				if (extras.sessionId !== undefined) {
					body.session_id = engineSessionId(extras.sessionId);
					if (options.baseUrl) {
						rememberOpencotiSession(
							extras.sessionId,
							options.baseUrl,
							base,
							options.headers,
						);
					}
				}
				if (extras.sharedPrefixTokens !== undefined) {
					body.shared_prefix_n_tokens = extras.sharedPrefixTokens;
				}
				if (extras.overcommit !== undefined) {
					body.overcommit = extras.overcommit;
				}
				if (extras.numCtx !== undefined) {
					// A window is booked only on a server that books them. Where
					// `/props` does not advertise guaranteed allocations the field
					// means nothing the client can rely on -- no grant comes back
					// and no refusal is a window refusal -- so the switch stands
					// down there rather than sending a promise nobody keeps.
					const features = await windowFeatures(options.baseUrl, base);
					if (features.guaranteed) {
						body.num_ctx = extras.numCtx;
						// A floor is only meaningful under an ask. Sent alone it
						// would read as a demand for a minimum window on a request
						// that never asked for one; sent above the ask it is a
						// contradiction, and the resolution that means something is
						// "exactly this window or refuse" -- which is also the
						// resume rule's shape.
						if (extras.numCtxMin !== undefined) {
							body.num_ctx_min = Math.min(extras.numCtxMin, extras.numCtx);
						}
						negotiation = {
							atomic: features.atomic,
							resume: extras.resume === true,
						};
					}
				}
				if (
					isLead &&
					extras.leadPool &&
					extras.sessionId !== undefined &&
					options.baseUrl
				) {
					// The lead tree decides the pool for a lead request; whatever
					// the registry held is its own answer from the last turn.
					delete body.pool_id;
					const leadPool = await prepareLeadPool({
						baseUrl: options.baseUrl,
						fetch: base,
						...(options.headers ? { headers: options.headers } : {}),
						body,
						sessionId: extras.sessionId,
					}).catch(() => undefined);
					if (leadPool && /^\d+$/.test(leadPool.poolId)) {
						body.pool_id = Number(leadPool.poolId);
						leadGeneration = leadPool.generation;
						// `num_ctx` is the private budget on a server that says so,
						// and the shared prefix rides above it. A new conversation
						// then books its window minus what it shares -- the whole
						// point of sharing, in admission terms: N conversations
						// cost N·(W − P) + P, not N·W. A resumed one keeps what it
						// was granted (the resume rule), which is already that.
						if (
							leadPool.privateWindow &&
							typeof body.num_ctx === "number" &&
							getPolykvGrantedWindow(extras.sessionId) === undefined
						) {
							const budget = Math.max(1, body.num_ctx - leadPool.sharedTokens);
							sharedAboveBudget = body.num_ctx - budget;
							body.num_ctx = budget;
							if (typeof body.num_ctx_min === "number") {
								body.num_ctx_min = Math.min(body.num_ctx_min, budget);
							}
						}
					}
					leadSession = extras.sessionId;
					leadAskedWindow = body.num_ctx !== undefined;
				}
				if (negotiation && typeof body.num_ctx === "number") {
					negotiation.ask = body.num_ctx;
					// No floor stated is "all or nothing"; a resume's floor is its
					// ask by construction.
					negotiation.floor = negotiation.resume
						? body.num_ctx
						: typeof body.num_ctx_min === "number"
							? body.num_ctx_min
							: body.num_ctx;
					// Without the atomic negotiation the server ignores the field;
					// the floor stays on this side and is applied to the refusal.
					if (!negotiation.atomic) {
						delete body.num_ctx_min;
					}
				}
			}
			// The heartbeat, on every streaming request to a server that sends
			// one: a lead's, a plain session's, an unpooled one's alike.
			if (await keepaliveAdvertised(options.baseUrl, base, body)) {
				keepalive = requestStreamKeepalive(body);
			}
			nextInit = { ...init, body: JSON.stringify(body) };
		}
		const sendWire = async (wire: Record<string, unknown> | undefined) => {
			const response = await base(input, {
				...nextInit,
				...(wire ? { body: JSON.stringify(wire) } : {}),
				// Prefill is the reason this matters: creating or attaching a pool
				// can compute a very long prefix, and undici's default header
				// timeout is five minutes.
				...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
			} as RequestInit);
			// With the heartbeat a first-result error arrives inside a 200
			// stream; put it back as the HTTP error every path below reads.
			return keepalive
				? superviseKeepaliveStream(response, {
						...keepalive,
						...(extras?.sessionId !== undefined
							? {
									onPhase: (phase) =>
										reportPolykvStreamPhase(extras.sessionId as string, phase),
								}
							: {}),
						// Dead, not slow: whatever pools it held may be gone with it.
						onDead: () => {
							if (options.baseUrl) {
								notePolykvServerFault(options.baseUrl);
							}
						},
					})
				: response;
		};
		const leadBaseUrl = options.baseUrl;
		const send = async (wire: Record<string, unknown> | undefined) => {
			// A lead pool id is a number the server issued; after a restart the
			// new server issues the same numbers to other pools. If the server
			// was seen to restart since this request chose its pool -- a window
			// refusal waited out across it -- the turn goes unpooled, which is
			// slower and never wrong, and the next one rebuilds the chain.
			let outgoing = wire;
			if (
				leadGeneration !== undefined &&
				leadBaseUrl &&
				polykvRootGeneration(leadBaseUrl) !== leadGeneration
			) {
				const { pool_id: _stale, ...rest } = wire ?? body ?? {};
				outgoing = rest;
			}
			try {
				const response = await sendWire(outgoing);
				if (
					leadGeneration !== undefined &&
					leadBaseUrl &&
					[502, 503, 504].includes(response.status)
				) {
					notePolykvServerFault(leadBaseUrl);
				}
				return response;
			} catch (error) {
				// Thrown on the way to a pooled lead turn: the server may be
				// restarting, and the pools with it. The next turn asks first.
				if (leadGeneration !== undefined && leadBaseUrl) {
					notePolykvServerFault(leadBaseUrl);
				}
				throw error;
			}
		};

		// A refusal goes back as a response, not as a throw.
		//
		// The admission gate runs `enforced` by default, so `429` + `Retry-After`
		// is a normal operating condition on a busy server rather than a fault.
		// Thrown from inside the fetch it never reached the error classifier --
		// the layer that knows a refusal is worth waiting out -- and surfaced as
		// a transport failure, so the caller gave up on a server that had told it
		// exactly when to come back.
		//
		// The one exception is a WINDOW refusal below the floor, settled in
		// `negotiateWindow`: that one has had its wait, and is thrown so that
		// nothing downstream waits it out again.
		//
		// Note what is NOT done here: the body is not consulted for the status.
		// On c7, the published release, the refusal is a `429` carrying a body
		// that says `503`/`unavailable_error`; the status line is the half that
		// is right on both releases.
		const window =
			negotiation?.ask !== undefined && negotiation.floor !== undefined
				? {
						atomic: negotiation.atomic,
						resume: negotiation.resume,
						ask: negotiation.ask,
						floor: negotiation.floor,
					}
				: undefined;
		const first = await send(undefined);
		const outcome =
			window && body && first.status === 429
				? await negotiateWindow({
						first,
						body,
						window,
						send,
						sleep: options.sleep ?? abortableSleep,
						maxWaitMs: extras?.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS,
						signal: init?.signal ?? undefined,
					})
				: { response: first, asked: window?.ask };
		const response = outcome.response;

		if (leadSession !== undefined && leadAskedWindow && response.ok) {
			markLeadWindowLive(leadSession);
		}
		if (
			leadGeneration !== undefined &&
			options.baseUrl &&
			response.ok &&
			!response.headers.has("x-context-window")
		) {
			// Every opencoti response names its window. A pooled lead turn that
			// does not is a pool the server no longer holds -- restarted, or its
			// window lapsed -- and the next turn asks the server first.
			notePolykvServerFault(options.baseUrl);
		}
		const sessionId = extras?.sessionId;
		// Every admitted response, header or not: an absent `X-Context-Window`
		// is an observation too -- "unknown" -- and must replace whatever the
		// last response said rather than let it stand.
		if (sessionId !== undefined && response.ok) {
			noteWindowGrant(
				sessionId,
				numberOrUndefined(response.headers.get("x-context-window")),
				outcome.asked,
				sharedAboveBudget,
			);
		}
		const onFacts = noticeDivergence(sessionId, options.onFacts);
		return sessionId !== undefined || options.onFacts
			? observeResponseFacts(response, (facts) =>
					onFacts(
						outcome.asked !== undefined && facts.contextWindow !== undefined
							? { ...facts, askedWindow: outcome.asked }
							: facts,
					),
				)
			: response;
	}) as typeof fetch;
}

/** How this request's window is being negotiated. */
interface WindowNegotiation {
	/** `ctx_min_negotiation_v1`: the server settles ask and floor in one admission. */
	atomic: boolean;
	resume: boolean;
	ask?: number;
	floor?: number;
}

/**
 * Whether this request should ask for the heartbeat: it streams, and the
 * server advertises `stream_keepalive_v1`. `/props` is read once per root, and
 * only for a streaming request -- a buffered one has no stream to keep alive.
 */
async function keepaliveAdvertised(
	baseUrl: string | undefined,
	fetchImpl: typeof fetch,
	body: Record<string, unknown>,
): Promise<boolean> {
	if (!baseUrl || body.stream !== true) {
		return false;
	}
	const props = await probeOpencotiProps(baseUrl, fetchImpl).catch(
		() => undefined,
	);
	return hasOpencotiFeature(props?.features, OPENCOTI_FEATURES.streamKeepalive);
}

/** The two flags the window request branches on, read off `/props`. */
async function windowFeatures(
	baseUrl: string | undefined,
	fetchImpl: typeof fetch,
): Promise<{ guaranteed: boolean; atomic: boolean }> {
	const props = await probeOpencotiProps(baseUrl, fetchImpl).catch(
		() => undefined,
	);
	return {
		guaranteed: hasOpencotiFeature(
			props?.features,
			OPENCOTI_FEATURES.guaranteedAlloc,
		),
		atomic: hasOpencotiFeature(
			props?.features,
			OPENCOTI_FEATURES.ctxMinNegotiation,
		),
	};
}

/**
 * Record what an admitted response said about the window.
 *
 * `granted` undefined is a response with no `X-Context-Window`: not guaranteed,
 * so the observation is UNKNOWN, and the remembered grant -- the booking the
 * resume rule rests on -- is left exactly as it was.
 */
function noteWindowGrant(
	sessionId: string,
	granted: number | undefined,
	asked: number | undefined,
	sharedTokens: number | undefined,
): void {
	if (granted !== undefined) {
		recordPolykvGrantedWindow(sessionId, granted, {
			...(asked !== undefined ? { asked } : {}),
			...(sharedTokens !== undefined ? { sharedTokens } : {}),
		});
	}
	recordPolykvWindowObservation(sessionId, {
		...(granted !== undefined ? { granted } : {}),
		...(asked !== undefined ? { asked } : {}),
		...(sharedTokens !== undefined ? { sharedTokens } : {}),
	});
}

/** What a 429 says about the window, when it is a window refusal at all. */
interface WindowRefusal {
	largestAdmissible?: number;
	retryAfterMs?: number;
}

/**
 * Read `largest_admissible` off a refusal: the header, or the body field.
 *
 * A 429 without either is not a window refusal -- the throughput floor refuses
 * with the same status -- and is left to the rate-limit middleware, which waits
 * it out the way it always has.
 */
async function readWindowRefusal(response: Response): Promise<WindowRefusal> {
	const seconds = Number(response.headers.get("retry-after"));
	const retryAfterMs =
		Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
	const header = numberOrUndefined(
		response.headers.get("x-context-largest-admissible"),
	);
	if (header !== undefined) {
		return { largestAdmissible: header, retryAfterMs };
	}
	try {
		const parsed = JSON.parse(await response.clone().text()) as Record<
			string,
			unknown
		>;
		const nested = (parsed?.error ?? {}) as Record<string, unknown>;
		const value = parsed?.largest_admissible ?? nested?.largest_admissible;
		return typeof value === "number" && Number.isFinite(value)
			? { largestAdmissible: value, retryAfterMs }
			: { retryAfterMs };
	} catch {
		return { retryAfterMs };
	}
}

/**
 * Settle a window refusal (PLANS §9c, §9k).
 *
 * - **Atomic** (`ctx_min_negotiation_v1`): the server already granted the
 *   largest window in `[floor, ask]` if one fit, so a window refusal here is
 *   below the floor.
 * - **Not atomic**: a refusal naming `largest_admissible` at or above the floor
 *   is retried ONCE at exactly that window. Another arrival can take the cells
 *   in between -- the race the atomic path does not have -- and then this is
 *   below the floor too.
 * - **Below the floor, new session**: wait once, the server's `Retry-After`
 *   bounded by `maxRetryAfterMs`, and ask again from the top. Still below:
 *   refuse.
 * - **Below the floor, resume**: refuse at once. Never a wait, never a smaller
 *   window.
 *
 * Returns the response to hand on, and the window it asked for, when it is not
 * a refusal below the floor. Throws {@link OpencotiWindowUnavailableError} when
 * it is.
 */
async function negotiateWindow(input: {
	first: Response;
	body: Record<string, unknown>;
	window: { atomic: boolean; resume: boolean; ask: number; floor: number };
	send: (wire: Record<string, unknown> | undefined) => Promise<Response>;
	sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	maxWaitMs: number;
	signal?: AbortSignal;
}): Promise<{ response: Response; asked: number }> {
	const { window } = input;
	const discard = (response: Response) =>
		response.body?.cancel().catch(() => {});
	// One pass: the refusal in hand, and the single retry at `largest` the
	// non-atomic path allows. `below` carries the refusal that ended it.
	const pass = async (
		refused: Response,
	): Promise<
		| { response: Response; asked: number; below?: undefined }
		| { below: WindowRefusal; response?: undefined }
	> => {
		let refusal = await readWindowRefusal(refused);
		if (refusal.largestAdmissible === undefined) {
			return { response: refused, asked: window.ask };
		}
		if (
			!window.atomic &&
			!window.resume &&
			refusal.largestAdmissible >= window.floor &&
			refusal.largestAdmissible < window.ask
		) {
			// `asked` stays the conversation's own ask: a grant of `smaller` is
			// exactly the "asked 256k, got 160k" the context bar reports.
			const smaller = Math.floor(refusal.largestAdmissible);
			await discard(refused);
			const retried = await input.send({ ...input.body, num_ctx: smaller });
			if (retried.status !== 429) {
				return { response: retried, asked: window.ask };
			}
			refusal = await readWindowRefusal(retried);
			if (
				refusal.largestAdmissible === undefined ||
				refusal.largestAdmissible >= window.floor
			) {
				// Not a window refusal after all, or one the rate-limit layer
				// can still wait out: hand it on as the 429 it is.
				return { response: retried, asked: window.ask };
			}
			await discard(retried);
			return { below: refusal };
		}
		if (refusal.largestAdmissible >= window.floor) {
			// The window fits by the server's own account, so this refusal is
			// about something else -- throughput, a settling hold. Not ours.
			return { response: refused, asked: window.ask };
		}
		await discard(refused);
		return { below: refusal };
	};

	const refuse = (refusal: WindowRefusal): never => {
		throw new OpencotiWindowUnavailableError({
			asked: window.ask,
			floor: window.floor,
			...(refusal.largestAdmissible !== undefined
				? { largestAdmissible: refusal.largestAdmissible }
				: {}),
			resume: window.resume,
		});
	};

	const firstPass = await pass(input.first);
	if (firstPass.below === undefined) {
		return firstPass;
	}
	if (window.resume) {
		return refuse(firstPass.below);
	}
	await input.sleep(
		Math.min(
			Math.max(0, input.maxWaitMs),
			firstPass.below.retryAfterMs ?? DEFAULT_WINDOW_WAIT_MS,
		),
		input.signal,
	);
	const again = await input.send(undefined);
	if (again.status !== 429) {
		return { response: again, asked: window.ask };
	}
	const secondPass = await pass(again);
	if (secondPass.below === undefined) {
		return secondPass;
	}
	return refuse(secondPass.below);
}

/** The wait when a below-floor refusal named no `Retry-After`. */
const DEFAULT_WINDOW_WAIT_MS = 2_000;

/**
 * A pool divergence, worded for the agent's row.
 *
 * `pool_match` is where the two token streams part, so it is also the token
 * the server names in its log ("diverges from the pool prompt at token 4").
 */
export function poolDivergenceNotice(facts: OpencotiResponseFacts): string {
	const format = (value: number | undefined) =>
		value === undefined ? "?" : Intl.NumberFormat("en-US").format(value);
	return `Pool ${facts.poolId ?? "?"} shared only ${format(facts.poolMatchTokens)} of its ${format(facts.poolLengthTokens)} tokens: this request's prompt diverges from the pool at token ${format(facts.poolMatchTokens)}, so each turn prefills the whole prompt again.`;
}

/**
 * `onFacts`, with a pool divergence also put on the agent's row.
 *
 * Here and not in a caller's `onFacts`: this is the one place that knows both
 * the response and whose it is, for every fetch the vendor builds. The turn
 * succeeds regardless, so it is a fault nobody sees unless it is put where
 * they look.
 */
function noticeDivergence(
	sessionId: string | undefined,
	onFacts: ((facts: OpencotiResponseFacts) => void) | undefined,
): (facts: OpencotiResponseFacts) => void {
	return (facts) => {
		if (
			sessionId !== undefined &&
			facts.poolMatchTokens !== undefined &&
			facts.poolLengthTokens !== undefined &&
			facts.poolMatchTokens < facts.poolLengthTokens
		) {
			reportPolykvNotice(sessionId, {
				severity: "warn",
				text: poolDivergenceNotice(facts),
			});
		}
		onFacts?.(facts);
	};
}

/**
 * Hand what the response says about the turn to `onFacts`, and return a
 * response the caller can still read whole.
 *
 * Shared by the ordinary fetch and the worker's. The worker's read nothing, so
 * a worker whose pool shared 4 of its 5,627 tokens said so to the server log
 * and to nothing on this side -- the one warning written for it was on the
 * other path.
 */
async function observeResponseFacts(
	response: Response,
	onFacts: (facts: OpencotiResponseFacts) => void,
): Promise<Response> {
	const facts: OpencotiResponseFacts = {
		...(numberOrUndefined(response.headers.get("x-sessions-remaining")) !==
		undefined
			? {
					sessionsRemaining: numberOrUndefined(
						response.headers.get("x-sessions-remaining"),
					) as number,
				}
			: {}),
		...(numberOrUndefined(response.headers.get("x-polykv-settle-waived")) !==
		undefined
			? {
					settleWaivedMs: numberOrUndefined(
						response.headers.get("x-polykv-settle-waived"),
					) as number,
				}
			: {}),
		...(numberOrUndefined(response.headers.get("x-context-window")) !==
		undefined
			? {
					contextWindow: numberOrUndefined(
						response.headers.get("x-context-window"),
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
	return response;
}

/** Statuses that mean the server behind the address did not answer. */
const SERVER_FAULT_STATUSES = new Set([502, 503, 504]);

/**
 * The fetch of one swarm agent.
 *
 * Attaches each request to the pool tree its messages match, then honours the
 * engine's admission: a "session allocation full (worker of ...)" refusal is a
 * queue on a window the other agents are draining, so it waits the
 * `Retry-After` the engine names and sends again. An agent that has not yet run
 * a single turn first tries a fresh owner instead -- the engine decides whether
 * one fits -- because nothing of it lives on the full one yet.
 *
 * Any other response is returned untouched, and so is a refusal that outlasts
 * the wait: the caller sees the 429 it was.
 *
 * **Priority 0 (§9g), a worker whose owner is the lead's own session**, differs
 * in exactly the place the lead-window hazard lives (991ce2466: 49 of 51 agents
 * lost to one full lead window). Until it has run a turn, the window is not the
 * agent's to wait on: it is the conversation's, and there are Agent Nodes to go
 * to instead. So before its first turn the lead's free room is checked against
 * a reserve kept for the conversation, and a lead window below it -- or the
 * engine's own "worker of ... full" -- is handed straight back as the refusal
 * it is. The spawn queue reads that as "refused before admission" and places
 * the agent on the next tier. After its first turn it waits like any worker:
 * it has work in flight, and a worker that finishes frees what it needs.
 */
function createWorkerFetch(options: {
	fetch?: typeof fetch;
	dispatcher?: unknown;
	worker: PolykvWorkerSpec;
	baseUrl: string;
	headers?: Record<string, string>;
	onFacts?: (facts: OpencotiResponseFacts) => void;
	workerMaxTokens?: number;
}): typeof fetch {
	const base = options.fetch ?? fetch;
	const observed = (response: Response) =>
		observeResponseFacts(
			response,
			noticeDivergence(options.worker.sessionId, options.onFacts),
		);
	let ranOnce = false;
	// The lead's session, lent to this agent (priority 0). A summary call is
	// the agent's own and attaches to what exists: it is never the agent's
	// first turn, and is never refused for the lead's sake.
	const lent = options.worker.attachOnly ? undefined : options.worker.owner;
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		if (!init?.body || typeof init.body !== "string") {
			return base(input, init);
		}
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(init.body) as Record<string, unknown>;
		} catch {
			return base(input, init);
		}
		rememberOpencotiSession(
			options.worker.sessionId,
			options.baseUrl,
			base,
			options.headers,
		);
		const signal = init.signal ?? undefined;
		if (lent && !ranOnce && polykvWorkerStarted(options.worker.sessionId)) {
			ranOnce = true;
		}
		if (lent && !ranOnce) {
			const room = await readPolykvLeadRoom({
				baseUrl: options.baseUrl,
				fetch: base,
				...(options.headers ? { headers: options.headers } : {}),
				owner: lent,
			});
			if (room && room.free < room.reserve) {
				return leadReserveRefusal(lent, room);
			}
		}
		/**
		 * The server dropped this request before any of it streamed: the
		 * connection was refused or reset, or the gateway in front of it
		 * answered 502/503/504. For an agent that has started, wait for the
		 * server to answer `/health` again and send the same turn -- nothing of
		 * it ran. Measured on 1tmrl: the server was listening again ten seconds
		 * after it restarted, and the agents on it had already ended.
		 *
		 * An agent that has not started is handed the failure instead: the
		 * spawn queue places it again, possibly on a node that is up.
		 *
		 * `false` means "not ours to wait out"; the caller fails as before.
		 */
		const waitOutServerFault = async (fault: unknown): Promise<boolean> => {
			const started = ranOnce || polykvWorkerStarted(options.worker.sessionId);
			if (signal?.aborted || !started) {
				return false;
			}
			if (fault instanceof Response) {
				await fault.body?.cancel().catch(() => {});
			} else if (classifyTurnFaultError(fault) !== "transport") {
				return false;
			}
			reportPolykvRoomWait(options.worker.sessionId, {
				waiting: true,
				reason: `Waiting for the server to come back (${
					fault instanceof Response
						? `it answered ${fault.status}`
						: "it is not answering"
				}); the turn is sent again once it does.`,
			});
			// The server may be a new one when it answers: its pools are then
			// gone, and the ids this agent's tree holds name nothing -- or
			// someone else's. The next prepare asks before it resolves any.
			notePolykvServerFault(options.baseUrl);
			const back = await waitForServerHealth(polykvRoot(options.baseUrl), {
				fetch: base,
				...(options.headers ? { headers: options.headers } : {}),
				...(signal ? { signal } : {}),
			});
			if (!back) {
				throw signal?.reason ?? new Error("aborted");
			}
			return true;
		};
		// Refusals waited on in a row, for the backoff. No deadline: a full
		// window is a queue the other agents are draining, and an agent that
		// has started is meant to finish (ruled after 1tmrl, where a worker
		// that outwaited fifteen minutes became the refusal it was waiting on).
		let waits = 0;
		let fresh = false;
		// One fresh owner per agent, at most: after that a full window is a
		// queue to wait in, not a reason to keep opening owners.
		let triedFresh = false;
		while (true) {
			const attach = await preparePolykvWorker({
				spec: options.worker,
				baseUrl: options.baseUrl,
				fetch: base,
				...(options.headers ? { headers: options.headers } : {}),
				body,
				signal,
				fresh,
			});
			const wire: Record<string, unknown> = { ...body };
			// A worker books nothing: its window is the owner's.
			delete wire.num_ctx;
			delete wire.num_ctx_min;
			// P2: a worker always declares its output, so a refusal lands at
			// arrival instead of after a prefill spent on a reply that cannot fit
			// the owner's window. The gateway's cap is kept where it sent one.
			if (!declaresOutputCap(wire)) {
				wire.max_tokens = options.workerMaxTokens ?? 8_192;
			}
			wire.session_id = attach.sessionId;
			if (
				attach.poolId !== undefined &&
				attach.generation !== undefined &&
				attach.generation !== polykvRootGeneration(options.baseUrl)
			) {
				// A restart was found between resolving this id and sending
				// it: it is a number from a boot that is gone. Resolve again.
				continue;
			}
			if (attach.poolId !== undefined && /^\d+$/.test(attach.poolId)) {
				wire.pool_id = Number(attach.poolId);
			}
			const keepalive = (await keepaliveAdvertised(options.baseUrl, base, wire))
				? requestStreamKeepalive(wire)
				: undefined;
			if (lent && !ranOnce && attach.poolId === undefined) {
				// Priority 0 without a sub-pool is not priority 0: the lead's
				// session is at its eight per slot, or the server's pool
				// reservoir is empty -- the engine refuses both alike (mail
				// 269). Either way priority 0 is full for this agent, and it
				// goes to the nodes rather than running unpooled on the lead's
				// server as a session of its own.
				return leadReserveRefusal(lent, undefined);
			}
			let response: Response;
			try {
				response = await base(input, {
					...init,
					body: JSON.stringify(wire),
					...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
				} as RequestInit);
				// A first-result error inside a 200 stream goes back to being
				// the HTTP error the window-full and server-fault waits read.
				// A heartbeat that stops before the first event throws here,
				// as the transport fault it is, into the server-fault wait
				// below; one that stops later errors the stream, and the turn
				// recovery takes it from there.
				if (keepalive) {
					response = await superviseKeepaliveStream(response, {
						...keepalive,
						onPhase: (phase) =>
							reportPolykvStreamPhase(options.worker.sessionId, phase),
						onDead: () => notePolykvServerFault(options.baseUrl),
					});
				}
			} catch (error) {
				if (!(await waitOutServerFault(error))) {
					throw error;
				}
				continue;
			}
			if (
				SERVER_FAULT_STATUSES.has(response.status) &&
				(await waitOutServerFault(response))
			) {
				continue;
			}
			if (response.status !== 429 || attach.poolId === undefined) {
				if (response.ok) {
					ranOnce = true;
					markPolykvWorkerStarted(options.worker.sessionId);
					const windowless =
						attach.poolId !== undefined &&
						!response.headers.has("x-context-window");
					if (windowless) {
						// Every opencoti response names its window. A pooled
						// turn that does not is a pool the server no longer
						// holds -- restarted, or its owner lapsed -- and the next
						// turn asks the server before resolving any pool.
						notePolykvServerFault(options.baseUrl);
					}
					if (options.worker.owner && windowless) {
						// Every opencoti response names its window. One that
						// does not is the sign the lead's allocation lapsed (idle
						// TTL) or was closed, taking this agent's sub-pool with
						// it: the engine does not refuse a released pool, it
						// prefills the whole prompt again in silence.
						reportPolykvNotice(options.worker.sessionId, {
							severity: "warn",
							text: `No X-Context-Window on this turn: the lead's session ${engineSessionId(options.worker.owner)} may have lapsed and released this agent's sub-pool, so the turn was prefilled in full.`,
						});
					}
				}
				reportPolykvRoomWait(options.worker.sessionId, { waiting: false });
				return observed(response);
			}
			const text = await response
				.clone()
				.text()
				.catch(() => "");
			if (!isWorkerWindowFull(response.status, text)) {
				reportPolykvRoomWait(options.worker.sessionId, { waiting: false });
				return observed(response);
			}
			if (lent && !ranOnce) {
				// Not started, and the full window is the lead's: back to the
				// spawn queue, which places it on the next tier.
				reportPolykvRoomWait(options.worker.sessionId, { waiting: false });
				return observed(response);
			}
			await response.body?.cancel().catch(() => {});
			if (!ranOnce && !triedFresh) {
				triedFresh = true;
				fresh = true;
				continue;
			}
			fresh = false;
			// Another owner of this swarm may have room this one lacks. Tried
			// before waiting, on every refusal: the room moves as agents end.
			if (await movePolykvWorker(options.worker.sessionId)) {
				continue;
			}
			const seconds = Number(response.headers.get("retry-after"));
			reportPolykvRoomWait(options.worker.sessionId, {
				waiting: true,
				reason:
					"Waiting for room on the server: this swarm's window is full, and it starts when another agent finishes.",
			});
			waits += 1;
			await new Promise<void>((resolve, reject) => {
				const handle = setTimeout(
					resolve,
					polykvRoomBackoffMs(
						waits,
						Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000,
					),
				);
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(handle);
						reject(signal.reason ?? new Error("aborted"));
					},
					{ once: true },
				);
			});
		}
	}) as typeof fetch;
}

/**
 * The refusal a priority-0 agent gets when the lead's window is below its
 * reserve: worded as the engine words a full owner, because that is what
 * every reader of it -- the retry middleware, the spawn queue -- already
 * treats as "not started, place it elsewhere".
 */
function leadReserveRefusal(
	owner: string,
	room: PolykvLeadRoom | undefined,
): Response {
	const why = room
		? `${room.free} of ${room.window} cells free, the conversation keeps ${room.reserve}`
		: "no sub-pool: the session's per-slot limit or the server's pool reservoir";
	return new Response(
		JSON.stringify({
			error: {
				message: `admission rejected: session allocation full (worker of '${engineSessionId(owner)}': ${why}) — priority 0 is full; overflowing to the Agent Nodes`,
				type: "polykv_lead_reserve",
			},
		}),
		{
			status: 429,
			headers: { "content-type": "application/json", "retry-after": "1" },
		},
	);
}

/** Whether a chat body already states how long the reply may run. */
function declaresOutputCap(body: Record<string, unknown>): boolean {
	return ["max_tokens", "max_completion_tokens", "n_predict"].some((key) => {
		const value = body[key];
		return typeof value === "number" && Number.isFinite(value) && value > 0;
	});
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
	const worker = read("polykvWorker") as PolykvWorkerSpec | undefined;
	// The section wins where it says anything; the loose key is the fallback.
	const overcommit = settings?.overcommit ?? read("polykvOvercommit");
	// The live pool wins over anything the config froze: after a compaction
	// re-roots the conversation the configured id names a pool that has been
	// released.
	const live = getPolykvSession(
		typeof sessionId === "string" ? sessionId : undefined,
	);
	const window = resolveOpencotiWindow(
		typeof sessionId === "string" ? sessionId : undefined,
		settings,
		context.model?.contextWindow,
	);
	const poolId =
		live?.poolId ??
		(typeof configuredPool === "string" && configuredPool
			? configuredPool
			: undefined);
	if (
		worker &&
		typeof worker.group === "string" &&
		typeof worker.sessionId === "string" &&
		settings?.enabled !== false
	) {
		const admission = settings?.overcommit
			? undefined
			: polykvAdmissionPolicy(settings);
		return {
			worker: admission ? { ...worker, admission } : worker,
			sessionId: worker.sessionId,
			...(typeof overcommit === "boolean" ? { overcommit } : {}),
			workerMaxTokens: resolveWorkerMaxTokens(context.model),
		};
	}
	return {
		...(poolId ? { poolId } : {}),
		...(typeof sessionId === "string" && sessionId ? { sessionId } : {}),
		...(typeof sharedPrefix === "number" && Number.isFinite(sharedPrefix)
			? { sharedPrefixTokens: sharedPrefix }
			: {}),
		...(typeof overcommit === "boolean" ? { overcommit } : {}),
		// A conversation's place in the lead tree is keyed by its session: no
		// session, no place to hold.
		...(settings?.enabled !== false &&
		typeof sessionId === "string" &&
		sessionId
			? { leadPool: true }
			: {}),
		...window,
		...(typeof settings?.maxRetryAfterMs === "number" &&
		Number.isFinite(settings.maxRetryAfterMs) &&
		settings.maxRetryAfterMs >= 0
			? { maxRetryAfterMs: settings.maxRetryAfterMs }
			: {}),
	};
}

/**
 * The cap a worker declares when the gateway sent none.
 *
 * The model's own ceiling where the catalog has one; otherwise a quarter of the
 * window, floored at 1,024 so a tiny window still leaves a reply room;
 * otherwise a flat 8,192. Any of these is
 * better than nothing on the wire, which is the one value P2 rules out.
 */
function resolveWorkerMaxTokens(
	model: { contextWindow?: number; maxOutputTokens?: number } | undefined,
): number {
	if (isPositiveInteger(model?.maxOutputTokens)) {
		return Math.floor(model.maxOutputTokens);
	}
	if (isPositiveInteger(model?.contextWindow)) {
		return Math.max(1_024, Math.floor(model.contextWindow / 4));
	}
	return 8_192;
}

/**
 * What window to ask for, and what floor to accept.
 *
 * Two cases, and the first one is the resume rule:
 *
 * - **A session we have already seen granted a window** asks for exactly that
 *   window, floored at itself. That is "the window I had, or refuse" -- a
 *   resumed conversation's history no longer fits a smaller one, so a silent
 *   shrink truncates it mid-thread. The server cannot make this distinction
 *   for us: after the idle TTL it has forgotten the session, and a resume is an
 *   ordinary new admission from where it stands. We can, because we remember
 *   what we were granted. On a turn that is still a continuation the server
 *   ignores both fields, so the only turn where this changes anything is the
 *   one after the hold lapsed -- which is exactly the resume.
 *
 * - **A fresh session** asks for the configured window and floors at
 *   `contextFloor`, letting the server settle the two atomically.
 *
 * With `dynamicContextSize` off, neither is sent and the engine decides.
 */
function resolveOpencotiWindow(
	sessionId: string | undefined,
	settings: PolykvOptions | undefined,
	configuredWindow: number | undefined,
): { numCtx?: number; numCtxMin?: number; resume?: boolean } {
	if (settings?.dynamicContextSize !== true) {
		return {};
	}
	const granted = getPolykvGrantedWindow(sessionId);
	if (granted !== undefined) {
		return { numCtx: granted, numCtxMin: granted, resume: true };
	}
	if (!isPositiveInteger(configuredWindow)) {
		return {};
	}
	const floor = settings.contextFloor;
	return {
		numCtx: configuredWindow,
		// No floor means no smaller window was declared acceptable, so the ask
		// is all-or-nothing rather than silently open-ended.
		...(isPositiveInteger(floor) ? { numCtxMin: floor } : {}),
	};
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
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
		...(baseURL ? { baseUrl: baseURL } : {}),
		...(config.headers ? { headers: config.headers } : {}),
		onFacts: (facts) => {
			// Asked for one window, given another. The grant itself is recorded
			// by the fetch, beside the ask that produced it; this is the line in
			// the log. On a continuation a mismatch is expected -- the server
			// ignores a changed `num_ctx` and keeps the held one -- and on a new
			// admission it means the floor was used. Either way the conversation
			// is now sized against a number nobody chose.
			if (
				facts.contextWindow !== undefined &&
				facts.askedWindow !== undefined &&
				facts.contextWindow !== facts.askedWindow
			) {
				context.logger?.log(
					`[opencoti] asked for a ${facts.askedWindow}-token window, granted ${facts.contextWindow}`,
					{
						severity: facts.contextWindow < facts.askedWindow ? "warn" : "info",
					},
				);
			}
			// A pool prompt that diverges from the rendered request is a bug on
			// this side -- the prefix was built from something other than what
			// the request renders -- and the turn succeeds regardless, so this
			// is the only place it can surface.
			if (
				facts.poolMatchTokens !== undefined &&
				facts.poolLengthTokens !== undefined &&
				facts.poolMatchTokens < facts.poolLengthTokens
			) {
				context.logger?.log(
					`[opencoti] pool ${facts.poolId ?? "?"} matched ${facts.poolMatchTokens} of its ${facts.poolLengthTokens} tokens: its prompt diverges from this request's (the server log names the token)`,
					{ severity: "warn" },
				);
			}
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
