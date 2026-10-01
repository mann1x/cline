/**
 * How one request's output divides between thinking, answer text and tool-call
 * input. See `OutputTokenSplit` for what each method means.
 */

import type { OutputTokenSplit } from "@cline/shared";

/** What the stream showed of one request, channel by channel. */
export interface OutputChannelTally {
	reasoningDeltas: number;
	reasoningChars: number;
	textDeltas: number;
	textChars: number;
	toolInputChars: number;
}

export function emptyOutputChannelTally(): OutputChannelTally {
	return {
		reasoningDeltas: 0,
		reasoningChars: 0,
		textDeltas: 0,
		textChars: 0,
		toolInputChars: 0,
	};
}

/**
 * A token is about four characters of English and code. A stream whose deltas
 * average more than this is sending several tokens per delta, and counting its
 * deltas would undercount it.
 */
const MAX_CHARS_PER_TOKEN_DELTA = 12;

/** Shares `total` out by `weights`, rounding so the parts still sum to it. */
function shareOut(total: number, weights: number[]): number[] {
	const sum = weights.reduce((a, b) => a + b, 0);
	if (sum <= 0) return weights.map(() => 0);
	const exact = weights.map((w) => (total * w) / sum);
	const parts = exact.map(Math.floor);
	let left = total - parts.reduce((a, b) => a + b, 0);
	const byRemainder = exact
		.map((value, index) => ({ index, rest: value - Math.floor(value) }))
		.sort((a, b) => b.rest - a.rest);
	for (const { index } of byRemainder) {
		if (left <= 0) break;
		parts[index] = (parts[index] ?? 0) + 1;
		left -= 1;
	}
	return parts;
}

export function splitOutputTokens(input: {
	outputTokens: number | undefined;
	/** The provider's own count of reasoning tokens, where it reports one. */
	providerReasoningTokens?: number;
	tally: OutputChannelTally;
}): OutputTokenSplit | undefined {
	const out = Math.floor(input.outputTokens ?? 0);
	if (!(out > 0)) return undefined;
	const { tally } = input;

	const provided = input.providerReasoningTokens ?? 0;
	if (provided > 0) {
		const reasoningTokens = Math.min(out, Math.floor(provided));
		const [textTokens = 0, toolInputTokens = 0] = shareOut(
			out - reasoningTokens,
			tally.textChars + tally.toolInputChars > 0
				? [tally.textChars, tally.toolInputChars]
				: [1, 0],
		);
		return { reasoningTokens, textTokens, toolInputTokens, method: "provider" };
	}

	const deltas = tally.reasoningDeltas + tally.textDeltas;
	const streamedChars = tally.reasoningChars + tally.textChars;
	if (
		deltas > 0 &&
		deltas <= out &&
		streamedChars / deltas <= MAX_CHARS_PER_TOKEN_DELTA
	) {
		return {
			reasoningTokens: tally.reasoningDeltas,
			textTokens: tally.textDeltas,
			toolInputTokens: out - deltas,
			method: "stream-chunks",
		};
	}

	const [reasoningTokens = 0, textTokens = 0, toolInputTokens = 0] = shareOut(
		out,
		streamedChars + tally.toolInputChars > 0
			? [tally.reasoningChars, tally.textChars, tally.toolInputChars]
			: [0, 1, 0],
	);
	return {
		reasoningTokens,
		textTokens,
		toolInputTokens,
		method: "chars-share",
	};
}
