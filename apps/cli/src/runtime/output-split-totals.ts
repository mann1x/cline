/**
 * A run's output by channel, summed from its usage events, for `run_result`.
 *
 * Each request's `usage` event carries its own split (see `OutputTokenSplit`).
 * Usage spent outside the agent's own stream -- a compaction's calls -- has
 * none, and is counted as `unsplitTokens` so the four numbers still add up to
 * every output token the events reported.
 */

import type { AgentEvent } from "@cline/core";

type UsageEvent = Extract<AgentEvent, { type: "usage" }>;

export interface OutputSplitTotals {
	reasoningTokens: number;
	textTokens: number;
	toolInputTokens: number;
	unsplitTokens: number;
	/** How many requests were split each way. */
	methods: Partial<
		Record<"provider" | "stream-chunks" | "chars-share", number>
	>;
}

export function createOutputSplitTotals(): OutputSplitTotals {
	return {
		reasoningTokens: 0,
		textTokens: 0,
		toolInputTokens: 0,
		unsplitTokens: 0,
		methods: {},
	};
}

export function addUsageToOutputSplit(
	totals: OutputSplitTotals,
	event: UsageEvent,
): void {
	const split = event.outputSplit;
	if (!split) {
		totals.unsplitTokens += Math.max(0, event.outputTokens);
		return;
	}
	totals.reasoningTokens += split.reasoningTokens;
	totals.textTokens += split.textTokens;
	totals.toolInputTokens += split.toolInputTokens;
	totals.methods[split.method] = (totals.methods[split.method] ?? 0) + 1;
}
