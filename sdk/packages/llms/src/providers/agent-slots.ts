import { probePolykvEnabled } from "./vendors/polykv";

/**
 * How many requests an endpoint will serve at once, and what that means for
 * how many delegated agents may run.
 *
 * A local server has a fixed number of slots -- `OLLAMA_NUM_PARALLEL` for
 * Ollama, `--parallel N` for llama.cpp and opencoti -- and a request that finds
 * none free is not refused, it is *queued*. Nothing reports that. The run looks
 * slow rather than blocked, and the more agents are spawned the worse it gets,
 * because they are queueing behind each other on one server. A hosted provider
 * has the same shape with a different cause: a plan allows so many concurrent
 * requests and the rest wait or fail.
 *
 * The number cannot be discovered in general -- a plan's allowance is not on
 * the wire, and Ollama does not report `OLLAMA_NUM_PARALLEL` -- so it is
 * configured per profile beside the context window. One is the honest default:
 * it is what `--parallel` and a basic plan give you, and it is the value under
 * which nothing queues unexpectedly.
 */

/** Below this a profile could serve nothing. */
export const MIN_PARALLEL_SESSIONS = 1;

/**
 * Above this the number stops describing a server and starts describing a
 * wish. Ten concurrent agents on one endpoint is already past where any local
 * server holds its per-session throughput.
 */
export const MAX_PARALLEL_SESSIONS = 10;

/** What a profile that has never been told otherwise is worth. */
export const DEFAULT_PARALLEL_SESSIONS = 1;

/**
 * Reads a stored `parallelSessions` into the range a server could honour.
 *
 * `undefined` for anything unusable rather than the default, so a caller can
 * tell "not configured" from "configured as 1" -- the settings panel shows an
 * empty field for the first and a 1 for the second.
 */
export function normalizeParallelSessions(value: unknown): number | undefined {
	const parsed = typeof value === "string" ? Number(value) : value;
	if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
		return undefined;
	}
	return Math.min(
		MAX_PARALLEL_SESSIONS,
		Math.max(MIN_PARALLEL_SESSIONS, Math.floor(parsed)),
	);
}

export interface AgentSlotLimit {
	/**
	 * Most delegated agents that may run at once.
	 *
	 * `0` means no cap of ours -- which is not "as many as you like" but
	 * "something else decides", and the only thing that says it today is PolyKV.
	 * Zero rather than `undefined` on purpose: this value is stored on the
	 * session config, where `undefined` has to keep meaning "no host resolved
	 * one, leave every previous behaviour alone".
	 */
	limit: number;
	/** Why, in one line, for the log. Never a value the caller branches on. */
	reason: string;
}

/**
 * How many delegated agents may run at once against this endpoint.
 *
 * The exception is PolyKV on opencoti. There, agents attach to a KV pool and
 * share a slot, and whether one more may start is decided by the engine's
 * admission control against measured KV headroom -- `can_admit`, and a 429 with
 * a `retry-after` when the answer is no. Counting slots in that case would
 * refuse work the server would have taken, so the cap is lifted and the server
 * paces the agents.
 */
export async function resolveAgentSlotLimit(input: {
	providerId: string | undefined;
	baseUrl?: string;
	parallelSessions?: unknown;
	fetch?: typeof fetch;
}): Promise<AgentSlotLimit> {
	const configured = normalizeParallelSessions(input.parallelSessions);
	if (input.providerId === "opencoti") {
		const polykv = await probePolykvEnabled(input.baseUrl, input.fetch);
		if (polykv) {
			return {
				limit: 0,
				reason: "opencoti has PolyKV on; admission decides, not slot count",
			};
		}
	}
	const limit = configured ?? DEFAULT_PARALLEL_SESSIONS;
	return {
		limit,
		reason: configured
			? `${limit} parallel session(s) configured for this profile`
			: `no parallel-session count configured; assuming ${limit}`,
	};
}
