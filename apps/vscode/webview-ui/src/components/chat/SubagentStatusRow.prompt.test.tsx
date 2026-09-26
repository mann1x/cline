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

describe("a sub-agent spawned with a sampler", () => {
	const withSampling = (sampling: Record<string, unknown>) =>
		({
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
						prompt: "probe",
						status: "running",
						sampling,
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
		}) as ClineMessage

	it("shows its seed and temperature, with how they were drawn in the tooltip", () => {
		const message = withSampling({
			seed: 2847193,
			seedRandom: true,
			temperature: 0.713,
			temperatureBase: 0.7,
			temperatureRange: 2,
		})
		render(<SubagentStatusRow isLast={true} lastModifiedMessage={message} message={message} />)
		const line = screen.getByText("seed 2847193 · T 0.713")
		expect(line.getAttribute("title")).toBe("Seed 2847193 (random)\nTemperature 0.713 (random: 0.7 ± 2%)")
	})

	it("says the model's temperature stood when it could not be randomized", () => {
		const message = withSampling({
			temperatureRange: 2,
			note: "model temperature unknown; kept the model's sampler",
		})
		render(<SubagentStatusRow isLast={true} lastModifiedMessage={message} message={message} />)
		const line = screen.getByText("T model")
		expect(line.getAttribute("title")).toBe("Temperature: model temperature unknown; kept the model's sampler")
	})
})

describe("a sub-agent's row and the lead's controls", () => {
	const row = (overrides: Record<string, unknown>) =>
		({
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
						agentName: "fixer",
						prompt: "fix it",
						status: "running",
						toolCalls: 0,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						contextTokens: 0,
						contextWindow: 0,
						contextUsagePercentage: 0,
						...overrides,
					},
				],
			}),
		}) as ClineMessage

	it("says it is awaiting the lead at its iteration cap", () => {
		render(
			<SubagentStatusRow
				isLast={true}
				lastModifiedMessage={undefined}
				message={row({ maxIterations: 4, awaitingLead: { iterations: 4, maxIterations: 4 } })}
			/>,
		)
		expect(screen.getByText("awaiting lead (iteration cap 4)")).toBeTruthy()
	})

	it("shows the check's verdict, with its output in the tooltip", () => {
		render(
			<SubagentStatusRow
				isLast={true}
				lastModifiedMessage={undefined}
				message={row({
					status: "completed",
					result: "done",
					oracle: { status: "fail", command: "node t.js", expect: "ok", exitCode: 1, output: "TypeError: x", runs: 3 },
				})}
			/>,
		)
		const verdict = screen.getByText("check: FAIL (exit 1)")
		expect(verdict.getAttribute("title")).toContain("TypeError: x")
	})
})
