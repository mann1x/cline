import { probeOpencotiProps } from "./vendors/polykv";

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
 * A guard against a typo, not a statement about what a server can do.
 *
 * This was 10, chosen on 2026-08-10 on the reasoning that "ten concurrent
 * agents on one endpoint is already past where any local server holds its
 * per-session throughput". That was a claim about local llama.cpp servers, and
 * it stopped being the whole picture twice over:
 *
 * - A **hosted** provider's concurrency is whatever the plan allows, which is
 *   routinely more than ten and is not ours to cap.
 * - An **elastic** opencoti grows `slots_live` past `--parallel` on demand, so
 *   there is no fixed local count to be past in the first place.
 *
 * And it was binding in practice: a tester's profile sat at exactly 10, which
 * is what a cap looks like when it is the thing choosing the number.
 *
 * So the bound is now only wide enough to catch a slipped digit. The real
 * refusal belongs to the endpoint, which knows its own admission; ours is a
 * ceiling the user opted into, and leaving the field empty asks for none.
 */
export const MAX_PARALLEL_SESSIONS = 64;

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
 * The exception is an *elastic* opencoti, by either of the two mechanisms that
 * make it one. Under PolyKV, agents attach to a KV pool and share a slot, and
 * whether one more may start is decided by the engine's admission control
 * against measured KV headroom -- `can_admit`, and a 429 with a `retry-after`
 * when the answer is no. Under the elastic slot controller the server grows
 * `slots_live` toward `slots_max` as load arrives. Either way the slot count is
 * not a number this side can compute, and counting would refuse work the server
 * would have taken.
 *
 * Which is why the configured count changes meaning rather than being ignored
 * there. On a fixed server it *describes* the server, and its absence has to
 * mean one, because a request that finds no free slot queues silently and
 * nothing reports that. On an elastic one nothing needs describing, so the
 * field becomes a ceiling the user asked for -- the engine may well be willing
 * to take more, and a number in that box says don't. Absent, the engine decides
 * alone. Discarding the number because the engine has an opinion would make the
 * field unusable on exactly the servers someone would reach for it on.
 */
export async function resolveAgentSlotLimit(input: {
	providerId: string | undefined;
	baseUrl?: string;
	parallelSessions?: unknown;
	fetch?: typeof fetch;
}): Promise<AgentSlotLimit> {
	const configured = normalizeParallelSessions(input.parallelSessions);
	if (input.providerId === "opencoti") {
		// One `/props` read answers both, and an unreachable server answers
		// "not elastic" -- the fixed count is the safe reading when the
		// question cannot be asked.
		const props = await probeOpencotiProps(input.baseUrl, input.fetch);
		const elastic = props.poolsEnabled || props.elastic;
		if (elastic) {
			const by = props.poolsEnabled ? "PolyKV admission" : "elastic slots";
			return configured
				? {
						limit: configured,
						reason: `opencoti has ${by} on, but this profile caps delegation at ${configured}`,
					}
				: {
						limit: 0,
						reason: `opencoti has ${by} on; the engine decides, not a slot count`,
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
