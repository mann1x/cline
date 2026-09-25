import { describe, expect, it } from "vitest"
import {
	SUBAGENT_SILENT_MS,
	SUBAGENT_TPS_IDLE_MS,
	subagentActivityKey,
	subagentLivenessAt,
	subagentOutputKey,
} from "./subagentLiveness"

const agent = {
	index: 1,
	prompt: "p",
	status: "running" as const,
	toolCalls: 0,
	inputTokens: 0,
	outputTokens: 0,
	totalCost: 0,
	contextTokens: 0,
	contextWindow: 0,
	contextUsagePercentage: 0,
}

describe("a running sub-agent's liveness (#77)", () => {
	it("keeps the speed current while output arrives, and calls it idle after", () => {
		const seen = { activityAt: 1_000, outputAt: 1_000 }
		expect(subagentLivenessAt(seen, 1_000 + SUBAGENT_TPS_IDLE_MS - 1).tpsIdle).toBe(false)
		expect(subagentLivenessAt(seen, 1_000 + SUBAGENT_TPS_IDLE_MS).tpsIdle).toBe(true)
	})

	it("says nothing about silence until it has lasted, then counts it", () => {
		const seen = { activityAt: 0, outputAt: 0 }
		expect(subagentLivenessAt(seen, SUBAGENT_SILENT_MS - 1).silentForSec).toBeUndefined()
		expect(subagentLivenessAt(seen, 42_500).silentForSec).toBe(42)
	})

	it("treats a tool call or usage as activity but not as output", () => {
		const moved = { ...agent, toolCalls: 1, latestToolCall: "editor" }
		expect(subagentActivityKey(moved)).not.toBe(subagentActivityKey(agent))
		expect(subagentOutputKey(moved)).toBe(subagentOutputKey(agent))
		const writing = { ...agent, latestOutput: "hello", genTps: 20 }
		expect(subagentOutputKey(writing)).not.toBe(subagentOutputKey(agent))
	})
})
