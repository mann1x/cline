import type { SubagentStatusItem } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { subagentStatsText } from "./SubagentStatusRow"

/**
 * "1 tools called · 0 tokens · $0.00" — the price was on every row of every
 * run, and on a local endpoint it is always that. Three characters of signal
 * and eight of noise, repeated per agent.
 */
function entry(overrides: Partial<SubagentStatusItem>): SubagentStatusItem {
	return {
		index: 1,
		prompt: "do the thing",
		status: "completed",
		toolCalls: 1,
		inputTokens: 0,
		outputTokens: 0,
		totalCost: 0,
		contextTokens: 0,
		contextWindow: 0,
		contextUsagePercentage: 0,
		...overrides,
	}
}

describe("what a finished sub-agent reports", () => {
	it("says nothing about a price that is zero", () => {
		expect(subagentStatsText(entry({ toolCalls: 1, contextTokens: 0, totalCost: 0 }))).toBe("1 tools called · 0 tokens")
	})

	it("still says what a run cost when it cost something", () => {
		expect(subagentStatsText(entry({ toolCalls: 4, contextTokens: 12_000, totalCost: 0.0312 }))).toBe(
			"4 tools called · 12,000 tokens · $0.03",
		)
	})

	// Below a cent it is four places, or every small paid run reads as free --
	// which is the thing this change must not start doing.
	it("does not round a real price down to nothing", () => {
		expect(subagentStatsText(entry({ totalCost: 0.0004 }))).toContain("$0.0004")
	})
})
