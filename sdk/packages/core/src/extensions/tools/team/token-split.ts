/**
 * An input count split into what the provider had cached and what it read
 * fresh. `input` stays the whole prompt, every turn summed: an agent that
 * sends a 30k prefix twenty times shows 600k, nearly all of it cached, and
 * without the split that read as 600k of work (lead report, swarm wlafh).
 *
 * A gateway's input count holds the cached part; a provider that reports the
 * cache apart (more cached than sent) gets it added. `cached` and `fresh` are
 * absent when the provider reported no cache figure.
 */
export function splitInputTokens(
	input: number,
	cached: number | undefined,
): { input: number; cached?: number; fresh?: number } {
	if (cached === undefined) {
		return { input };
	}
	const whole = input >= cached ? input : input + cached;
	return { input: whole, cached, fresh: whole - cached };
}

/** Usage as an agent's result states it to the lead. */
export interface MemberUsage {
	inputTokens: number;
	outputTokens: number;
	/** Of `inputTokens`, what the provider served from its cache. */
	cachedInputTokens?: number;
}

/** A runtime's usage as the lead is told it, the cached part of the input named. */
export function memberUsage(
	usage:
		| {
				inputTokens?: number;
				outputTokens?: number;
				cacheReadTokens?: number;
		  }
		| undefined,
): MemberUsage {
	const split = splitInputTokens(
		usage?.inputTokens ?? 0,
		usage?.cacheReadTokens,
	);
	return {
		inputTokens: split.input,
		outputTokens: usage?.outputTokens ?? 0,
		...(split.cached !== undefined ? { cachedInputTokens: split.cached } : {}),
	};
}
