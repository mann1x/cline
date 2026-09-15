/**
 * Client for opencoti-llamafile's PolyKV control plane.
 *
 * PolyKV is a tree of KV pools. A pool owns a token range `[D, L)` and shares
 * everything before `D` with its parent, so the system prompt and tool
 * definitions -- the part of an agent's context that never changes -- can be
 * prefilled once, pinned, and attached by every later request instead of being
 * re-sent and re-computed each turn.
 *
 * That is the whole reason this exists here. Measured on the Ollama path this
 * session: 12,859 tokens of system prompt and tool schemas on every request,
 * and a turn whose prefill ran past five minutes and killed the run. Under
 * PolyKV that prefix is a pinned ancestor pool and the per-turn prefill is the
 * suffix only.
 *
 * Two rules from the engine's own design (`docs/features/polykv_api.md`) are
 * load-bearing for any caller:
 *
 * - **Compaction is a prompt rewrite, never an in-place KV op** (§13.2).
 *   Compacted text is new text; its tokens cannot match the old cells. The
 *   correct primitive is `fork(ancestor, D = D_sys, summary + recent tail)`,
 *   after which sessions migrate and the old subtree is released. Net cells go
 *   down rather than up.
 * - **A pin left on an abandoned subtree is a leak** (§13.2). Discipline is
 *   unpin-after-migrate; the server reports orphans so they can be swept.
 */

/** A pool's identity and how much of the prefix it carries. */
export interface PolykvPool {
	pool_id: string;
	parent?: string;
	branch_pos?: number;
	prefix_len: number;
}

/**
 * What `GET /polykv/pools/{id}/capacity` answers.
 *
 * Transcribed from the engine's own response builder
 * (`server-context.cpp:7047-7125`), not from the design document -- the two
 * disagree, and the builder is the one that runs.
 *
 * **This is not a pollable endpoint on c7.** Every GET folds the settle and
 * bias EWMAs the admission gate learns from, so a dashboard that polls it
 * perturbs the thing it is reporting on. Call it once per admission decision
 * and read live state from `/polykv/pools`, `/props` and `/polykv/tps`, which
 * are served from a published snapshot and are safe to poll while the server
 * is busy. c8 makes the fold explicit and the plain GET read-only.
 *
 * Several fields are deliberately `null` rather than `0` when the number would
 * be a lie -- `vram_free_mib` with no GPU layers, every `swa_*` on a model
 * without a sliding window. Absent must not be read as zero.
 */
export interface PolykvCapacity {
	pool_id?: string;
	can_admit: boolean;
	/**
	 * Why, in the engine's own words. Worth surfacing verbatim: the elastic
	 * refusal is kept distinct from `kv headroom exhausted` on purpose, because
	 * "raise --max-parallel" and "this context does not fit" need different
	 * answers and a merged string cannot carry which one it is.
	 */
	reason?: string;
	/** Whether this read folded the admission learner. c8 and later only. */
	folded?: boolean;

	// Room.
	headroom_sessions?: number;
	kv_headroom_pct?: number;
	kv_cells_free?: number;
	kv_cells_total?: number;
	marginal_tokens_mean?: number;
	expected_tokens?: number;

	// Throughput, and the projection the floor is compared against.
	mean_active_tps?: number;
	n_active_sessions?: number;
	projected_mean_tps_if_admitted?: number;
	projected_mean_tps_model?: number;
	projected_mean_tps_measured?: number;
	projection_bias_ewma?: number;
	drop_per_admit_ewma?: number;
	/** The projection came from the last settled mean, not from live decode. */
	projected_idle_estimate?: boolean;

	// Settled admission (P7). A settling pool is mid-measurement, and a refusal
	// for that reason is a bounded hold rather than a rejection.
	settling?: boolean;
	settle_remaining_ms?: number;
	n_warming?: number;
	n_pool_sessions?: number;
	guaranteed?: boolean;
	/** A continuation of a session the engine already knows, never a new admit. */
	known_session?: boolean;

	// Prefill tax (P8): what stands between now and the next token.
	n_prefilling?: number;
	prefill_backlog_tokens?: number;
	n_soon_sessions?: number;

	// Elastic slots. `slots_live` is what the engine currently permits, which is
	// the number a client plans concurrency against; `slots_max` is the ceiling
	// it may grow to.
	slots_live?: number;
	slots_max?: number;
	slots_free?: number;
	vram_free_mib?: number | null;
	elastic_reason?: string;

	// The sliding-window half, null on a model that has none. `kv_cells_*` above
	// covers the base pool ONLY, so total occupancy cannot be computed from it
	// on an iSWA model.
	swa_active?: boolean;
	swa_cells_total?: number | null;
	swa_cells_free?: number | null;
	swa_cells_needed?: number | null;
	swa_seq_budget?: number | null;
	swa_window?: number | null;
	swa_capacity_sessions?: number | null;

	// Split cache.
	kv_streams_total?: number | null;
	kv_streams_free?: number | null;
	kv_cells_per_stream?: number | null;

	/**
	 * How close the pool is to exhausting context, measured by the engine.
	 *
	 * The reason to care: every compaction trigger on the Ollama path is an
	 * estimate, and the estimates were wrong in both directions on a single
	 * session -- a chars-per-token ratio swinging 3.16 to 5.42, an overhead
	 * term reading 53,323 tokens for a 12,700-token payload. This number is
	 * measured by the thing that owns the cells.
	 */
	compaction_pressure?: number;

	/** The policy in force, echoed back. */
	admission?: {
		set?: boolean;
		target_tps_per_session?: number;
		mode?: "advisory" | "enforced";
		on_saturation?: "reject" | "warn";
		guarantee_min_sessions?: number;
		settle_tokens?: number;
		settle_max_ms?: number;
		prefill_max_slots?: number;
	};
}

export interface PolykvClientOptions {
	/** Server root, with or without a trailing `/v1`. */
	baseUrl: string;
	/**
	 * The fetch to use. Supply the one that honours an undici dispatcher when
	 * there is one: pool creation prefills, and prefill is exactly the thing
	 * that outlives undici's default five-minute header timeout.
	 */
	fetch?: typeof fetch;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

/**
 * Raised when the engine refuses a new session for want of capacity.
 *
 * Carries `retryAfterMs` because the server says how long to wait (RFC 9110)
 * and a caller that ignores it is the reason saturation looks like a network
 * fault.
 */
export class PolykvSaturatedError extends Error {
	constructor(
		message: string,
		readonly retryAfterMs: number | undefined,
		readonly reason?: string,
	) {
		super(message);
		this.name = "PolykvSaturatedError";
	}
}

/** Strip a trailing `/v1` (and any trailing slash): the control plane sits at the root. */
export function polykvRoot(baseUrl: string): string {
	return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function retryAfterMs(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (!header) {
		return undefined;
	}
	const seconds = Number(header);
	if (Number.isFinite(seconds)) {
		return Math.max(0, seconds * 1000);
	}
	const at = Date.parse(header);
	return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/**
 * How a pool's prefix is supplied. Exactly one of these, never two.
 *
 * `prompt` and `from_session` are the two that work. `tokens` is kept because
 * the engine still accepts it, but it puts the caller in charge of reproducing
 * the server's tokenization -- BOS, special tokens, and the chat template --
 * and getting any of that wrong yields a pool that shares nothing while
 * reporting success. `prompt` hands that job back to the server, and
 * `from_session` removes the question entirely by never putting tokens on the
 * wire.
 */
export interface PolykvPrefixSource {
	/** Pre-tokenized ids. The caller owns the tokenization. Prefer the others. */
	tokens?: number[];
	/** Text the server tokenizes itself, the way it tokenizes a completion. */
	prompt?: string;
	/** Snapshot a live session's own token history, zero-copy. */
	from_session?: string;
	/** Snapshot a slot by index. `from_session` is the one a client should use. */
	from_slot?: number;
}

export interface PolykvClient {
	/**
	 * Create a root pool.
	 *
	 * `ephemeral` defaults to `true` for `from_session`/`from_slot` pools and
	 * `false` for `tokens`/`prompt` ones -- a server-side default worth knowing,
	 * because an ephemeral pool is swept once it has been attached, is an
	 * unpinned leaf, and goes 60s without a processing attach. Pin anything that
	 * has to outlive an idle gap.
	 */
	createPool(
		body: PolykvPrefixSource & {
			pin?: boolean;
			ephemeral?: boolean;
			/** Declared expected prefix length, validated server-side. */
			expect_len?: number;
		},
	): Promise<PolykvPool>;
	/**
	 * Branch a pool at `branch_pos`.
	 *
	 * `branch_pos === parent.prefix_len` extends it; anything less is a
	 * copy-on-write branch, and it defaults to the parent's length.
	 *
	 * **The prefix given here is the child's FULL path `[0, L)`, never the
	 * suffix being added.** The engine validates it token-exact against the
	 * parent over `[0, branch_pos)` with `std::equal` and answers `400` on a
	 * mismatch -- so a caller that sends only the new tail has its every fork
	 * rejected, which looks from here like the feature being unavailable.
	 */
	forkPool(
		poolId: string,
		body: PolykvPrefixSource & {
			branch_pos?: number;
			pin?: boolean;
			ephemeral?: boolean;
		},
	): Promise<PolykvPool>;
	pin(poolId: string): Promise<void>;
	unpin(poolId: string): Promise<void>;
	releasePool(poolId: string): Promise<void>;
	capacity(
		poolId: string,
		query?: { expected_tokens?: number },
	): Promise<PolykvCapacity>;
	tokenize(content: string): Promise<number[]>;
	/**
	 * Render messages through the server's own chat template.
	 *
	 * The engine prefills the *templated* token stream, so a prefix assembled
	 * here from the raw system prompt and a JSON dump of the tool schemas is a
	 * different sequence and matches nothing -- the pool reports success and
	 * shares zero tokens. Only the server knows which template it loaded
	 * (`/props.chat_template`) and how it renders tools, so it renders the
	 * prefix and we pin what comes back.
	 */
	applyTemplate(body: {
		messages: readonly unknown[];
		tools?: readonly unknown[];
	}): Promise<string>;
}

/**
 * Which pool each live conversation is currently attached to.
 *
 * A registry rather than a field on the provider config because the two move at
 * different rates: the config is resolved once for a session, and the pool it
 * points at is replaced every time a compaction re-roots the conversation.
 * Compaction is a prompt rewrite -- the compacted text cannot match the old
 * cells -- so the correct primitive is a fork with a new id, and a session that
 * kept reading its pool from a frozen config would keep attaching to the pool
 * that was just released.
 *
 * Keyed by the session id the host already has. Entries are cleared when the
 * session ends; a leaked entry costs a lookup, a leaked *pin* costs the cells,
 * which is why release is a separate and deliberate step.
 */
export interface PolykvSessionState {
	poolId: string;
	/**
	 * Where this pool's own range begins -- the length of the prefix it shares
	 * with its ancestors, and the `branch_pos` a re-root forks at.
	 */
	prefixTokens: number;
}

const POLYKV_SESSIONS = new Map<string, PolykvSessionState>();

export function setPolykvSession(
	sessionId: string,
	state: PolykvSessionState,
): void {
	POLYKV_SESSIONS.set(sessionId, state);
}

export function getPolykvSession(
	sessionId: string | undefined,
): PolykvSessionState | undefined {
	return sessionId ? POLYKV_SESSIONS.get(sessionId) : undefined;
}

export function clearPolykvSession(sessionId: string): void {
	POLYKV_SESSIONS.delete(sessionId);
}

/** Test seam. Does not unpin anything -- see `releasePool` for that. */
export function resetPolykvSessions(): void {
	POLYKV_SESSIONS.clear();
}

/**
 * What one `GET /props` tells us about a server, cached per root.
 *
 * Every branch in this provider keys off one of these, so they are read
 * together, once, rather than probed separately at each call site.
 */
export interface OpencotiProps {
	/**
	 * The release, parsed from `build_info` (`opencoti-0.10.5-c7-...`).
	 *
	 * It decides which signals can be trusted, and the differences are not
	 * cosmetic: on c7 a `429` carries a body that says `503`, `GET /capacity`
	 * mutates the admission learner, the completion response does not say
	 * whether the pool attached, and `/polykv/tps` reports `-1` as the pool key.
	 * A client that assumes the c8 shapes misreads all four in silence.
	 *
	 * `undefined` when the server did not say -- which is every non-opencoti
	 * server, and is why nothing may branch on it being absent except to fall
	 * back to the conservative path.
	 */
	release?: string;
	/** Pools are compiled in AND the server was launched with `--polykv-max-pools`. */
	poolsEnabled: boolean;
	/** The elastic slot controller is armed, so the slot count is not fixed. */
	elastic: boolean;
	/** `slots_live` at the time of the probe; the ceiling is `slotsMax`. */
	slotsLive?: number;
	slotsMax?: number;
	/** The chat template the server will apply. The pool prefix must match it. */
	chatTemplate?: string;
	/** Advertised capabilities, e.g. `slots_nonblocking_v1`. */
	features: readonly string[];
}

const NOT_OPENCOTI: OpencotiProps = {
	poolsEnabled: false,
	elastic: false,
	features: [],
};

const OPENCOTI_PROPS = new Map<string, Promise<OpencotiProps>>();

/**
 * The release, when the build says it.
 *
 * **It usually does not.** Measured against the published c7 binary,
 * `/props.build_info` is `b1788384120-c588c4f47` -- a build number and a commit,
 * with no `c<N>` anywhere in the response: the release appears only in the
 * artifact's own filename and in its startup banner. So this reports `undefined`
 * on the very server it was written for, and NOTHING may branch on it.
 *
 * It is kept because a build that does carry the tag is worth reading, and
 * because the status panel showing "opencoti c7" when the server says so is
 * better than never showing it. What capability detection must use instead is
 * the evidence itself: `features` (`slots_nonblocking_v1`, `lock_v1`), and for
 * the c8 signals the presence of the signal -- `folded` on a capacity response,
 * an `opencoti` block on a completion, an `X-PolyKV-Settle-Waived` header. Each
 * of those is self-identifying, which a version string that is not sent is not.
 */
function parseRelease(buildInfo: unknown): string | undefined {
	if (typeof buildInfo !== "string") {
		return undefined;
	}
	// `opencoti-0.10.5-c7-2609031229001`, on a build that stamps it there.
	return /-(c\d+)(?:-|$)/.exec(buildInfo)?.[1];
}

/**
 * Read a server's opencoti capabilities, once.
 *
 * `/props` rather than `/polykv/pools`: a server booted without
 * `--polykv-max-pools` -- the default -- errors on every `/polykv/*` route, so
 * probing there cannot tell "pools are off" from "the server is not there", and
 * both were being reported as the latter. `/props` answers on every build, and
 * carries the elastic state and the chat template in the same response.
 *
 * A server that cannot be reached, or that has no opencoti block, answers
 * "not opencoti": the fixed slot count is the safe reading when the question
 * cannot be asked.
 */
export function probeOpencotiProps(
	baseUrl: string | undefined,
	fetchImpl?: typeof fetch,
): Promise<OpencotiProps> {
	if (!baseUrl) {
		return Promise.resolve(NOT_OPENCOTI);
	}
	const root = polykvRoot(baseUrl);
	const cached = OPENCOTI_PROPS.get(root);
	if (cached) {
		return cached;
	}
	const doFetch = fetchImpl ?? fetch;
	const pending = (async (): Promise<OpencotiProps> => {
		try {
			const response = await doFetch(`${root}/props`, { method: "GET" });
			if (!response.ok) {
				return NOT_OPENCOTI;
			}
			const body = (await response.json()) as Record<string, unknown>;
			const opencoti = (body.opencoti ?? {}) as Record<string, unknown>;
			const polykv = (opencoti.polykv ?? {}) as Record<string, unknown>;
			const elasticSlots = (opencoti.elastic_slots ?? {}) as Record<
				string,
				unknown
			>;
			const release = parseRelease(body.build_info);
			return {
				...(release ? { release } : {}),
				poolsEnabled: polykv.pools_enabled === true,
				elastic: elasticSlots.enabled === true,
				...(typeof elasticSlots.slots_live === "number"
					? { slotsLive: elasticSlots.slots_live }
					: {}),
				...(typeof elasticSlots.slots_max === "number"
					? { slotsMax: elasticSlots.slots_max }
					: {}),
				...(typeof body.chat_template === "string"
					? { chatTemplate: body.chat_template }
					: {}),
				features: Array.isArray(body.features)
					? (body.features as string[]).filter(
							(entry) => typeof entry === "string",
						)
					: [],
			};
		} catch {
			return NOT_OPENCOTI;
		}
	})();
	OPENCOTI_PROPS.set(root, pending);
	return pending;
}

/**
 * Whether this server has PolyKV turned on.
 *
 * It matters because PolyKV changes what a slot *is*. Without it a server has
 * `--parallel N` slots and an N+1st request waits; with it agents attach to a
 * pool and share a slot, and whether one more may start is decided by the
 * engine's admission control against real KV headroom rather than by counting.
 * Capping agents at the slot count in that case would refuse work the server
 * would have taken.
 */
export async function probePolykvEnabled(
	baseUrl: string | undefined,
	fetchImpl?: typeof fetch,
): Promise<boolean> {
	return (await probeOpencotiProps(baseUrl, fetchImpl)).poolsEnabled;
}

/** Test seam, and the way a changed server launch is picked up. */
export function resetPolykvAvailability(): void {
	OPENCOTI_PROPS.clear();
}

export function createPolykvClient(options: PolykvClientOptions): PolykvClient {
	const root = polykvRoot(options.baseUrl);
	const doFetch = options.fetch ?? fetch;

	const call = async <T>(
		path: string,
		init?: { method?: string; body?: unknown },
	): Promise<T> => {
		const response = await doFetch(`${root}${path}`, {
			method: init?.method ?? "GET",
			...(init?.body === undefined
				? {}
				: {
						body: JSON.stringify(init.body),
						headers: { "content-type": "application/json" },
					}),
			headers: {
				...(init?.body === undefined
					? {}
					: { "content-type": "application/json" }),
				...options.headers,
			},
			signal: options.signal,
		});
		if (response.status === 429 || response.status === 503) {
			let reason: string | undefined;
			try {
				reason = ((await response.json()) as { reason?: string }).reason;
			} catch {
				reason = undefined;
			}
			throw new PolykvSaturatedError(
				`PolyKV refused the request (${response.status})${reason ? `: ${reason}` : ""}`,
				retryAfterMs(response),
				reason,
			);
		}
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(
				`PolyKV ${init?.method ?? "GET"} ${path} failed (${response.status})${
					text ? `: ${text.slice(0, 300)}` : ""
				}`,
			);
		}
		if (response.status === 204) {
			return undefined as T;
		}
		return (await response.json()) as T;
	};

	/**
	 * Normalize a pool the engine just handed back.
	 *
	 * `pool_id` and `parent` come over the wire as NUMBERS, and the first pool
	 * on a fresh server is id `0`. Left as a number that id is FALSY, so every
	 * `if (poolId)` between here and the request body drops it -- which would
	 * silently stop the very first session on every server from ever attaching.
	 * Measured against the c7 binary: `{"pool_id":0,"parent":-1,...}`.
	 *
	 * `parent: -1` is the engine's "no parent" and becomes absent, not pool
	 * "-1".
	 */
	const readPool = (pool: PolykvPool): PolykvPool => {
		const parent = pool.parent as unknown;
		const hasParent =
			parent !== undefined &&
			parent !== null &&
			!(typeof parent === "number" && parent < 0) &&
			String(parent) !== "-1";
		return {
			...pool,
			pool_id: String(pool.pool_id),
			...(hasParent ? { parent: String(parent) } : { parent: undefined }),
		};
	};

	return {
		createPool: async (body) =>
			readPool(
				await call<PolykvPool>("/polykv/pools", { method: "POST", body }),
			),
		forkPool: async (poolId, body) =>
			readPool(
				await call<PolykvPool>(
					`/polykv/pools/${encodeURIComponent(poolId)}/fork`,
					{ method: "POST", body },
				),
			),
		pin: async (poolId) => {
			await call(`/polykv/pools/${encodeURIComponent(poolId)}/pin`, {
				method: "POST",
				body: {},
			});
		},
		// Its own action, not a flag on `pin`. The server dispatches on the path
		// segment (`task.polykv.pin = action == "pin"`) and never reads the body,
		// so `pin` with `{pinned:false}` pins it again -- the exact opposite of
		// the unpin-after-migrate discipline this client exists to keep.
		unpin: async (poolId) => {
			await call(`/polykv/pools/${encodeURIComponent(poolId)}/unpin`, {
				method: "POST",
				body: {},
			});
		},
		// POST, not DELETE. There is no `DELETE` route: the engine registers
		// exactly one mutating pool path, `POST /polykv/pools/{id}/{action}`, and
		// a `DELETE` 404s into the caller's catch, which reads as "released".
		releasePool: async (poolId) => {
			await call(`/polykv/pools/${encodeURIComponent(poolId)}/release`, {
				method: "POST",
				body: {},
			});
		},
		capacity: (poolId, query) => {
			const suffix =
				query?.expected_tokens !== undefined
					? `?expected_tokens=${Math.max(0, Math.floor(query.expected_tokens))}`
					: "";
			return call<PolykvCapacity>(
				`/polykv/pools/${encodeURIComponent(poolId)}/capacity${suffix}`,
			);
		},
		tokenize: async (content) => {
			const result = await call<{ tokens: number[] }>("/tokenize", {
				method: "POST",
				body: { content },
			});
			return result.tokens ?? [];
		},
		applyTemplate: async (body) => {
			const result = await call<{ prompt: string }>("/apply-template", {
				method: "POST",
				body: {
					messages: body.messages,
					...(body.tools && body.tools.length > 0 ? { tools: body.tools } : {}),
					// Without this the template appends the assistant generation
					// header, so the string ends `<|im_start|>assistant\n<think>`.
					// A real request has a USER turn at that position, so a pool
					// built from it diverges from every request that would attach
					// to it. Measured on the c7 binary: an exact-looking prefix
					// attached with `n_pool_shared: 0`, and the same prompt with
					// this flag is a byte-prefix of the full request's stream.
					add_generation_prompt: false,
				},
			});
			return result.prompt ?? "";
		},
	};
}

/** One pool in the tree, as the status panel shows it. */
export interface OpencotiStatusPool {
	poolId: string;
	/** The pool this one branches from, absent for a root. */
	parent?: string;
	/** Where the child's own tokens start; everything before is shared. */
	branchPos?: number;
	prefixLen?: number;
	pinned: boolean;
	ephemeral: boolean;
	/**
	 * Pinned, childless, and referenced by no slot's current or last task.
	 *
	 * Typically left behind by a compaction re-root that did not unpin. It
	 * blocks reclaim forever, which is the leak this client's release and unpin
	 * fixes exist to stop, so it is named rather than counted.
	 */
	orphanedPin: boolean;
	/** The session a `from_session` snapshot was taken from. */
	sourceSession?: string;
	children: number;
}

/** One live session, keyed the way c7 allows. */
export interface OpencotiStatusSession {
	sessionId: string;
	/**
	 * The slot's throughput EWMA, absent while it is warming.
	 *
	 * A processing slot reporting `0` has not warmed its EWMA yet; it is not a
	 * slot producing nothing, and averaging its zero is what dragged the
	 * admission mean down after every spawn.
	 */
	tps?: number;
	active: boolean;
	ctxUsed?: number;
	ctxTotal?: number;
}

/**
 * Everything the settings panel shows about a live server.
 *
 * Read from `/props`, `/polykv/pools` and `/polykv/tps` -- and from nothing
 * else. **`/capacity` is not on this list and must never be added to it**: on
 * the published c7 engine every GET of it folds the settle and bias EWMAs, so a
 * panel that refreshed would corrupt the admission projection it was drawing.
 * That is why `kv_headroom_pct` and the SWA arm, which live only on that
 * endpoint, are not here. c8 makes the plain GET read-only and moves the fold
 * behind `?fold=1`; they can be added then, not before.
 *
 * The other three are served from a published snapshot and are safe while the
 * server is busy.
 */
export interface OpencotiStatus {
	/** Whether `/props` answered at all. */
	reachable: boolean;
	release?: string;
	poolsEnabled: boolean;
	elastic: boolean;
	/**
	 * The elastic controller's own word for where it is.
	 *
	 * Surfaced verbatim because the engine keeps `saturated, hold` distinct
	 * from `kv headroom exhausted` deliberately: one says raise
	 * `--max-parallel`, the other says this context does not fit.
	 */
	elasticReason?: string;
	slotsLive?: number;
	slotsMax?: number;
	/**
	 * Free VRAM, when the engine can measure it.
	 *
	 * The engine sends `null`, not `0`, when the number would be a lie -- no
	 * GPU layers, or integrated memory where the device reports host RAM -- so
	 * this stays `undefined` there. A reader that saw `0` could not tell "no
	 * headroom" from "no measurement".
	 */
	vramFreeMib?: number;
	tpsFloor?: number;
	grows?: number;
	shrinks?: number;
	poolsMax?: number;
	treeDepth?: number;
	pools: readonly OpencotiStatusPool[];
	sessions: readonly OpencotiStatusSession[];
}

const UNREACHABLE: OpencotiStatus = {
	reachable: false,
	poolsEnabled: false,
	elastic: false,
	pools: [],
	sessions: [],
};

function numberOr(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

async function readJson(
	doFetch: typeof fetch,
	url: string,
): Promise<Record<string, unknown> | undefined> {
	try {
		const response = await doFetch(url, { method: "GET" });
		if (!response.ok) {
			return undefined;
		}
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Read a server's live PolyKV state for display.
 *
 * Nothing here may fail a caller: every read that does not answer leaves its
 * part of the shape empty, and a server that cannot be reached at all reports
 * itself as such rather than as a server with no pools -- those are different
 * things and the panel says which.
 *
 * Pool timestamps are deliberately absent. On c7 `created_ts` and
 * `last_access_ts` are `ggml_time_us()` monotonic stamps since boot, not epoch
 * seconds, so rendering either as a wall-clock time shows a date in 1970 and
 * rendering the difference from now shows an age of decades. c8 anchors them;
 * until then the honest number is none.
 */
export async function readOpencotiStatus(
	baseUrl: string | undefined,
	fetchImpl?: typeof fetch,
): Promise<OpencotiStatus> {
	if (!baseUrl) {
		return UNREACHABLE;
	}
	const root = polykvRoot(baseUrl);
	const doFetch = fetchImpl ?? fetch;

	const props = await readJson(doFetch, `${root}/props`);
	if (!props) {
		return UNREACHABLE;
	}
	const opencoti = (props.opencoti ?? {}) as Record<string, unknown>;
	const polykv = (opencoti.polykv ?? {}) as Record<string, unknown>;
	const elastic = (opencoti.elastic_slots ?? {}) as Record<string, unknown>;
	const release = parseRelease(props.build_info);
	const poolsEnabled = polykv.pools_enabled === true;

	const poolsBody = poolsEnabled
		? await readJson(doFetch, `${root}/polykv/pools`)
		: undefined;
	const tpsBody = await readJson(doFetch, `${root}/polykv/tps`);

	const rawPools = Array.isArray(poolsBody?.pools)
		? (poolsBody.pools as Array<Record<string, unknown>>)
		: [];
	const pools: OpencotiStatusPool[] = rawPools.map((pool) => {
		const parent = numberOr(pool.parent);
		const children = Array.isArray(pool.children) ? pool.children.length : 0;
		const source =
			typeof pool.source_session === "string" && pool.source_session !== ""
				? pool.source_session
				: undefined;
		return {
			poolId: String(pool.pool_id ?? ""),
			// `-1` is the engine's "no parent", not pool number minus one.
			...(parent !== undefined && parent >= 0
				? { parent: String(parent) }
				: {}),
			...(numberOr(pool.branch_pos) !== undefined
				? { branchPos: pool.branch_pos as number }
				: {}),
			...(numberOr(pool.prefix_len) !== undefined
				? { prefixLen: pool.prefix_len as number }
				: {}),
			pinned: pool.pinned === true,
			ephemeral: pool.ephemeral === true,
			orphanedPin: pool.orphaned_pin === true,
			...(source !== undefined ? { sourceSession: source } : {}),
			children,
		};
	});

	const rawSessions = Array.isArray(tpsBody?.sessions)
		? (tpsBody.sessions as Array<Record<string, unknown>>)
		: [];
	// Keyed by `session_id`, never by `pool_id`: on c7 that field reports `-1`
	// for every registry-pool session -- it is the legacy donor-slot key -- so
	// it identifies nothing and grouping by it collapses every session into one.
	const sessions: OpencotiStatusSession[] = rawSessions.map((session) => {
		const tps = numberOr(session.tps_ewma);
		return {
			sessionId:
				typeof session.session_id === "string" ? session.session_id : "",
			...(tps !== undefined && tps > 0 ? { tps } : {}),
			active: session.active === true,
			...(numberOr(session.ctx_used) !== undefined
				? { ctxUsed: session.ctx_used as number }
				: {}),
			...(numberOr(session.ctx_total) !== undefined
				? { ctxTotal: session.ctx_total as number }
				: {}),
		};
	});

	return {
		reachable: true,
		...(release ? { release } : {}),
		poolsEnabled,
		elastic: elastic.enabled === true,
		...(typeof elastic.reason === "string"
			? { elasticReason: elastic.reason }
			: {}),
		...(numberOr(elastic.slots_live) !== undefined
			? { slotsLive: elastic.slots_live as number }
			: {}),
		...(numberOr(elastic.slots_max) !== undefined
			? { slotsMax: elastic.slots_max as number }
			: {}),
		...(numberOr(elastic.vram_free_mib) !== undefined
			? { vramFreeMib: elastic.vram_free_mib as number }
			: {}),
		...(numberOr(elastic.tps_floor) !== undefined
			? { tpsFloor: elastic.tps_floor as number }
			: {}),
		...(numberOr(elastic.grows) !== undefined
			? { grows: elastic.grows as number }
			: {}),
		...(numberOr(elastic.shrinks) !== undefined
			? { shrinks: elastic.shrinks as number }
			: {}),
		...(numberOr(poolsBody?.pools_max) !== undefined
			? { poolsMax: poolsBody?.pools_max as number }
			: {}),
		...(numberOr(poolsBody?.tree_depth) !== undefined
			? { treeDepth: poolsBody?.tree_depth as number }
			: {}),
		pools,
		sessions,
	};
}
