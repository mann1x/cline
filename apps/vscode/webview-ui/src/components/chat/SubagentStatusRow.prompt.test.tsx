import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import SubagentStatusRow from "./SubagentStatusRow"

/**
 * "Show more" opened a long sub-agent prompt and nothing closed it again: the
 * handler only ever set expanded to true. Reported on pandorum 2026-09-23.
 */
describe("a long sub-agent prompt", () => {
	beforeEach(() => {
		// jsdom lays nothing out; say the clamped prompt overflows.
		vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(100)
		vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(20)
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	const message = {
		ts: 1,
		type: "say",
		say: "subagent",
		text: JSON.stringify({
			status: "running",
			total: 1,
			completed: 0,
			items: [
				{
					index: 1,
					prompt: "a long prompt ".repeat(40),
					status: "running",
					toolCalls: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					contextTokens: 0,
					contextWindow: 0,
					contextUsagePercentage: 0,
				},
			],
		}),
	} as ClineMessage

	it("collapses again with Show less after Show more", () => {
		render(<SubagentStatusRow isLast={false} lastModifiedMessage={undefined} message={message} />)
		fireEvent.click(screen.getByRole("button", { name: "Show full subagent prompt" }))
		expect(screen.queryByRole("button", { name: "Show full subagent prompt" })).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Collapse subagent prompt" }))
		expect(screen.queryByRole("button", { name: "Collapse subagent prompt" })).toBeNull()
		expect(screen.getByRole("button", { name: "Show full subagent prompt" })).toBeTruthy()
	})
})

describe("a running sub-agent's row", () => {
	// #78: the row said `on <node> · <model>` only once the agent was done,
	// and never named the provider.
	it("names the provider and model beside the agent while it runs", () => {
		const running = {
			ts: 1,
			type: "say",
			say: "subagent",
			partial: true,
			text: JSON.stringify({
				status: "running",
				total: 1,
				completed: 0,
				items: [
					{
						index: 1,
						agentName: "reviewer",
						prompt: "review it",
						status: "running",
						providerId: "opencoti",
						modelId: "v9-agentic",
						nodeLabel: "Node2",
						toolCalls: 0,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						contextTokens: 0,
						contextWindow: 0,
						contextUsagePercentage: 0,
					},
				],
			}),
		} as ClineMessage
		render(<SubagentStatusRow isLast={true} lastModifiedMessage={running} message={running} />)
		expect(screen.getByText("opencoti/v9-agentic")).toBeTruthy()
		expect(screen.getByText("on Node2")).toBeTruthy()
	})
})
