/**
 * How fast each node produces tokens, measured from what its agents report.
 *
 * For the lead's `agents_status`: an ETA needs a rate, and a rate the lead
 * can judge needs two -- the last five minutes and the node's own history in
 * this process. When they agree the ETA can be trusted; when the recent one
 * has fallen far below the historical one, something on the node changed (a
 * compaction wave, a prefill storm, another client) and the ETA says so.
 *
 * Measured here rather than asked of a server so it works for every provider:
 * an agent's output-token count rises as it works, whoever serves it. Time
 * is counted in active minutes -- minutes in which the node produced
 * anything -- so an idle hour between rounds does not halve the history.
 */

/** The window the recent rate covers. */
export const RECENT_WINDOW_MS = 5 * 60_000;
const BUCKET_MS = 60_000;
/** Active minutes of history below which no rate is called reliable. */
const MIN_ACTIVE_MINUTES = 3;

interface NodeRecord {
	/** Tokens per minute, keyed by the minute's index since the epoch. */
	buckets: Map<number, number>;
	total: number;
}

const NODES = new Map<string, NodeRecord>();

export type RateReliability = "high" | "medium" | "low" | "too early";

export interface NodeRate {
	/** Tokens per second over the active part of the last five minutes. */
	recentTps?: number;
	/** Tokens per second over every active minute so far. */
	historicalTps?: number;
	activeMinutes: number;
	reliability: RateReliability;
}

/** The key an agent's tokens are counted under: its node, or its model. */
export function nodeKeyOf(agent: {
	nodeId?: string;
	providerId?: string;
	modelId?: string;
}): string {
	return agent.nodeId ?? `${agent.providerId ?? "?"}/${agent.modelId ?? "?"}`;
}

export function noteNodeTokens(key: string, tokens: number, at: number): void {
	if (!(tokens > 0) || !Number.isFinite(tokens)) {
		return;
	}
	let record = NODES.get(key);
	if (!record) {
		record = { buckets: new Map(), total: 0 };
		NODES.set(key, record);
	}
	const minute = Math.floor(at / BUCKET_MS);
	record.buckets.set(minute, (record.buckets.get(minute) ?? 0) + tokens);
	record.total += tokens;
}

/** Seconds a bucket covers: a whole minute, or the part of the current one gone by. */
function bucketSeconds(minute: number, now: number): number {
	const start = minute * BUCKET_MS;
	return Math.max(1, Math.min(BUCKET_MS, now - start)) / 1000;
}

/**
 * Whether two rates agree well enough to trust an ETA drawn from them. The
 * recent rate is the one used; the historical one is the check on it.
 */
export function rateReliability(
	recent: number | undefined,
	historical: number | undefined,
	activeMinutes: number,
): RateReliability {
	if (
		recent === undefined ||
		historical === undefined ||
		historical <= 0 ||
		activeMinutes < MIN_ACTIVE_MINUTES
	) {
		return "too early";
	}
	const drift = Math.abs(recent / historical - 1);
	if (drift <= 0.2 && activeMinutes >= 10) {
		return "high";
	}
	return drift <= 0.4 ? "medium" : "low";
}

export function nodeRate(key: string, now: number): NodeRate | undefined {
	const record = NODES.get(key);
	if (!record || record.buckets.size === 0) {
		return undefined;
	}
	const since = Math.floor((now - RECENT_WINDOW_MS) / BUCKET_MS);
	let recentTokens = 0;
	let recentSeconds = 0;
	let allSeconds = 0;
	for (const [minute, tokens] of record.buckets) {
		const seconds = bucketSeconds(minute, now);
		allSeconds += seconds;
		if (minute > since) {
			recentTokens += tokens;
			recentSeconds += seconds;
		}
	}
	const round = (value: number) => Math.round(value * 10) / 10;
	const recentTps =
		recentSeconds > 0 ? round(recentTokens / recentSeconds) : undefined;
	const historicalTps =
		allSeconds > 0 ? round(record.total / allSeconds) : undefined;
	return {
		...(recentTps !== undefined ? { recentTps } : {}),
		...(historicalTps !== undefined ? { historicalTps } : {}),
		activeMinutes: record.buckets.size,
		reliability: rateReliability(recentTps, historicalTps, record.buckets.size),
	};
}

/** Test seam. */
export function __resetNodeThroughput(): void {
	NODES.clear();
}
