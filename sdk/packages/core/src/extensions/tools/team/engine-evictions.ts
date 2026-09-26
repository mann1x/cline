/**
 * Every session the engine evicted, as this process saw it.
 *
 * opencoti's partial eviction (patch 0233) drops the largest live sequence
 * when the KV cannot fit another token, to keep the rest of the batch alive.
 * Ruled after swarm 0926 on b108 (11 agents holding 20-31k of 64k ended on
 * it): no session is ever evicted. An eviction is a critical failure and a
 * bug in the engine, never an operating mode -- so the agent is retried like
 * a refusal, and every eviction is counted here, where the lead's status
 * (`agents_status`) and the round report read it, and reported at WARN by the
 * agent loop.
 *
 * Also delivered live on the agent's row: every update the turn-fault
 * recovery emits for an eviction carries `evicted`, that agent's count so
 * far, for whoever keeps per-agent state from the row stream.
 */

/** One eviction. */
export interface EngineEviction {
	/** `Date.now()` when the agent was told. */
	at: number;
	/** The agent, as its row and the log name it. */
	label: string;
	/** The node or server that evicted it. */
	where?: string;
	/** The evicted session, when the loop knew it. */
	sessionId?: string;
	/** What the session held at the least: its last completed request. */
	tokensHeld?: number;
	/** The engine's text. */
	message: string;
}

/** The most kept in full; the count is never capped. */
const MAX_KEPT = 500;

const EVICTIONS: EngineEviction[] = [];
let total = 0;

export function recordEngineEviction(eviction: EngineEviction): void {
	total += 1;
	EVICTIONS.push({ ...eviction });
	if (EVICTIONS.length > MAX_KEPT) {
		EVICTIONS.splice(0, EVICTIONS.length - MAX_KEPT);
	}
}

/** Every eviction since the process started. */
export function engineEvictionCount(): number {
	return total;
}

/** The evictions kept, oldest first; optionally only those since `since`. */
export function engineEvictions(since?: number): EngineEviction[] {
	return EVICTIONS.filter(
		(eviction) => since === undefined || eviction.at >= since,
	).map((eviction) => ({ ...eviction }));
}

/** Test seam. */
export function resetEngineEvictions(): void {
	EVICTIONS.length = 0;
	total = 0;
}
