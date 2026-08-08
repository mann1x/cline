import {
	clearPolykvSession,
	createPolykvClient,
	getPolykvSession,
	normalizeProviderId,
	type PolykvCapacity,
	type PolykvClient,
	setPolykvSession,
} from "@cline/llms";
import type { BasicLogger } from "@cline/shared";

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
}

/** Whether this session runs on an engine that has a pool tree at all. */
export function isPolykvProvider(
	config: PolykvProviderConfig | undefined,
): boolean {
	return (
		config?.providerId !== undefined &&
		normalizeProviderId(config.providerId) === "opencoti" &&
		Boolean(config.baseUrl)
	);
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
 * The text whose tokens make up the shared prefix.
 *
 * System prompt then tools, in the order the request serialises them, because
 * the engine matches a prefix by hashing tokens: a prefix assembled in a
 * different order than it is sent matches nothing, and the pool silently buys
 * nothing at all.
 */
export function renderPolykvPrefix(options: {
	systemPrompt?: string;
	tools?: readonly unknown[];
}): string {
	const parts: string[] = [];
	if (options.systemPrompt) {
		parts.push(options.systemPrompt);
	}
	if (options.tools && options.tools.length > 0) {
		parts.push(JSON.stringify(options.tools));
	}
	return parts.join("\n");
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
	if (!options.sessionId || !isPolykvProvider(options.providerConfig)) {
		return undefined;
	}
	const existing = getPolykvSession(options.sessionId);
	if (existing) {
		return existing.poolId;
	}
	const client = clientFor(options.providerConfig);
	if (!client) {
		return undefined;
	}
	try {
		const prefix = renderPolykvPrefix({
			systemPrompt: options.systemPrompt,
			tools: options.tools,
		});
		if (!prefix) {
			return undefined;
		}
		const tokens = await client.tokenize(prefix);
		if (tokens.length === 0) {
			return undefined;
		}
		const pool = await client.createPool({ tokens, pin: true });
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
 * What the engine says about this pool's room, or `undefined` if it will not say.
 *
 * `expectedTokens` is the turn about to be sent, so the answer accounts for the
 * request rather than describing the pool at rest.
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
	try {
		return await client.capacity(state.poolId, {
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
		return undefined;
	}
}

/**
 * Whether the engine's own measurement says it is time to compact.
 *
 * A pool still settling reports pressure that describes a state it is leaving,
 * so it is not asked to decide anything.
 */
export function polykvSaysCompact(
	capacity: PolykvCapacity | undefined,
): boolean {
	if (!capacity || capacity.settling) {
		return false;
	}
	return (capacity.compaction_pressure ?? 0) >= POLYKV_COMPACTION_PRESSURE;
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
	if (!options.sessionId || !state || !isPolykvProvider(options.providerConfig)) {
		return undefined;
	}
	const client = clientFor(options.providerConfig);
	if (!client) {
		return undefined;
	}
	const previous = state.poolId;
	try {
		const tokens = await client.tokenize(options.compactedPrompt);
		const forked = await client.forkPool(previous, {
			branch_pos: state.prefixTokens,
			tokens,
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
			`[PolyKV] Re-rooted onto pool ${forked.pool_id} (${tokens.length} suffix tokens over ${state.prefixTokens} shared); released ${previous}`,
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

/** Unpin and release the session's pool. The one call that stops a leak. */
export async function releasePolykvSession(options: {
	sessionId: string | undefined;
	providerConfig: PolykvProviderConfig;
	logger?: BasicLogger;
}): Promise<void> {
	const state = getPolykvSession(options.sessionId);
	if (!options.sessionId || !state) {
		return;
	}
	clearPolykvSession(options.sessionId);
	const client = clientFor(options.providerConfig);
	if (!client) {
		return;
	}
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
