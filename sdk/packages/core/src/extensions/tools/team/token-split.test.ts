import { describe, expect, it } from "vitest";
import { recordAgentFinalSpend, recordAgentSpend } from "./agent-rounds";
import { splitInputTokens } from "./token-split";

describe("splitInputTokens", () => {
	it("says nothing about the cache when the provider reported none", () => {
		expect(splitInputTokens(600, undefined)).toEqual({ input: 600 });
	});

	it("splits a gateway count, which holds the cached part", () => {
		expect(splitInputTokens(600_000, 580_000)).toEqual({
			input: 600_000,
			cached: 580_000,
			fresh: 20_000,
		});
	});

	it("adds a cache that was reported apart from the input", () => {
		expect(splitInputTokens(1_000, 9_000)).toEqual({
			input: 10_000,
			cached: 9_000,
			fresh: 1_000,
		});
	});

	it("keeps a reported zero as a figure", () => {
		expect(splitInputTokens(50, 0)).toEqual({
			input: 50,
			cached: 0,
			fresh: 50,
		});
	});
});

describe("an agent's cached tokens across runtimes", () => {
	it("survives a restarted counter and a final report", () => {
		const agent = {} as Parameters<typeof recordAgentSpend>[0];
		recordAgentSpend(agent, {
			inputTokens: 100,
			outputTokens: 10,
			cachedTokens: 80,
		});
		// A new runtime counts from zero: a report below what was seen.
		recordAgentSpend(agent, {
			inputTokens: 40,
			outputTokens: 4,
			cachedTokens: 30,
		});
		expect(agent.inputTokens).toBe(140);
		expect(agent.cachedTokens).toBe(110);
		recordAgentFinalSpend(agent, {
			inputTokens: 200,
			outputTokens: 20,
			cachedInputTokens: 150,
		});
		expect(agent.inputTokens).toBe(200);
		expect(agent.cachedTokens).toBe(150);
	});

	it("leaves the figure absent when no report carried one", () => {
		const agent = {} as Parameters<typeof recordAgentSpend>[0];
		recordAgentSpend(agent, { inputTokens: 100, outputTokens: 10 });
		expect(agent.cachedTokens).toBeUndefined();
	});

	it("sums the pool share over runtimes and keeps it through the finish", () => {
		const agent = {} as Parameters<typeof recordAgentSpend>[0];
		recordAgentSpend(agent, { poolSharedTokens: 5_000 });
		recordAgentSpend(agent, { poolSharedTokens: 10_000 });
		// A new runtime's tally starts again.
		recordAgentSpend(agent, { poolSharedTokens: 5_000 });
		expect(agent.poolSharedTokens).toBe(15_000);
		recordAgentFinalSpend(agent, { inputTokens: 40_000, outputTokens: 10 });
		expect(agent.poolSharedTokens).toBe(15_000);
	});
});
