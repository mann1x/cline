import { describe, expect, it } from "vitest";
import { emptyOutputChannelTally, splitOutputTokens } from "./output-split";

const tally = (over: Partial<ReturnType<typeof emptyOutputChannelTally>>) => ({
	...emptyOutputChannelTally(),
	...over,
});

describe("splitOutputTokens", () => {
	it("counts token-sized deltas and gives tool input the rest", () => {
		// An Ollama turn: 900 thinking deltas, 40 of text, and a tool call whose
		// arguments arrived whole.
		expect(
			splitOutputTokens({
				outputTokens: 1_000,
				tally: tally({
					reasoningDeltas: 900,
					reasoningChars: 3_600,
					textDeltas: 40,
					textChars: 160,
					toolInputChars: 240,
				}),
			}),
		).toEqual({
			reasoningTokens: 900,
			textTokens: 40,
			toolInputTokens: 60,
			method: "stream-chunks",
		});
	});

	it("shares out by characters when the deltas carry several tokens each", () => {
		const split = splitOutputTokens({
			outputTokens: 1_000,
			tally: tally({
				reasoningDeltas: 20,
				reasoningChars: 3_000,
				textDeltas: 5,
				textChars: 500,
				toolInputChars: 500,
			}),
		});
		expect(split).toEqual({
			reasoningTokens: 750,
			textTokens: 125,
			toolInputTokens: 125,
			method: "chars-share",
		});
	});

	it("shares out by characters when there are more deltas than tokens", () => {
		const split = splitOutputTokens({
			outputTokens: 10,
			tally: tally({ reasoningDeltas: 30, reasoningChars: 30 }),
		});
		expect(split?.method).toBe("chars-share");
		expect(split?.reasoningTokens).toBe(10);
	});

	it("takes the provider's reasoning count when it reports one", () => {
		expect(
			splitOutputTokens({
				outputTokens: 1_000,
				providerReasoningTokens: 700,
				tally: tally({ textChars: 100, toolInputChars: 300 }),
			}),
		).toEqual({
			reasoningTokens: 700,
			textTokens: 75,
			toolInputTokens: 225,
			method: "provider",
		});
	});

	it("always sums to the request's output", () => {
		const split = splitOutputTokens({
			outputTokens: 7,
			tally: tally({ reasoningChars: 1, textChars: 1, toolInputChars: 1 }),
		});
		expect(
			(split?.reasoningTokens ?? 0) +
				(split?.textTokens ?? 0) +
				(split?.toolInputTokens ?? 0),
		).toBe(7);
	});

	it("states nothing for a request with no output", () => {
		expect(
			splitOutputTokens({ outputTokens: 0, tally: tally({}) }),
		).toBeUndefined();
	});
});
