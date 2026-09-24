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
import {
	getPolykvGrantedWindow,
	getPolykvSession,
	polykvAdmissionPolicy,
	recordPolykvGrantedWindow,
} from "./polykv";
import {
	hoistLeadEnvironment,
	markLeadWindowLive,
	prepareLeadPool,
} from "./polykv-lead";
import {
	engineSessionId,
	isWorkerWindowFull,
	movePolykvWorker,
	POLYKV_WORKER_MAX_WAIT_MS,
	type PolykvWorkerSpec,
	preparePolykvWorker,
	rememberOpencotiSession,
	reportPolykvNotice,
	reportPolykvRoomWait,
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
	 * Requires `ctx_min_negotiation_v1`. Without it the field is ignored and
	 * the caller must fall back to retrying against `largest_admissible`.
	 */
	numCtxMin?: number;
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
}): typeof fetch {
	const base = options.fetch ?? fetch;
	const worker = options.request?.worker;
	if (worker && options.baseUrl) {
		return createWorkerFetch({ ...options, worker, baseUrl: options.baseUrl });
	}
	return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		let nextInit = init;
		const extras = options.request;
		let leadSession: string | undefined;
		let leadAskedWindow = false;
		if (init?.body && typeof init.body === "string") {
			try {
				const body = JSON.parse(init.body) as Record<string, unknown>;
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
								const budget = Math.max(
									1,
									body.num_ctx - leadPool.sharedTokens,
								);
								body.num_ctx = budget;
								if (typeof body.num_ctx_min === "number") {
									body.num_ctx_min = Math.min(body.num_ctx_min, budget);
								}
							}
						}
						leadSession = extras.sessionId;
						leadAskedWindow = body.num_ctx !== undefined;
					}
				}
				nextInit = { ...init, body: JSON.stringify(body) };
			} catch {
				// A body that is not JSON is not ours to rewrite. The request goes
				// as it was: an unpooled turn is slower, a mangled one is broken.
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
		if (leadSession !== undefined && leadAskedWindow && response.ok) {
			markLeadWindowLive(leadSession);
		}
		return extras?.sessionId !== undefined || options.onFacts
			? observeResponseFacts(
					response,
					noticeDivergence(extras?.sessionId, options.onFacts),
				)
			: response;
	}) as typeof fetch;
}

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
 */
function createWorkerFetch(options: {
	fetch?: typeof fetch;
	dispatcher?: unknown;
	worker: PolykvWorkerSpec;
	baseUrl: string;
	headers?: Record<string, string>;
	onFacts?: (facts: OpencotiResponseFacts) => void;
}): typeof fetch {
	const base = options.fetch ?? fetch;
	const observed = (response: Response) =>
		observeResponseFacts(
			response,
			noticeDivergence(options.worker.sessionId, options.onFacts),
		);
	let ranOnce = false;
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
		const deadline = Date.now() + POLYKV_WORKER_MAX_WAIT_MS;
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
			wire.session_id = attach.sessionId;
			if (attach.poolId !== undefined && /^\d+$/.test(attach.poolId)) {
				wire.pool_id = Number(attach.poolId);
			}
			const response = await base(input, {
				...init,
				body: JSON.stringify(wire),
				...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
			} as RequestInit);
			if (response.status !== 429 || attach.poolId === undefined) {
				if (response.ok) {
					ranOnce = true;
				}
				reportPolykvRoomWait(options.worker.sessionId, { waiting: false });
				return observed(response);
			}
			const text = await response
				.clone()
				.text()
				.catch(() => "");
			if (!isWorkerWindowFull(response.status, text) || Date.now() > deadline) {
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
			await new Promise<void>((resolve, reject) => {
				const handle = setTimeout(
					resolve,
					Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2000,
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
	};
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
): { numCtx?: number; numCtxMin?: number } {
	if (settings?.dynamicContextSize !== true) {
		return {};
	}
	const granted = getPolykvGrantedWindow(sessionId);
	if (granted !== undefined) {
		return { numCtx: granted, numCtxMin: granted };
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
			// The grant, remembered. Every later admission for this session
			// asks for exactly it, which is how a resume gets the window it was
			// opened with rather than whatever happens to be free.
			if (facts.contextWindow !== undefined && request.sessionId) {
				recordPolykvGrantedWindow(request.sessionId, facts.contextWindow);
				if (
					request.numCtx !== undefined &&
					facts.contextWindow !== request.numCtx
				) {
					// Asked for one window, given another. On a continuation
					// this is expected -- the server ignores a changed `num_ctx`
					// and keeps the held one -- and on a new admission it means
					// the floor was used. Either way it is worth saying, because
					// the conversation is now sized against a number nobody
					// chose.
					context.logger?.debug(
						`[opencoti] asked for a ${request.numCtx}-token window, holding ${facts.contextWindow}`,
					);
				}
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
