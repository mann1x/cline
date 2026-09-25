import type { ClineMessage, SubagentStatusItem } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import SubagentStatusRow, { subagentStatsText, teammateStatsText } from "./SubagentStatusRow"
import { subagentCompactionDetail } from "./subagentCompactions"

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
	// pandorum 2026-09-24: "7 tools called · 0 tokens" on every agent, running
	// or finished. A finished report carries what it spent and no context.
	it("counts what the agent spent when no context size was reported", () => {
		expect(subagentStatsText(entry({ toolCalls: 7, inputTokens: 40_000, outputTokens: 1_200 }))).toBe(
			"7 tools called · 41,200 tokens",
		)
	})

	it("does not round a real price down to nothing", () => {
		expect(subagentStatsText(entry({ totalCost: 0.0004 }))).toContain("$0.0004")
	})
})

/**
 * Every agent given a 64k window, to see which of them compact: the count sits
 * beside the tool count, and why each ran is in its tooltip.
 */
describe("how many times a sub-agent compacted", () => {
	const compacted = {
		compactions: 3,
		compactionsByCause: { auto: 1, pressure: 2 },
		lastCompaction: { cause: "pressure" as const, tokensBefore: 60_000, tokensAfter: 21_000 },
	}

	it("is said beside the tool count once it has compacted", () => {
		expect(subagentStatsText(entry({ toolCalls: 7, contextTokens: 12_000, compactions: 1 }))).toBe(
			"7 tools called · 1 compaction · 12,000 tokens",
		)
		expect(subagentStatsText(entry({ toolCalls: 7, contextTokens: 12_000, ...compacted }))).toBe(
			"7 tools called · 3 compactions · 12,000 tokens",
		)
	})

	it("is not said at all by an agent that never compacted", () => {
		expect(subagentStatsText(entry({ toolCalls: 7, contextTokens: 12_000, compactions: 0 }))).toBe(
			"7 tools called · 12,000 tokens",
		)
	})

	it("is broken down by cause, with the last one's before and after", () => {
		expect(subagentCompactionDetail(compacted)).toBe(
			"Compactions: 1 × own context threshold, 2 × server KV pressure\nLast: server KV pressure, 60,000 → 21,000 tokens",
		)
		expect(subagentCompactionDetail({ compactions: 0 })).toBe("")
	})

	// The row is rendered from the saved say:"subagent" message, so a task
	// reopened from history shows what the live row showed.
	it("is on the row rendered from a saved status message", () => {
		const saved = JSON.parse(
			JSON.stringify({
				ts: 1,
				type: "say",
				say: "subagent",
				text: JSON.stringify({
					status: "completed",
					total: 1,
					completed: 1,
					successes: 1,
					failures: 0,
					toolCalls: 7,
					compactions: 3,
					inputTokens: 0,
					outputTokens: 0,
					contextWindow: 0,
					maxContextTokens: 0,
					maxContextUsagePercentage: 0,
					items: [entry({ toolCalls: 7, contextTokens: 12_000, ...compacted })],
				}),
			}),
		) as ClineMessage
		render(<SubagentStatusRow isLast={false} message={saved} />)
		const stats = screen.getByText("7 tools called · 3 compactions · 12,000 tokens")
		expect(stats.getAttribute("title")).toContain("2 × server KV pressure")
	})
})

/**
 * Teammates get the same counts as sub-agents: over the teammate's life on its
 * row, and on the task it is running beneath.
 */
describe("a teammate's row", () => {
	const teammate = entry({
		index: 1001,
		agentName: "helper",
		prompt: "reviews code",
		status: "running",
		toolCalls: 12,
		compactions: 2,
		compactionsByCause: { auto: 1, pressure: 1 },
		lastTask: { toolCalls: 3, compactions: 1, compactionsByCause: { pressure: 1 } },
	})
	const teamRow = (items: SubagentStatusItem[]) =>
		({
			ts: 5,
			type: "say",
			say: "subagent",
			partial: true,
			text: JSON.stringify({ kind: "team", status: "running", total: items.length, items }),
		}) as ClineMessage

	it("counts its whole life, and its current task apart", () => {
		expect(teammateStatsText(teammate)).toEqual({
			life: "12 tools called · 2 compactions",
			task: "This task: 3 tools called · 1 compaction",
		})
		expect(teammateStatsText(entry({ toolCalls: 0 }))).toEqual({ life: "0 tools called", task: "" })
	})

	it("is drawn as the teammates, with both counts and their causes", () => {
		render(<SubagentStatusRow isLast={true} message={teamRow([teammate])} />)
		expect(screen.getByText("Teammate:")).toBeInTheDocument()
		expect(screen.getByText("12 tools called · 2 compactions").getAttribute("title")).toContain(
			"1 × own context threshold, 1 × server KV pressure",
		)
		expect(screen.getByText("This task: 3 tools called · 1 compaction").getAttribute("title")).toContain(
			"1 × server KV pressure",
		)
	})

	// A teammate works on while the lead talks: its row is not cancelled for
	// no longer being the last message.
	it("is still running when the conversation has moved past it", () => {
		const { container } = render(<SubagentStatusRow isLast={false} message={teamRow([teammate])} />)
		expect(container.querySelector(".animate-spin")).not.toBeNull()
	})
})
