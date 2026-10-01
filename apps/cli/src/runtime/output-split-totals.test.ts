import { describe, expect, it } from "vitest";
import {
	addUsageToOutputSplit,
	createOutputSplitTotals,
} from "./output-split-totals";

const usage = (outputTokens: number, outputSplit?: object) =>
	({
		type: "usage",
		inputTokens: 0,
		outputTokens,
		totalInputTokens: 0,
		totalOutputTokens: 0,
		...(outputSplit ? { outputSplit } : {}),
	}) as Parameters<typeof addUsageToOutputSplit>[1];

describe("output split totals", () => {
	it("sums each request's split and counts unsplit usage apart", () => {
		const totals = createOutputSplitTotals();
		addUsageToOutputSplit(
			totals,
			usage(100, {
				reasoningTokens: 80,
				textTokens: 5,
				toolInputTokens: 15,
				method: "stream-chunks",
			}),
		);
		addUsageToOutputSplit(
			totals,
			usage(50, {
				reasoningTokens: 40,
				textTokens: 10,
				toolInputTokens: 0,
				method: "stream-chunks",
			}),
		);
		// A compaction's call: output with no stream of the agent's own.
		addUsageToOutputSplit(totals, usage(30));
		expect(totals).toEqual({
			reasoningTokens: 120,
			textTokens: 15,
			toolInputTokens: 15,
			unsplitTokens: 30,
			methods: { "stream-chunks": 2 },
		});
	});
});
