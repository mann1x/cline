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
	/** A `shared: true` create found an existing root instead of making one. */
	reused?: boolean;
	/** Said, not refused: e.g. an owner that holds no live allocation. */
	warning?: string;
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

	/**
	 * Which window the `kv_*` and `headroom_*` figures above describe.
	 *
	 * **The field that stops this endpoint being misread.** Under guarantees a
	 * pool owned by a session reports them against the OWNER'S window rather
	 * than against the server, so a caller that takes them off the first pool it
	 * finds and calls the result "KV headroom" is stating one session's private
	 * occupancy as the machine's free capacity -- wrong in the most misleading
	 * direction there is, since a full server with one idle session then reads
	 * as nearly empty.
	 *
	 * `session` is that case. `unallocated` is an unowned pool, whose free cells
	 * are what admission can still grant and so genuinely are the server's.
	 * `cache` is a server without guarantees, where the distinction does not
	 * exist. Absent is a build from before the split, which has no per-session
	 * windows to confuse these with.
	 */
	pressure_scope?: "session" | "unallocated" | "cache";
	/** The session owning this pool, when one does. */
	owner?: string | null;
	/** Raw `used/window`, 0..1. Never a ramp. */
	pressure?: number;
	/** The denominator `pressure` is taken against. */
	window_cells?: number;

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
	 *
	 * **Superseded by `pressure` where the server offers it.** This one is a
	 * 0.70..1.0 ramp over the same denominator, kept for compatibility; a
	 * pre-scaled figure stops matching the threshold the user set, which is the
	 * number they are looking at. Take the raw ratio and own the policy here.
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

/** The body of `POST /polykv/pools/{id}/admission`, as the engine reads it. */
export interface PolykvAdmissionPolicy {
	target_tps_per_session?: number;
	mode?: "advisory" | "enforced";
	on_saturation?: "reject" | "warn";
	guarantee_min_sessions?: number;
	settle_tokens?: number;
	settle_max_ms?: number;
	prefill_max_slots?: number;
}

/**
 * The admission policy a profile's PolyKV section asks for, or nothing.
 *
 * A floor with no mode is sent as `enforced`. The engine's own default is
 * `advisory`, which reports and refuses nothing, and the section's floor field
 * promises the opposite: "a new session that would push the projected mean
 * below this is refused rather than admitted". Before this was sent at all,
 * a 15 tok/s floor on both of a user's nodes let 60 agents run at 5 tok/s --
 * the server's own boot floor -- because no pool ever carried the policy.
 */
export function polykvAdmissionPolicy(
	settings:
		| {
				targetTpsPerSession?: number;
				mode?: "advisory" | "enforced";
				onSaturation?: "reject" | "warn";
				guaranteeMinSessions?: number;
				settleTokens?: number;
				settleMaxMs?: number;
				prefillMaxSlots?: number;
		  }
		| undefined,
): PolykvAdmissionPolicy | undefined {
	if (!settings) {
		return undefined;
	}
	const count = (value: unknown) =>
		typeof value === "number" && Number.isFinite(value) && value >= 0
			? value
			: undefined;
	const floor = count(settings.targetTpsPerSession);
	const policy: PolykvAdmissionPolicy = {
		...(floor !== undefined ? { target_tps_per_session: floor } : {}),
		...(settings.mode
			? { mode: settings.mode }
			: floor !== undefined && floor > 0
				? { mode: "enforced" as const }
				: {}),
		...(settings.onSaturation ? { on_saturation: settings.onSaturation } : {}),
		...(count(settings.guaranteeMinSessions) !== undefined
			? { guarantee_min_sessions: count(settings.guaranteeMinSessions) }
			: {}),
		...(count(settings.settleTokens) !== undefined
			? { settle_tokens: count(settings.settleTokens) }
			: {}),
		...(count(settings.settleMaxMs) !== undefined
			? { settle_max_ms: count(settings.settleMaxMs) }
			: {}),
		...(count(settings.prefillMaxSlots) !== undefined
			? { prefill_max_slots: count(settings.prefillMaxSlots) }
			: {}),
	};
	return Object.keys(policy).length > 0 ? policy : undefined;
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
		/**
		 * The HTTP status line, which is the half that is right on both
		 * releases. c7 answers a `429` with a body that says
		 * `503`/`unavailable_error`, so a client that classified on the body
		 * would call every c7 refusal a failed capacity check.
		 */
		readonly status: number = 429,
	) {
		super(message);
		this.name = "PolykvSaturatedError";
	}

	/**
	 * `--polykv-adm-on-error deny` refusing because the check itself failed.
	 *
	 * Distinct from pacing on purpose. A `429` means the server knows it is
	 * full and has said when to come back, so waiting works. A `503` means the
	 * server does not know whether it has room and would rather refuse than
	 * guess -- nothing about waiting fixes that, and retrying it on a timer
	 * turns one failed check into a loop.
	 */
	get capacityCheckFailed(): boolean {
		return this.status === 503;
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
export interface PolykvPoolOwner {
	/**
	 * The session whose window this pool lives in.
	 *
	 * **What makes a worker free.** A request that attaches to a pool owned by
	 * a session is priced as a worker OF that session: it books nothing
	 * server-wide and is charged against the owner's free window. An unowned
	 * pool is charged to nobody, and every worker attaching to it books a
	 * guaranteed window of its own -- measured live on 8240, a 12-worker swarm
	 * under a 65,536-token lead took THIRTEEN allocations of 65,536, 82% of the
	 * server's cells, for a round that should have cost one.
	 *
	 * The server defaults it to `from_session`, or to the parent's owner on a
	 * fork; it is sent explicitly because the pools that matter most here --
	 * the root pool, built from a templated prompt -- have neither.
	 */
	session_id?: string;
}

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
		body: PolykvPrefixSource &
			PolykvPoolOwner & {
				pin?: boolean;
				ephemeral?: boolean;
				/** Declared expected prefix length, validated server-side. */
				expect_len?: number;
				/**
				 * Find-or-create (`polykv_shared_root_v1`): an unowned root with
				 * exactly these tokens and the same `ephemeral` is returned with
				 * `reused: true`. A 400 with an owner or a snapshot source.
				 */
				shared?: boolean;
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
		body: PolykvPrefixSource &
			PolykvPoolOwner & {
				branch_pos?: number;
				pin?: boolean;
				ephemeral?: boolean;
			},
	): Promise<PolykvPool>;
	/**
	 * Give a session's guaranteed window back, before its idle TTL does.
	 *
	 * Called on conversation end, always. Skipping it holds the whole booked
	 * allocation for the TTL -- five minutes on the build this was written
	 * against -- so a user who ends one 256k conversation and opens another
	 * waits out their own last session. The TTL is the crash net, not the
	 * mechanism.
	 *
	 * Answers whether anything was actually released. The server replies
	 * `200 {"found": false}` for a session it never held, so the status line
	 * says only that the request arrived; `found` says whether it did anything.
	 * A `false` for a session we believed we held means our id and the
	 * server's have diverged, which is worth knowing and not worth guessing at.
	 */
	closeSession(sessionId: string): Promise<boolean>;
	/**
	 * The ids of the pools the server holds now.
	 *
	 * How a client learns a pool it named is gone: the engine releases every
	 * pool a session owns when that session's window lapses, and a request
	 * naming a released pool is not refused -- it is a server-side warning and
	 * a full reprocess, invisible from here.
	 */
	listPoolIds(): Promise<Set<string>>;
	pin(poolId: string): Promise<void>;
	unpin(poolId: string): Promise<void>;
	/** Set a pool's admission policy (`POST /polykv/pools/{id}/admission`). */
	setAdmission(poolId: string, policy: PolykvAdmissionPolicy): Promise<void>;
	releasePool(poolId: string): Promise<void>;
	/**
	 * Ask what the gate would say, optionally folding the learner.
	 *
	 * `fold` is the c8 half of a c7 hazard. On c7 every GET folds the settle
	 * and bias EWMAs whether you wanted it to or not, which is why the status
	 * panel may not poll this endpoint there. `capacity_readonly_v1` makes the
	 * plain GET read-only and moves the fold behind `?fold=1`, so an admission
	 * decision asks for it and a panel read does not.
	 *
	 * Asking for it on a c7 server is harmless: it folds either way, and the
	 * unknown query parameter is ignored. `folded` echoing back is how a caller
	 * learns which of the two it is talking to.
	 */
	capacity(
		poolId: string,
		query?: { expected_tokens?: number; fold?: boolean },
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
		/**
		 * The rest of the chat request, as it will be sent: see
		 * `templateFieldsOf`. The server parses this body with the same code
		 * it parses a chat request with, so fields such as
		 * `reasoning_budget_tokens` change the rendering here exactly as they
		 * do there.
		 */
		fields?: Readonly<Record<string, unknown>>;
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
	/**
	 * `"lead"`: the pool is the conversation's place in the server-wide lead
	 * tree (`polykv-lead.ts`) -- a shared root, or the conversation's own
	 * sub-pool of it. Not this session's to re-root or release by id: the root
	 * is every session's, and the lead tree releases what it made.
	 *
	 * `"borrowed"`: someone else's pool this session only attaches to -- a
	 * swarm worker on the lead's snapshot or borrowed root. Its to read, never
	 * its to re-root, unpin or release: that pool is the lead's, and every
	 * other worker of the round is attached to it.
	 */
	layout?: "lead" | "borrowed";
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
/**
 * The window each session was actually granted, as the server reported it.
 *
 * Kept apart from the pool state on purpose, and cleared on a different event.
 * A pool comes and goes -- a compaction re-roots onto a fork and releases the
 * old one -- while the booked window outlives all of that and ends only when
 * the session is closed. Clearing this with the pool would lose the one fact
 * the resume rule depends on.
 *
 * In-memory, and hydrated by the host from the session's stored metadata when
 * a conversation is reopened (see `onPolykvWindowGrant` for the other half):
 * without that, an extension restart forgot the grant and a resumed
 * conversation negotiated down like a new one, which is the truncation the
 * resume rule exists to prevent.
 *
 * Deliberately NOT cleared when the session is closed. Closing gives the cells
 * back to the server; it does not change which window the conversation was
 * opened with, and a conversation continued after its close must ask for the
 * same one.
 */
const POLYKV_GRANTED_WINDOWS = new Map<string, PolykvWindowGrant>();

/**
 * The window a session was granted, and what it asked for when it was.
 *
 * `granted` and `asked` are the numbers on the wire: `num_ctx` and the
 * `X-Context-Window` that answered it. Under `polykv_private_window_v1` both
 * are the PRIVATE budget, and the shared prefix the conversation attached to
 * rides above them -- `sharedTokens` -- so the window the conversation can
 * actually fill is `granted + sharedTokens` ({@link polykvEffectiveWindow}).
 */
export interface PolykvWindowGrant {
	granted: number;
	/**
	 * The window the conversation asked for when it was opened.
	 *
	 * Kept from the FIRST grant: every later admission of the session asks for
	 * exactly the granted window, so the ask on the wire stops saying what the
	 * user configured the moment the resume rule takes over.
	 */
	asked?: number;
	sharedTokens?: number;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.floor(value)
		: undefined;
}

const WINDOW_GRANT_LISTENERS = new Set<
	(sessionId: string, grant: PolykvWindowGrant) => void
>();

/**
 * Be told whenever a session's grant is first learned or changes.
 *
 * The host persists it from here, because the grant arrives on a response --
 * long after the session record was written at start.
 */
export function onPolykvWindowGrant(
	listener: (sessionId: string, grant: PolykvWindowGrant) => void,
): () => void {
	WINDOW_GRANT_LISTENERS.add(listener);
	return () => {
		WINDOW_GRANT_LISTENERS.delete(listener);
	};
}

/**
 * Record what `X-Context-Window` reported for this session.
 *
 * `detail` describes the ask that produced it. It is taken only when the
 * session has no grant yet -- see {@link PolykvWindowGrant.asked} -- so a
 * hydrated record or a resumed ask can never overwrite the original ask with
 * the granted one.
 */
export function recordPolykvGrantedWindow(
	sessionId: string,
	window: number,
	detail: { asked?: number; sharedTokens?: number } = {},
): void {
	const granted = positiveInteger(window);
	if (granted === undefined) {
		return;
	}
	const existing = POLYKV_GRANTED_WINDOWS.get(sessionId);
	const asked = existing ? existing.asked : positiveInteger(detail.asked);
	const shared = existing
		? existing.sharedTokens
		: positiveInteger(detail.sharedTokens);
	const next: PolykvWindowGrant = {
		granted,
		...(asked !== undefined ? { asked } : {}),
		...(shared !== undefined ? { sharedTokens: shared } : {}),
	};
	POLYKV_GRANTED_WINDOWS.set(sessionId, next);
	if (
		!existing ||
		existing.granted !== next.granted ||
		existing.asked !== next.asked ||
		existing.sharedTokens !== next.sharedTokens
	) {
		for (const listener of WINDOW_GRANT_LISTENERS) {
			try {
				listener(sessionId, { ...next });
			} catch {
				// A listener's failure is its own; the grant stands.
			}
		}
	}
}

/** The window this conversation already holds, if we have seen one granted. */
export function getPolykvGrantedWindow(
	sessionId: string | undefined,
): number | undefined {
	return sessionId ? POLYKV_GRANTED_WINDOWS.get(sessionId)?.granted : undefined;
}

/** The whole grant record, for persisting and for the context bar. */
export function getPolykvWindowGrant(
	sessionId: string | undefined,
): PolykvWindowGrant | undefined {
	const grant = sessionId ? POLYKV_GRANTED_WINDOWS.get(sessionId) : undefined;
	return grant ? { ...grant } : undefined;
}

/**
 * The window the conversation can actually fill: the grant plus the shared
 * prefix riding above it. `undefined` when no grant is known.
 */
export function polykvEffectiveWindow(
	grant: PolykvWindowGrant | undefined,
): number | undefined {
	return grant ? grant.granted + (grant.sharedTokens ?? 0) : undefined;
}

/**
 * Read a grant back from stored metadata, rejecting anything malformed.
 *
 * The shape is {@link PolykvWindowGrant}; a record that does not carry a
 * positive `granted` is not a grant, and hydrating from it would pin a resumed
 * conversation to a window nobody was ever given.
 */
export function readPolykvWindowGrant(
	value: unknown,
): PolykvWindowGrant | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	const granted = positiveInteger(record.granted);
	if (granted === undefined) {
		return undefined;
	}
	const asked = positiveInteger(record.asked);
	const shared = positiveInteger(record.sharedTokens);
	return {
		granted,
		...(asked !== undefined ? { asked } : {}),
		...(shared !== undefined ? { sharedTokens: shared } : {}),
	};
}

/**
 * Forget a session's grant. A test seam and an explicit reset -- NOT called
 * when a session closes, see {@link POLYKV_GRANTED_WINDOWS}.
 */
export function clearPolykvGrantedWindow(sessionId: string): void {
	POLYKV_GRANTED_WINDOWS.delete(sessionId);
	POLYKV_WINDOW_OBSERVATIONS.delete(sessionId);
}

/**
 * What the LAST admitted response said about the window, per session.
 *
 * Separate from the grant on purpose. The grant is the booking, remembered for
 * the resume rule; this is the per-response reading, and a response without
 * `X-Context-Window` is not guaranteed -- an overcommit, or a server that is
 * not enforcing -- so it reads as UNKNOWN (`granted: undefined`), never as
 * "the same as last time".
 */
export interface PolykvWindowObservation {
	granted?: number;
	asked?: number;
	sharedTokens?: number;
}

const POLYKV_WINDOW_OBSERVATIONS = new Map<string, PolykvWindowObservation>();

export function recordPolykvWindowObservation(
	sessionId: string,
	observation: PolykvWindowObservation,
): void {
	POLYKV_WINDOW_OBSERVATIONS.set(sessionId, { ...observation });
}

export function getPolykvWindowObservation(
	sessionId: string | undefined,
): PolykvWindowObservation | undefined {
	const seen = sessionId
		? POLYKV_WINDOW_OBSERVATIONS.get(sessionId)
		: undefined;
	return seen ? { ...seen } : undefined;
}

export function resetPolykvSessions(): void {
	POLYKV_GRANTED_WINDOWS.clear();
	POLYKV_WINDOW_OBSERVATIONS.clear();
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
	/**
	 * Whether `/props` answered at all.
	 *
	 * The three other fields cannot carry this: a plain llama.cpp server and a
	 * server that is not there both report `poolsEnabled: false, elastic:
	 * false`, and the right thing to say about them is opposite -- one has a
	 * fixed `--parallel` count, the other was never asked. A panel that
	 * collapses them tells a user their server has neither controller on
	 * because the question failed, which is a guess wearing a fact's clothes.
	 */
	reachable: boolean;
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
	reachable: false,
	poolsEnabled: false,
	elastic: false,
	features: [],
};

/**
 * The advertised capabilities this client branches on.
 *
 * **These, and never a parsed release.** The published binary stamps no `c<N>`
 * anywhere in `/props`, and the build that does stamp one carries `-c7-` on the
 * artifact that ships the c8 behaviours -- so a version gate reads the wrong
 * answer on both the server it was written for and the one it was written
 * against. A flag is self-identifying; a version string that is not sent is
 * not.
 *
 * Listed here rather than inlined at each branch so that the set is readable as
 * a set, and so that a server advertising something we do not consume yet is
 * visible as a gap rather than as nothing.
 */
export const OPENCOTI_FEATURES = {
	/** `GET /capacity` no longer folds the learner; `?fold=1` asks for it. */
	capacityReadonly: "capacity_readonly_v1",
	/** The completion response carries `opencoti {pool_id, n_pool_shared}`. */
	attachInResponse: "attach_in_response_v1",
	/** `X-PolyKV-Settle-Waived` tells a timer waiver from a measured admit. */
	settleWaivedHeader: "settle_waived_header_v1",
	/** `/polykv/tps` reports the real pool binding, plus a stable `alloc_key`. */
	tpsRealPoolId: "tps_real_pool_id_v1",
	/** An elastic slot is a guaranteed allocation booked by `num_ctx`. */
	guaranteedAlloc: "elastic_guaranteed_alloc_v1",
	/** `GET /kv`: the pollable allocation snapshot. */
	kvStatus: "kv_status_v1",
	/** Pools are sub-pools of their owning session, max 8 per session. */
	subpools: "polykv_subpools_v1",
	/** `POST /sessions/{id}/close` releases a window before its TTL. */
	sessionClose: "session_close_v1",
	/** `num_ctx_min`: the floor is negotiated server-side, in one admission. */
	ctxMinNegotiation: "ctx_min_negotiation_v1",
	/** `/capacity` carries `pressure`, `window_cells`, `owner`, `pressure_scope`. */
	sessionPressure: "session_pressure_v1",
	/** The tps floor is settable at runtime via `POST /elastic`. */
	elasticRw: "elastic_rw_v1",
	/** `hold_ticks` -- how long a grow condition must hold -- is settable too. */
	elasticHoldRw: "elastic_hold_rw_v1",
	/**
	 * A slot whose own cache covers a named pool's whole prefix is rebased onto
	 * the pool, so a continuation turn keeps its share (`n_pool_shared = P`).
	 */
	rebase: "polykv_rebase_v1",
	/** Under the tps floor a busy top slot drains instead of taking new work. */
	elasticDrain: "elastic_drain_v1",
	/**
	 * `num_ctx` is the PRIVATE budget: an attached pool's shared prefix rides
	 * above it, capped at the per-session maximum.
	 */
	privateWindow: "polykv_private_window_v1",
	/** `POST /polykv/pools {shared: true}` is find-or-create for an unowned root. */
	sharedRoot: "polykv_shared_root_v1",
	/** `POST /sessions/close {session_id}`: the close for ids the path cannot carry. */
	sessionCloseBody: "session_close_body_v1",
	/** The response's `opencoti` block carries `pool_match` and `pool_len`. */
	poolMatchInResponse: "pool_match_in_response_v1",
	/**
	 * `stream_options.keepalive`: the SSE stream opens at once and every silent
	 * period carries a `: keepalive <phase>` comment (`opencoti-liveness.ts`).
	 */
	streamKeepalive: "stream_keepalive_v1",
	/** SO_KEEPALIVE on the server's sockets. Server-side only: nothing to send. */
	tcpKeepalive: "tcp_keepalive_v1",
	/** `boot_id` / `started_at` on `/health` and `/props`, `X-OpenCoti-Boot-Id` on completions. */
	bootId: "boot_id_v1",
	/** `opencoti.pool_unknown`: the named pool is not in this process. */
	poolUnknownInResponse: "pool_unknown_in_response_v1",
} as const;

export type OpencotiFeature =
	(typeof OPENCOTI_FEATURES)[keyof typeof OPENCOTI_FEATURES];

/** Whether a server advertised a capability. Absent always means "no". */
export function hasOpencotiFeature(
	features: readonly string[] | undefined,
	feature: OpencotiFeature,
): boolean {
	return features?.includes(feature) === true;
}

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
			// Bounded like every other read here: this one is on the
			// session-start path, so an unbounded `/props` stalls a session.
			const body = await boundedJson(doFetch, `${root}/props`);
			if (!body) {
				return NOT_OPENCOTI;
			}
			const opencoti = (body.opencoti ?? {}) as Record<string, unknown>;
			const polykv = (opencoti.polykv ?? {}) as Record<string, unknown>;
			const elasticSlots = (opencoti.elastic_slots ?? {}) as Record<
				string,
				unknown
			>;
			const release = parseRelease(body.build_info);
			return {
				...(release ? { release } : {}),
				// It answered. Whether it is opencoti at all is the next three
				// fields' business, not this one's.
				reachable: true,
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
	// A server that did not answer has not been read, so caching that forever
	// would make one bad moment permanent: the settings panel reads this to
	// decide what the Parallel Sessions field means, and a cached "could not be
	// asked" is a panel that never asks again for the life of the window. A
	// real answer -- including "answered, and is not opencoti" -- is cached,
	// which is the whole point of reading it once.
	void pending.then((props) => {
		if (!props.reachable && OPENCOTI_PROPS.get(root) === pending) {
			OPENCOTI_PROPS.delete(root);
		}
	});
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
				// The engine's own refusals (`send_error`, e.g. the per-session
				// sub-pool limit) put the why in `error.message`, not `reason`;
				// without it every refusal read as a bare "503".
				const body = (await response.json()) as {
					reason?: string;
					error?: { message?: unknown };
				};
				reason =
					body.reason ??
					(typeof body.error?.message === "string"
						? body.error.message
						: undefined);
			} catch {
				reason = undefined;
			}
			throw new PolykvSaturatedError(
				`PolyKV refused the request (${response.status})${reason ? `: ${reason}` : ""}`,
				retryAfterMs(response),
				reason,
				response.status,
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
		closeSession: async (sessionId) => {
			const result = await call<{ found?: boolean }>(
				`/sessions/${encodeURIComponent(sessionId)}/close`,
				{ method: "POST", body: {} },
			);
			return result?.found === true;
		},
		listPoolIds: async () => {
			const result = await call<{ pools?: Array<{ pool_id?: unknown }> }>(
				"/polykv/pools",
			);
			return new Set(
				(result?.pools ?? [])
					.map((pool) => pool.pool_id)
					.filter((id) => id !== undefined && id !== null)
					.map(String),
			);
		},
		setAdmission: async (poolId, policy) => {
			await call(`/polykv/pools/${encodeURIComponent(poolId)}/admission`, {
				method: "POST",
				body: policy,
			});
		},
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
			const params = new URLSearchParams();
			if (query?.expected_tokens !== undefined) {
				params.set(
					"expected_tokens",
					String(Math.max(0, Math.floor(query.expected_tokens))),
				);
			}
			if (query?.fold) {
				params.set("fold", "1");
			}
			const suffix = params.size > 0 ? `?${params}` : "";
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
					...body.fields,
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
	/** The floor this pool's admission policy holds new sessions to, when set. */
	admissionFloor?: number;
	/** `enforced` refuses below the floor; `advisory` only reports. */
	admissionMode?: string;
}

/** One live session, keyed the way the server allows. */
export interface OpencotiStatusSession {
	sessionId: string;
	/**
	 * The pool this session is bound to.
	 *
	 * Present only under `tps_real_pool_id_v1`. On c7 the field is on the wire
	 * but reports `-1` for every registry pool -- it is the legacy donor-slot
	 * key -- so it identifies nothing and grouping by it collapses every
	 * session into one. Absent is the honest reading there.
	 */
	poolId?: string;
	/**
	 * The allocation this session holds, stable across a slot move.
	 *
	 * Elastic growth can move a session to a different slot, so a slot index is
	 * not an identity over time and this is.
	 */
	allocKey?: string;
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
 * Read from `/props`, `/polykv/pools` and `/polykv/tps`, which are served from
 * a published snapshot and are safe to read while the server is busy -- and,
 * **only when the server advertises `capacity_readonly_v1`**, from `/capacity`
 * as well.
 *
 * That last condition is the whole of it. On the published c7 engine every GET
 * of `/capacity` folds the settle and bias EWMAs, so a panel that refreshed
 * would corrupt the admission projection it was drawing; `kv_headroom_pct` and
 * the SWA arm live only there and were therefore simply absent. The flag says
 * the plain GET is read-only and the fold has moved behind `?fold=1`, which is
 * what makes the fourth read safe. Without it we do not ask, and the fields
 * stay absent rather than being guessed at from somewhere else.
 */
export interface OpencotiAllocation {
	sessionId: string;
	/** The window this session booked, in cells. */
	window: number;
	used: number;
	free: number;
	/**
	 * Raw `used/window`, 0..1, never a ramp.
	 *
	 * The compaction trigger. It is deliberately taken raw from the server and
	 * compared against a threshold we own, because the number the user set is
	 * the number they should see: a server-side ramp would make the figure in
	 * our UI stop matching the one in theirs.
	 */
	pressure: number;
	/** Sub-pools this session holds, of `poolsMaxPerSlot`. */
	pools: number;
}

export interface OpencotiStatus {
	/** Whether `/props` answered at all. */
	reachable: boolean;
	release?: string;
	/**
	 * KV headroom, and the SWA arm beside it.
	 *
	 * From `GET /kv` where the server offers it, which needs no pool to address
	 * and is server-wide by construction; otherwise from a pool's `/capacity`,
	 * which needs `capacity_readonly_v1` before it may be read at all.
	 *
	 * **`kvScope` says which window these describe** and must be read with
	 * them -- see `PolykvCapacity.pressure_scope`. `kvCells*` covers the BASE
	 * pool only: on an iSWA model the sliding-window ring is a separate
	 * account, so total occupancy is neither of them and is not their sum.
	 */
	kvHeadroomPct?: number;
	kvCellsFree?: number;
	kvCellsTotal?: number;
	kvCellsUsed?: number;
	/** `server` or one session's private window. Never assumed. */
	kvScope?: "server" | "session";
	/** The session those figures belong to, when `kvScope` is `session`. */
	kvScopeOwner?: string;
	/** The largest window a new session could book right now. */
	largestAdmissible?: number;
	/** Whether the server is enforcing guaranteed allocations at all. */
	guaranteed?: boolean;
	/** Sub-pools one session may hold. */
	poolsMaxPerSlot?: number;
	/** How long an idle window is held before the server reclaims it. */
	allocTtlSeconds?: number;
	/** One row per session holding a window. Empty on a server without them. */
	allocations: OpencotiAllocation[];
	swaActive?: boolean;
	swaCellsFree?: number | null;
	swaCellsTotal?: number | null;
	swaWindow?: number | null;
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
	allocations: [],
};

/** A pool's `admission` block, where the engine says a policy was set. */
function admissionOf(value: unknown): {
	admissionFloor?: number;
	admissionMode?: string;
} {
	const block = (value ?? {}) as Record<string, unknown>;
	if (block.set === false) {
		return {};
	}
	const floor = numberOr(block.target_tps_per_session);
	return {
		...(floor !== undefined ? { admissionFloor: floor } : {}),
		...(typeof block.mode === "string" ? { admissionMode: block.mode } : {}),
	};
}

function numberOr(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/**
 * How long any one of these reads may take before it is abandoned.
 *
 * Measured on bs2, 2026-09-22: `GET /polykv/tps` answers with headers and a
 * `200`, and then never ends the body. Every one of these reads was unbounded,
 * so the caller simply stopped -- the settings panel's engine probe never
 * resolved, which left the Parallel Sessions field showing "Default: 1" on a
 * server with PolyKV admission on, and left its description on the "could not
 * be asked" branch. The same unbounded read is on the session-start path
 * through `probeOpencotiProps`, where a hung `/props` would stall a session
 * rather than a panel.
 *
 * Five seconds is far past a healthy answer -- `/props` returns in 70ms and
 * `/polykv/pools` in 20ms on the same server -- and far short of anything a
 * person would wait through. These are all display and admission reads: none
 * of them is worth blocking on, and every one of them already has an
 * "unanswered" spelling.
 */
const OPENCOTI_READ_TIMEOUT_MS = 5_000;

/**
 * A GET that cannot outlive its bound, however the other end misbehaves.
 *
 * Both halves are needed. The signal cancels the real request, so a hung read
 * does not leak a socket for the life of the process; the race bounds the
 * wait even when the caller passed a `fetch` that ignores signals -- which
 * every stub in a test does, and which is exactly the shape that hangs.
 *
 * Reading the body is inside the bound too. The measured failure delivered its
 * headers promptly and never finished the body, so anything that awaited only
 * the response would have called this a success and hung on `.json()`.
 */
async function boundedJson(
	doFetch: typeof fetch,
	url: string,
	timeoutMs: number = OPENCOTI_READ_TIMEOUT_MS,
): Promise<Record<string, unknown> | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let expired: (() => void) | undefined;
	const expiry = new Promise<undefined>((resolve) => {
		expired = () => resolve(undefined);
	});
	const abandon = setTimeout(() => expired?.(), timeoutMs);
	try {
		return await Promise.race([
			(async () => {
				const response = await doFetch(url, {
					method: "GET",
					signal: controller.signal,
				});
				if (!response.ok) {
					return undefined;
				}
				return (await response.json()) as Record<string, unknown>;
			})(),
			expiry,
		]);
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
		clearTimeout(abandon);
	}
}

async function readJson(
	doFetch: typeof fetch,
	url: string,
): Promise<Record<string, unknown> | undefined> {
	return boundedJson(doFetch, url);
}

/** `GET /kv`'s `allocations[]`, one row per session holding a window. */
function parseOpencotiAllocations(
	kv: Record<string, unknown> | undefined,
): OpencotiAllocation[] {
	const rawAllocations = Array.isArray(kv?.allocations)
		? (kv.allocations as Array<Record<string, unknown>>)
		: [];
	return rawAllocations.flatMap((entry) => {
		const window = numberOr(entry.window);
		if (typeof entry.session_id !== "string" || window === undefined) {
			return [];
		}
		const used = numberOr(entry.used) ?? 0;
		return [
			{
				sessionId: entry.session_id,
				window,
				used,
				free: numberOr(entry.free) ?? Math.max(0, window - used),
				// Derived only as a fallback: the server states it, and a
				// division here would silently disagree with theirs on a zero
				// window.
				pressure: numberOr(entry.pressure) ?? (window > 0 ? used / window : 0),
				pools: numberOr(entry.pools) ?? 0,
			},
		];
	});
}

/**
 * The per-session allocations, and nothing else, off `GET /kv`.
 *
 * For the compaction trigger, which wants one session's raw `pressure` and
 * none of the rest of the status read. `undefined` when the server does not
 * offer the route (`kv_status_v1`) or did not answer: "cannot say" is not
 * "no pressure", and the caller falls back to what it had.
 */
export async function readOpencotiAllocations(
	baseUrl: string | undefined,
	fetchImpl?: typeof fetch,
): Promise<OpencotiAllocation[] | undefined> {
	if (!baseUrl) {
		return undefined;
	}
	const doFetch = fetchImpl ?? fetch;
	const props = await probeOpencotiProps(baseUrl, doFetch);
	if (!hasOpencotiFeature(props.features, OPENCOTI_FEATURES.kvStatus)) {
		return undefined;
	}
	const kv = await readJson(doFetch, `${polykvRoot(baseUrl)}/kv`);
	return kv ? parseOpencotiAllocations(kv) : undefined;
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

	const features = Array.isArray(props.features)
		? (props.features as unknown[]).filter(
				(entry): entry is string => typeof entry === "string",
			)
		: [];

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
			...admissionOf(pool.admission),
		};
	});

	const rawSessions = Array.isArray(tpsBody?.sessions)
		? (tpsBody.sessions as Array<Record<string, unknown>>)
		: [];
	// Keyed by `session_id` always, and by `pool_id` only where the server says
	// it sets one: on c7 that field reports `-1` for every registry-pool
	// session -- it is the legacy donor-slot key -- so it identifies nothing and
	// grouping by it collapses every session into one.
	const realPoolKey = hasOpencotiFeature(
		features,
		OPENCOTI_FEATURES.tpsRealPoolId,
	);
	const sessions: OpencotiStatusSession[] = rawSessions.map((session) => {
		const tps = numberOr(session.tps_ewma);
		const poolId = numberOr(session.pool_id);
		return {
			sessionId:
				typeof session.session_id === "string" ? session.session_id : "",
			...(realPoolKey && poolId !== undefined && poolId >= 0
				? { poolId: String(poolId) }
				: {}),
			...(realPoolKey && typeof session.alloc_key === "string"
				? { allocKey: session.alloc_key }
				: {}),
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

	// Where the KV account comes from, in order of preference.
	//
	// `GET /kv` first: it is the server-wide ledger, it needs no pool to
	// address, and it carries the per-session allocations besides. A pool's
	// `/capacity` is the fallback for a server that does not offer it -- and
	// only once `capacity_readonly_v1` says the plain GET has stopped folding
	// the admission learner.
	const kv = hasOpencotiFeature(features, OPENCOTI_FEATURES.kvStatus)
		? await readJson(doFetch, `${root}/kv`)
		: undefined;
	const capacity =
		kv === undefined &&
		hasOpencotiFeature(features, OPENCOTI_FEATURES.capacityReadonly) &&
		pools.length > 0
			? await readJson(
					doFetch,
					`${root}/polykv/pools/${encodeURIComponent(pools[0].poolId)}/capacity`,
				)
			: undefined;

	// The pool we asked may be owned, in which case its figures describe that
	// session's window and not the server's. Absent scope is a build from
	// before the split, which has no per-session windows to confuse them with.
	const capacityScope = capacity?.pressure_scope;
	const scopedToSession = capacityScope === "session";
	const kvSwa = (kv?.swa ?? undefined) as Record<string, unknown> | undefined;
	const account = kv
		? {
				scope: "server" as const,
				cellsTotal: numberOr(kv.cells_total),
				cellsFree: numberOr(kv.cells_free),
				cellsUsed: numberOr(kv.cells_used),
				// `/kv` states the free cells rather than a percentage, so the
				// headroom is derived here instead of being read.
				headroomPct:
					numberOr(kv.cells_total) && numberOr(kv.cells_free) !== undefined
						? ((kv.cells_free as number) / (kv.cells_total as number)) * 100
						: undefined,
				owner: undefined,
				swaTotal: numberOr(kvSwa?.cells_total),
				swaFree: numberOr(kvSwa?.cells_free),
				swaWindow: numberOr(kvSwa?.window),
				swaActive: kvSwa !== undefined,
			}
		: capacity
			? {
					scope: scopedToSession ? ("session" as const) : ("server" as const),
					cellsTotal: numberOr(capacity.kv_cells_total),
					cellsFree: numberOr(capacity.kv_cells_free),
					cellsUsed: undefined,
					headroomPct: numberOr(capacity.kv_headroom_pct),
					owner:
						scopedToSession && typeof capacity.owner === "string"
							? capacity.owner
							: undefined,
					swaTotal: numberOr(capacity.swa_cells_total),
					swaFree: numberOr(capacity.swa_cells_free),
					swaWindow: numberOr(capacity.swa_window),
					swaActive: capacity.swa_active === true,
				}
			: undefined;

	const allocations = parseOpencotiAllocations(kv);

	return {
		reachable: true,
		...(release ? { release } : {}),
		poolsEnabled,
		elastic: elastic.enabled === true,
		...(account ? { kvScope: account.scope } : {}),
		...(account?.owner !== undefined ? { kvScopeOwner: account.owner } : {}),
		...(account?.headroomPct !== undefined
			? { kvHeadroomPct: account.headroomPct }
			: {}),
		...(account?.cellsFree !== undefined
			? { kvCellsFree: account.cellsFree }
			: {}),
		...(account?.cellsTotal !== undefined
			? { kvCellsTotal: account.cellsTotal }
			: {}),
		...(account?.cellsUsed !== undefined
			? { kvCellsUsed: account.cellsUsed }
			: {}),
		...(numberOr(kv?.largest_admissible) !== undefined
			? { largestAdmissible: kv?.largest_admissible as number }
			: {}),
		...(kv?.guaranteed !== undefined
			? { guaranteed: kv.guaranteed === true }
			: {}),
		...(numberOr(kv?.pools_max_per_slot) !== undefined
			? { poolsMaxPerSlot: kv?.pools_max_per_slot as number }
			: {}),
		...(numberOr(kv?.alloc_ttl_s) !== undefined
			? { allocTtlSeconds: kv?.alloc_ttl_s as number }
			: {}),
		allocations,
		...(account?.swaActive !== undefined
			? { swaActive: account.swaActive }
			: {}),
		// `null` is the engine declining to state a number it does not have,
		// and is carried through as null rather than flattened to zero.
		...(account?.swaActive
			? {
					swaCellsFree: account.swaFree ?? null,
					swaCellsTotal: account.swaTotal ?? null,
					swaWindow: account.swaWindow ?? null,
				}
			: {}),
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
