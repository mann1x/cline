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

/** What `/polykv/pools/{id}/capacity` answers, as far as a caller needs it. */
export interface PolykvCapacity {
	can_admit: boolean;
	headroom_sessions?: number;
	kv_headroom_pct?: number;
	reason?: string;
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
	projected_mean_tps_if_admitted?: number;
	settling?: boolean;
	settle_remaining_ms?: number;
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

export interface PolykvClient {
	/** Create a root pool, from tokens or by snapshotting a live session. */
	createPool(body: {
		tokens?: number[];
		from_session?: string;
		pin?: boolean;
	}): Promise<PolykvPool>;
	/**
	 * Branch a pool at `branch_pos`.
	 *
	 * `branch_pos === parent.prefix_len` extends it; anything less is a
	 * copy-on-write branch. The engine checks the contiguous-prefix contract
	 * and answers `409` when the declared prefix does not hash-match, which is
	 * a re-root instruction rather than a failure.
	 */
	forkPool(
		poolId: string,
		body: { branch_pos: number; tokens?: number[]; from_session?: string },
	): Promise<PolykvPool>;
	pin(poolId: string): Promise<void>;
	unpin(poolId: string): Promise<void>;
	releasePool(poolId: string): Promise<void>;
	capacity(
		poolId: string,
		query?: { expected_tokens?: number },
	): Promise<PolykvCapacity>;
	tokenize(content: string): Promise<number[]>;
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

export function createPolykvClient(
	options: PolykvClientOptions,
): PolykvClient {
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

	return {
		createPool: (body) =>
			call<PolykvPool>("/polykv/pools", { method: "POST", body }),
		forkPool: (poolId, body) =>
			call<PolykvPool>(`/polykv/pools/${encodeURIComponent(poolId)}/fork`, {
				method: "POST",
				body,
			}),
		pin: async (poolId) => {
			await call(`/polykv/pools/${encodeURIComponent(poolId)}/pin`, {
				method: "POST",
				body: {},
			});
		},
		// Unpinning is the same retention control with the flag off. Named
		// separately because the discipline that matters -- unpin after migrate
		// -- reads as its own step, and a pin left behind blocks reclaim.
		unpin: async (poolId) => {
			await call(`/polykv/pools/${encodeURIComponent(poolId)}/pin`, {
				method: "POST",
				body: { pinned: false },
			});
		},
		releasePool: async (poolId) => {
			await call(`/polykv/pools/${encodeURIComponent(poolId)}`, {
				method: "DELETE",
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
	};
}
