import type { PolykvOptions } from "@cline/llms";
import {
	clearPolykvSession,
	createPolykvClient,
	deferPolykvLeadClose,
	engineSessionId,
	getPolykvSession,
	getPolykvWindowGrant,
	hasOpencotiFeature,
	normalizeProviderId,
	OPENCOTI_FEATURES,
	type OpencotiAllocation,
	type OpencotiKvSnapshot,
	type PolykvCapacity,
	type PolykvClient,
	polykvEffectiveWindow,
	polykvWorkerChargedTo,
	probeOpencotiProps,
	readOpencotiKv,
	releasePolykvLead,
	setPolykvSession,
} from "@cline/llms";
import { type BasicLogger, hasPromptEnvironment } from "@cline/shared";

/**
 * The conversation's KV pool, on the engine that owns the cells.
 *
 * opencoti-llamafile keeps a tree of pools; a pool owns `[D, L)` and shares
 * everything before `D` with its parent. The part of an agent's context that
 * never changes -- system prompt and tool schemas -- can therefore be prefilled
 * once, pinned, and attached by every later request instead of re-sent.
 *
 * That prefix is not a rounding error here. Measured on the Ollama path in this
 * fork: 12,859 tokens of system prompt and tool definitions on every single
 * request, and one turn whose prefill ran past undici's five-minute header
 * timeout and killed the session.
 *
 * Two rules from the engine's own design are load-bearing and are why this
 * module exists rather than a couple of inline calls:
 *
 * - **Compaction is a prompt rewrite, never an in-place KV op.** Compacted text
 *   is new text and cannot match the old cells, so a re-root is
 *   `fork(root, D_sys, new suffix)` followed by releasing the old subtree.
 * - **A pin left on an abandoned subtree is a leak.** Unpin after migrating,
 *   every time, including on the failure paths.
 *
 * Nothing here may fail a turn. A pool that cannot be created or read means the
 * session runs exactly as it did before any of this existed: the whole prompt
 * on every request, and the estimate-based compaction trigger deciding when to
 * compact. Every entry point returns `undefined` rather than throwing.
 */

/**
 * How close to full the engine has to say the pool is before this compacts.
 *
 * Below the estimate-based trigger's own ratio on purpose. This number is
 * measured by the thing holding the cells, where every other signal in the
 * compaction path is an estimate -- and the estimates were wrong in both
 * directions inside a single session: a chars-per-token ratio that swung 3.16
 * to 5.42, an overhead term that read 53,323 tokens for a 12,700-token payload.
 * When the engine says it is nearly out, it is nearly out.
 */
export const POLYKV_COMPACTION_PRESSURE = 0.85;

export interface PolykvProviderConfig {
	providerId?: string;
	baseUrl?: string;
	headers?: Record<string, string>;
	fetch?: typeof fetch;
	/** The profile's PolyKV section. Absent means "never configured". */
	polykv?: PolykvOptions;
	/**
	 * Set on a swarm agent's config: its pools belong to the swarm's tree
	 * (`polykv-swarm.ts`), so the lead-conversation pool logic here stands down
	 * rather than building a second, private tree for every agent.
	 */
	polykvWorker?: unknown;
}

/**
 * Whether this session runs on an engine that has a pool tree, and wants it.
 *
 * `enabled` is read as off only when it says so. A profile written before the
 * section existed carries nothing, and treating that as "disabled" would take
 * pooling away from every session that already had it -- a silent regression
 * dressed up as a default.
 */
export function isPolykvProvider(
	config: PolykvProviderConfig | undefined,
): boolean {
	return (
		config?.providerId !== undefined &&
		normalizeProviderId(config.providerId) === "opencoti" &&
		Boolean(config.baseUrl) &&
		config.polykv?.enabled !== false
	);
}

/**
 * Whether this server really has a pool tree, asked of the server.
 *
 * {@link isPolykvProvider} answers a question about the *profile* -- opencoti,
 * a base URL, pooling not switched off -- which is as much as most of this
 * module needs, because every pool call it makes degrades to "no pool" on its
 * own. Offering a tool is different: the schema is paid for out of the context
 * window before anything is called, and a swarm on a server booted without
 * `--polykv-max-pools` -- the default -- fails on its first pool call having
 * already spent it.
 *
 * So this one waits for `/props`. The read is cached per server for the life of
 * the process, and an unreachable server answers `false`: "cannot ask" is not
 * "yes", which is the same reading the slot limit takes.
 */
export async function polykvPoolsConfirmed(
	config: PolykvProviderConfig | undefined,
): Promise<boolean> {
	if (!config || !isPolykvProvider(config)) {
		return false;
	}
	const props = await probeOpencotiProps(config.baseUrl, config.fetch).catch(
		() => undefined,
	);
	return props?.poolsEnabled === true;
}

function clientFor(config: PolykvProviderConfig): PolykvClient | undefined {
	if (!config.baseUrl) {
		return undefined;
	}
	return createPolykvClient({
		baseUrl: config.baseUrl,
		...(config.fetch ? { fetch: config.fetch } : {}),
		...(config.headers ? { headers: config.headers } : {}),
	});
}

/**
 * The messages whose templated tokens make up the shared prefix.
 *
 * Returned as a chat body rather than a string, because the string is not ours
 * to write. The engine prefills whatever its own chat template produced, and a
 * prefix assembled here -- the system prompt, a newline, `JSON.stringify` of
 * the tool schemas -- is a different token sequence from the one that gets
 * prefilled. The pool is then created, pinned and attached, and shares nothing,
 * on every turn, with nothing reporting it. Only the server knows which
 * template it loaded and how that template renders tools.
 *
 * The prefix does not have to be exactly right, only honest: the engine
 * computes the shared length itself as the longest exact token match (auto-P),
 * and an explicit hint may only cap that, never raise it. So a prefix running
 * slightly past the true boundary shares less, rather than failing.
 */
export function renderPolykvPrefixMessages(options: {
	systemPrompt?: string;
	tools?: readonly unknown[];
}): { messages: readonly unknown[]; tools?: readonly unknown[] } | undefined {
	if (!options.systemPrompt) {
		return undefined;
	}
	const tools = toEngineTools(options.tools);
	return {
		messages: [{ role: "system", content: options.systemPrompt }],
		...(tools.length > 0 ? { tools } : {}),
	};
}

/**
 * The runtime's tools in the shape the engine's tool parser accepts.
 *
 * The runtime carries `{name, description, inputSchema}`; `/apply-template`
 * parses OpenAI's `{type:"function", function:{...}}` and answers
 * `500 Failed to parse tools: Missing tool type` to anything else. Measured on
 * pandorum 2026-09-18: every single call failed that way, so no prefix was ever
 * rendered, no pool was ever created, and the session ran unpooled behind one
 * warn line. The chat request itself is shaped by the provider on its own way
 * out, which is why this was only ever wrong on the pool path.
 *
 * An already-shaped tool passes through untouched -- the provider may hand us
 * either -- and a tool with no name is dropped: it cannot be rendered, and one
 * of them must not cost the pool. This is a cache key, not the request.
 */
function toEngineTools(tools: readonly unknown[] | undefined): unknown[] {
	const shaped: unknown[] = [];
	for (const tool of tools ?? []) {
		if (!tool || typeof tool !== "object") {
			continue;
		}
		const candidate = tool as Record<string, unknown>;
		if (candidate.type === "function" && candidate.function) {
			shaped.push(tool);
			continue;
		}
		const name = candidate.name;
		if (typeof name !== "string" || name === "") {
			continue;
		}
		shaped.push({
			type: "function",
			function: {
				name,
				description:
					typeof candidate.description === "string"
						? candidate.description
						: "",
				parameters: candidate.inputSchema ??
					candidate.parameters ?? { type: "object" },
			},
		});
	}
	return shaped;
}

/**
 * End the pinned prefix at a token boundary.
 *
 * A prefix ending in a trailing space merges with the first word of whatever
 * follows into a single token, so the child's `[0, branch_pos)` no longer
 * matches the parent's and the contiguous-prefix check answers 400. A newline
 * is the boundary every chat template already ends its blocks on.
 */
export function endAtTokenBoundary(prompt: string): string {
	const trimmed = prompt.replace(/[ \t]+$/, "");
	return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

/**
 * Create and pin the session's root pool, once.
 *
 * Idempotent: a session that already has one keeps it. The pin is what stops
 * the engine reclaiming the prefix between turns, and is released by
 * `releasePolykvSession`.
 */
export async function ensurePolykvPool(options: {
	sessionId: string | undefined;
	providerConfig: PolykvProviderConfig;
	systemPrompt?: string;
	tools?: readonly unknown[];
	logger?: BasicLogger;
}): Promise<string | undefined> {
	if (
		!options.sessionId ||
		!isPolykvProvider(options.providerConfig) ||
		options.providerConfig.polykvWorker
	) {
		return undefined;
	}
	const existing = getPolykvSession(options.sessionId);
	if (existing) {
		return existing.poolId;
	}
	// A prompt carrying environment spans is a lead conversation's, and the
	// vendor's fetch attaches it to the server-wide lead tree on the wire
	// (`polykv-lead.ts`). A root of its own here would be the private copy of
	// the prefix that tree exists to share.
	if (hasPromptEnvironment(options.systemPrompt)) {
		return undefined;
	}
	const client = clientFor(options.providerConfig);
	if (!client) {
		return undefined;
	}
	try {
		const prefix = renderPolykvPrefixMessages({
			...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
			...(options.tools ? { tools: options.tools } : {}),
		});
		if (!prefix) {
			return undefined;
		}
		// The server renders it, and the server tokenizes it: `prompt` gets the
		// same BOS and special-token treatment a completion prompt gets, which is
		// the treatment the prefill it has to match was given.
		const templated = endAtTokenBoundary(await client.applyTemplate(prefix));
		if (templated.trim() === "") {
			return undefined;
		}
		// Owned by this session, which is what makes a worker attaching to it
		// free: the engine prices such a request against the owner's window
		// instead of booking a guaranteed one for it. A pool built from a
		// prompt has no owner unless it is named here.
		const pool = await client.createPool({
			prompt: templated,
			pin: true,
			session_id: options.sessionId,
		});
		setPolykvSession(options.sessionId, {
			poolId: pool.pool_id,
			prefixTokens: pool.prefix_len,
		});
		options.logger?.log?.(
			`[PolyKV] Pinned ${pool.prefix_len} prefix tokens as pool ${pool.pool_id}`,
		);
		return pool.pool_id;
	} catch (error) {
		// The session runs unpooled. Slower, never broken.
		options.logger?.log?.(
			`[PolyKV] Could not pin the prefix; running unpooled: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ severity: "warn" },
		);
		return undefined;
	}
}

/**
 * How often one session may ask the engine for its room.
 *
 * `GET /capacity` is not a read on the published c7 engine: every GET folds the
 * settle and bias EWMAs the admission projection is built from. The fold is
 * what the enforced gate does on an admission, once per gated request -- and a
 * client that also asks on its own cadence adds folds the engine never made,
 * from moments that were not admissions, and then acts on the projection it
 * skewed.
 *
 * Two callers want the answer: the compaction check, once a turn, and the
 * delegation admission gate, once a round. Bounding here rather than in either
 * of them is deliberate -- it holds however many callers appear later, and it
 * cannot be forgotten at a new call site.
 *
 * (c8 makes the plain GET read-only and moves the fold behind `?fold=1`. This
 * bound then stops being load-bearing, and is still the right manners.)
 */
export const POLYKV_CAPACITY_MIN_INTERVAL_MS = 5_000;

/** The last answer per session, and when it was folded out of the engine. */
const POLYKV_CAPACITY_CACHE = new Map<
	string,
	{ at: number; poolId: string; value: PolykvCapacity | undefined }
>();

/** Forget a session's last capacity answer. Test seam, and release path. */
export function clearPolykvCapacityCache(sessionId?: string): void {
	if (sessionId === undefined) {
		POLYKV_CAPACITY_CACHE.clear();
		return;
	}
	POLYKV_CAPACITY_CACHE.delete(sessionId);
}

/**
 * What the engine says about this pool's room, or `undefined` if it will not say.
 *
 * `expectedTokens` is the turn about to be sent, so the answer accounts for the
 * request rather than describing the pool at rest.
 *
 * Answered from the last read when one is recent enough -- see
 * {@link POLYKV_CAPACITY_MIN_INTERVAL_MS} for why that is a correctness
 * property on c7 and not a performance one.
 */
export async function readPolykvCapacity(options: {
	sessionId: string | undefined;
	providerConfig: PolykvProviderConfig;
	expectedTokens?: number;
	logger?: BasicLogger;
}): Promise<PolykvCapacity | undefined> {
	const state = getPolykvSession(options.sessionId);
	if (!state || !isPolykvProvider(options.providerConfig)) {
		return undefined;
	}
	const client = clientFor(options.providerConfig);
	if (!client) {
		return undefined;
	}
	const key = options.sessionId ?? "";
	const cached = POLYKV_CAPACITY_CACHE.get(key);
	if (
		cached &&
		cached.poolId === state.poolId &&
		Date.now() - cached.at < POLYKV_CAPACITY_MIN_INTERVAL_MS
	) {
		return cached.value;
	}
	let value: PolykvCapacity | undefined;
	try {
		value = await client.capacity(state.poolId, {
			...(options.expectedTokens !== undefined
				? { expected_tokens: options.expectedTokens }
				: {}),
		});
	} catch (error) {
		options.logger?.debug?.(
			`[PolyKV] Capacity unavailable for pool ${state.poolId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		value = undefined;
	}
	// A failed read is cached too: an unreachable control plane answers the
	// same way for the next caller, and retrying it per turn is the poll this
	// bound exists to prevent.
	POLYKV_CAPACITY_CACHE.set(key, {
		at: Date.now(),
		poolId: state.poolId,
		value,
	});
	return value;
}

/** The last `/kv` read per session, bounded like the capacity read. */
const POLYKV_ALLOCATION_CACHE = new Map<
	string,
	{ at: number; value: OpencotiKvSnapshot | undefined }
>();

/** Forget the cached allocations. Test seam. */
export function clearPolykvAllocationCache(): void {
	POLYKV_ALLOCATION_CACHE.clear();
}

/**
 * This session's row of `GET /kv`'s `allocations[]`, or `undefined`.
 *
 * The compaction trigger's preferred signal (P4): `pressure` there is the RAW
 * `used/window` of the window the session booked, the number the user's
 * threshold is written against. Unlike a pool's `/capacity` it needs no pool --
 * a session can book a window with pooling off -- so it is asked for on its
 * own, and only where the server offers the route (`kv_status_v1`).
 *
 * **A delegated agent reads the booking it lives in.** A worker whose turns
 * are pooled books nothing -- the engine charges its suffix to the owner the
 * swarm assigned it (the lead's own session on priority 0) -- so the owner's
 * row is its pressure. A worker whose last turn went out unpooled runs as a
 * session of its own, and its own row is. Each falls back to the other when
 * its row is not listed. Turning every worker away here, as this once did,
 * left no delegated agent on a PolyKV node able to compact on engine pressure.
 *
 * Bounded by {@link POLYKV_CAPACITY_MIN_INTERVAL_MS}, the same manners as the
 * capacity read, and a failed read is cached too.
 */
export async function readPolykvAllocation(options: {
	sessionId: string | undefined;
	providerConfig: PolykvProviderConfig;
	logger?: BasicLogger;
}): Promise<OpencotiAllocation | undefined> {
	const snapshot = await readPolykvKvSnapshot(options);
	if (!snapshot || !options.sessionId) {
		return undefined;
	}
	// The id the wire carried: `session_id` is sent as `engineSessionId(...)`.
	const wireId = engineSessionId(options.sessionId);
	// A worker charged to an owner reads the owner's row first.
	const owner = options.providerConfig.polykvWorker
		? polykvWorkerChargedTo(options.sessionId)
		: undefined;
	const order = owner && owner !== wireId ? [owner, wireId] : [wireId];
	for (const id of order) {
		const row = snapshot.allocations.find((entry) => entry.sessionId === id);
		if (row) {
			return row;
		}
	}
	return undefined;
}

/**
 * This session's last `GET /kv` read: every allocation row, and the server's
 * `pressure` where it states one (`kv_pressure_v1`).
 *
 * The one read behind both the compaction trigger's row
 * ({@link readPolykvAllocation}) and the pressure policy (`kv-pressure.ts`),
 * so a turn asks `/kv` once. Bounded by
 * {@link POLYKV_CAPACITY_MIN_INTERVAL_MS} per session, and a failed read is
 * cached too.
 */
export async function readPolykvKvSnapshot(options: {
	sessionId: string | undefined;
	providerConfig: PolykvProviderConfig;
	logger?: BasicLogger;
}): Promise<OpencotiKvSnapshot | undefined> {
	const config = options.providerConfig;
	if (
		!options.sessionId ||
		!config.baseUrl ||
		config.providerId === undefined ||
		normalizeProviderId(config.providerId) !== "opencoti"
	) {
		return undefined;
	}
	const cached = POLYKV_ALLOCATION_CACHE.get(options.sessionId);
	if (cached && Date.now() - cached.at < POLYKV_CAPACITY_MIN_INTERVAL_MS) {
		return cached.value;
	}
	let value: OpencotiKvSnapshot | undefined;
	try {
		value = await readOpencotiKv(config.baseUrl, config.fetch);
	} catch (error) {
		options.logger?.debug?.(
			`[PolyKV] Allocations unavailable: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		value = undefined;
	}
	POLYKV_ALLOCATION_CACHE.set(options.sessionId, { at: Date.now(), value });
	return value;
}

/**
 * Whether the engine's own measurement says it is time to compact.
 *
 * The RAW ratio decides (P4, ruled): this session's `pressure` from `GET /kv`
 * first, then the pool's own raw `pressure` (`session_pressure_v1`), and only
 * where neither is stated the older `compaction_pressure` -- a 0.70..1.0 ramp
 * that stops matching the threshold the user set the moment it is compared
 * against one.
 *
 * A pool still settling reports pressure that describes a state it is leaving,
 * so it is not asked to decide anything. The allocation is the booked window's
 * own ledger and is not subject to that.
 */
export function polykvSaysCompact(
	capacity: PolykvCapacity | undefined,
	threshold?: number,
	allocation?: Pick<OpencotiAllocation, "pressure">,
): boolean {
	const at =
		typeof threshold === "number" && threshold > 0 && threshold <= 1
			? threshold
			: POLYKV_COMPACTION_PRESSURE;
	const raw = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isFinite(value) ? value : undefined;
	const allocated = raw(allocation?.pressure);
	if (allocated !== undefined) {
		return allocated >= at;
	}
	if (!capacity || capacity.settling) {
		return false;
	}
	return (raw(capacity.pressure) ?? capacity.compaction_pressure ?? 0) >= at;
}

/**
 * The window compaction must size against: the granted one, when it is known
 * and smaller than the configured one.
 *
 * A conversation negotiated down to 160k of a configured 256k is a 160k
 * conversation for its whole life -- the server holds that and nothing more --
 * so a trigger computed against 256k fires after the window has already
 * overflowed. The effective grant counts a shared prefix riding above a
 * private budget. Larger than configured is not a reason to size up: the
 * configured window is what the rest of the session (the output cap, the
 * prompt) was built for.
 */
export function resolveGrantedContextWindow(
	sessionId: string | undefined,
	providerId: string | undefined,
	configuredWindow: number | undefined,
): number | undefined {
	if (
		providerId === undefined ||
		normalizeProviderId(providerId) !== "opencoti"
	) {
		return undefined;
	}
	const effective = polykvEffectiveWindow(getPolykvWindowGrant(sessionId));
	if (effective === undefined) {
		return undefined;
	}
	if (
		typeof configuredWindow === "number" &&
		Number.isFinite(configuredWindow) &&
		configuredWindow > 0 &&
		effective >= configuredWindow
	) {
		return undefined;
	}
	return effective;
}

/**
 * Re-root the conversation onto a fork of the shared prefix.
 *
 * Called after a compaction has rewritten the transcript. The new pool branches
 * from the root at `D_sys` -- the prefix is unchanged and stays shared, which is
 * the entire saving -- and carries the compacted suffix. The old subtree is
 * unpinned and released once the session has migrated, in that order: a pin
 * outliving its subtree is a leak of the cells it holds.
 *
 * Returns the new pool id, or `undefined` when the session stays where it was.
 */
export async function repointPolykvAfterCompaction(options: {
	sessionId: string | undefined;
	providerConfig: PolykvProviderConfig;
	compactedPrompt: string;
	logger?: BasicLogger;
}): Promise<string | undefined> {
	const state = getPolykvSession(options.sessionId);
	if (
		!options.sessionId ||
		!state ||
		!isPolykvProvider(options.providerConfig)
	) {
		return undefined;
	}
	// A lead's pool covers the system prompt, tools and environment turn only,
	// and compaction rewrites none of them: the compacted conversation still
	// opens with that prefix. Nothing to re-root -- and the pool may be the
	// root every other conversation on the server attaches to.
	if (state.layout === "lead") {
		return undefined;
	}
	// A pool this session only attaches to -- a swarm worker on the lead's
	// snapshot. Re-rooting would fork it at 0 and then unpin and release
	// `previous`: the lead's pool, with the rest of the round on it. The
	// worker stays attached, which is the safe side, as for a failed re-root.
	if (state.layout === "borrowed") {
		return undefined;
	}
	const client = clientFor(options.providerConfig);
	if (!client) {
		return undefined;
	}
	const previous = state.poolId;
	try {
		// `from_session`, not tokens. The body here is the child's FULL path
		// `[0, L)`, checked token-exact against the parent over `[0, branch_pos)`
		// -- sending the compacted text alone is a suffix, and is answered 400
		// every time. Snapshotting the live session sidesteps the question
		// entirely: the engine reads the prefix from the slot's own token history
		// and nothing crosses the wire to be re-tokenized.
		const forked = await client.forkPool(previous, {
			branch_pos: state.prefixTokens,
			from_session: options.sessionId,
			session_id: options.sessionId,
		});
		await client.pin(forked.pool_id);
		setPolykvSession(options.sessionId, {
			poolId: forked.pool_id,
			// The fork shares the same prefix, so the next re-root branches at the
			// same point. Reading it back from the fork would set the branch to
			// the compacted suffix and make the prefix unshareable one compaction
			// later.
			prefixTokens: state.prefixTokens,
		});
		// Only now: until the session is pointed at the fork, the old pool is
		// still the one serving requests.
		await client.unpin(previous).catch(() => undefined);
		await client.releasePool(previous).catch(() => undefined);
		options.logger?.log?.(
			`[PolyKV] Re-rooted onto pool ${forked.pool_id} (${forked.prefix_len} tokens, ${state.prefixTokens} shared with the root); released ${previous}`,
		);
		return forked.pool_id;
	} catch (error) {
		// The old pool is still pinned and still attached, which is the safe
		// side of this failure: the conversation carries on, paying full prefill
		// for the rewritten suffix.
		options.logger?.log?.(
			`[PolyKV] Could not re-root after compaction; staying on pool ${previous}: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ severity: "warn" },
		);
		return undefined;
	}
}

/**
 * End a session: release its pool, then give its window back.
 *
 * The one call that stops a leak, and it now stops two of them. The pool half
 * is unpin-then-release, which is what keeps a pinned prefix from blocking
 * reclaim forever. The window half is `POST /sessions/{id}/close`, and without
 * it a guaranteed allocation stays booked for the server's idle TTL -- five
 * minutes on the build this was written against -- so a user who ends one 256k
 * conversation and opens another waits out their own last session.
 *
 * **The window is released even when there was never a pool.** A session can
 * book a window with pooling off, or before a pool has been built, and gating
 * the close on pool state would leak exactly those -- which are the expensive
 * ones, since the whole allocation is held rather than a prefix.
 */
export async function releasePolykvSession(options: {
	sessionId: string | undefined;
	providerConfig: PolykvProviderConfig;
	logger?: BasicLogger;
}): Promise<void> {
	if (!options.sessionId) {
		return;
	}
	const sessionId = options.sessionId;
	const state = getPolykvSession(sessionId);
	// Its place in the lead tree first: the sub-pool it owns, and the shared
	// root with the last conversation on it. Never by the registry's id, which
	// may name that shared root.
	await releasePolykvLead(sessionId).catch(() => undefined);
	clearPolykvSession(sessionId);
	// The answer described a pool that is about to stop existing.
	clearPolykvCapacityCache(sessionId);
	POLYKV_ALLOCATION_CACHE.delete(sessionId);
	// The granted window is NOT forgotten here. Closing gives the cells back;
	// it does not change the window the conversation was opened with, and a
	// conversation continued after its close must ask for exactly that one
	// (the resume rule). Forgetting it made the next turn a new session that
	// negotiated down -- a silent shrink under a history that no longer fits.
	const client = clientFor(options.providerConfig);
	if (!client) {
		return;
	}
	// Neither a lead-tree pool nor a borrowed one is this session's to release.
	if (state && state.layout !== "lead" && state.layout !== "borrowed") {
		try {
			await client.unpin(state.poolId);
			await client.releasePool(state.poolId);
			options.logger?.debug?.(`[PolyKV] Released pool ${state.poolId}`);
		} catch (error) {
			options.logger?.debug?.(
				`[PolyKV] Could not release pool ${state.poolId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	// Only where the server says it has the route. A 404 landing in the catch
	// below would read as "closed", which is this module's founding bug wearing
	// a different hat.
	const props = await probeOpencotiProps(
		options.providerConfig.baseUrl,
		options.providerConfig.fetch,
	).catch(() => undefined);
	if (!hasOpencotiFeature(props?.features, OPENCOTI_FEATURES.sessionClose)) {
		return;
	}
	const close = async (): Promise<void> => {
		try {
			// The id the wire carried: the fetch sends `engineSessionId(...)`,
			// and the close route cannot match a `/`.
			const released = await client.closeSession(engineSessionId(sessionId));
			options.logger?.debug?.(
				released
					? `[PolyKV] Closed session ${sessionId}`
					: // Not an error, and worth saying: the server held no window
						// under this id, so ours and theirs have diverged.
						`[PolyKV] Server held no window for session ${sessionId}`,
			);
		} catch (error) {
			options.logger?.debug?.(
				`[PolyKV] Could not close session ${sessionId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	};
	// "Use PolyKV agents as Priority 0": agents may be running as sub-pools of
	// this very session. Closing it releases their pools, and the engine does
	// not refuse a worker that names a released pool -- it prefills the whole
	// prompt again, silently (opencoti, mail 269). So the close waits for the
	// last of them.
	if (deferPolykvLeadClose(sessionId, close)) {
		options.logger?.log(
			`[PolyKV] Session ${sessionId} ended with priority-0 agents still running in it; its window is closed after the last of them`,
		);
		return;
	}
	await close();
}

/**
 * Snapshot a session's live context into a pool the workers can share.
 *
 * `from_session` first: the engine takes the prefix from the slot's own token
 * history, so no tokens cross the wire and the failure class this module was
 * written to fix -- a client-tokenised prefix that does not match the prefilled
 * one -- cannot arise on that path at all.
 *
 * **When this runs matters as much as what it does.** The host prompt cache
 * saves and clears idle slots the moment any new task launches, so the snapshot
 * has to be taken at the end of the lead's turn, before any worker starts. Taken
 * late it captures a slot that has already been cleared.
 *
 * `ephemeral` so the engine's own sweep can reclaim it if this process dies
 * mid-round. That is the crash net; {@link releasePolykvPool} is the plan.
 *
 * **And it is refused often.** The engine's own soak against the shipped
 * bytes saw `400` on 331 of 715 `from_session` creates. That is correct
 * behaviour rather than a fault: the snapshot comes from the cache resident in
 * the session's LAST slot, and once that slot has been bound to someone else
 * the session has no affinity left -- refusing beats building this session's
 * pool out of another session's context. The rate rises exactly when a swarm is
 * most worth running, because it tracks how hard the slots are churning.
 *
 * So a refusal falls back to **borrowing the session's own root pool**, which
 * is still pinned and still holds the system prompt and the tool schemas --
 * about a third of the window by measurement. The workers share most of what
 * matters instead of re-prefilling the lead's entire context each.
 *
 * A borrowed pool is marked, and **the caller must not release it**: it belongs
 * to the lead and is serving the conversation. Dropping it at the end of a
 * round would unpin the prefix the lead is still using, which is worse than the
 * unpooled round this fallback exists to avoid.
 *
 * `undefined` only when there is nothing to borrow either, which lets the
 * caller run the round unpooled rather than fail it.
 */
export async function snapshotPolykvSession(options: {
	sessionId: string | undefined;
	providerConfig: PolykvProviderConfig;
	logger?: BasicLogger;
}): Promise<PolykvSnapshot | undefined> {
	if (!options.sessionId || !isPolykvProvider(options.providerConfig)) {
		return undefined;
	}
	const client = clientFor(options.providerConfig);
	if (!client) {
		return undefined;
	}
	try {
		const pool = await client.createPool({
			from_session: options.sessionId,
			// Implied by `from_session` on the server, and stated anyway: the
			// workers are charged to the lead's window only while the pool they
			// share is owned by the lead.
			session_id: options.sessionId,
			ephemeral: true,
		});
		options.logger?.debug?.(
			`[PolyKV] Snapshotted session ${options.sessionId} into pool ${pool.pool_id} (${pool.prefix_len} tokens)`,
		);
		return { poolId: pool.pool_id, prefixTokens: pool.prefix_len };
	} catch (error) {
		const root = getPolykvSession(options.sessionId);
		if (root) {
			options.logger?.debug?.(
				`[PolyKV] Could not snapshot session ${options.sessionId} (${
					error instanceof Error ? error.message : String(error)
				}); the workers will share its root pool ${root.poolId} instead`,
			);
			return {
				poolId: root.poolId,
				prefixTokens: root.prefixTokens,
				borrowed: true,
			};
		}
		options.logger?.debug?.(
			`[PolyKV] Could not snapshot session ${options.sessionId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		return undefined;
	}
}

export interface PolykvSnapshot {
	poolId: string;
	prefixTokens: number;
	/**
	 * This pool was not created for the round and is not the round's to drop.
	 *
	 * It is the lead's root pool, pinned and serving the conversation. A caller
	 * that releases it unpins the prefix the lead is still using.
	 */
	borrowed?: boolean;
}

/**
 * Release a pool this process created, whatever happened to the work on it.
 *
 * Unpin first, always. The engine will not reclaim a pinned pool, and a pin
 * left on an abandoned subtree blocks reclaim forever -- which is the leak the
 * whole of this module's release discipline exists to prevent.
 */
export async function releasePolykvPool(options: {
	poolId: string;
	providerConfig: PolykvProviderConfig;
	logger?: BasicLogger;
}): Promise<void> {
	const client = clientFor(options.providerConfig);
	if (!client) {
		return;
	}
	try {
		await client.unpin(options.poolId);
		await client.releasePool(options.poolId);
		options.logger?.debug?.(`[PolyKV] Released pool ${options.poolId}`);
	} catch (error) {
		options.logger?.debug?.(
			`[PolyKV] Could not release pool ${options.poolId}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}
