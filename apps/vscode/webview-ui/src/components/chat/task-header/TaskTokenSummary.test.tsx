import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { TaskTokenSummary } from "./TaskTokenSummary"

const base = {
	tokensIn: 255_600,
	tokensOut: 14_800,
	generateTokens: 14_800,
	generateMs: 171_800,
	byProvider: [],
}

describe("TaskTokenSummary", () => {
	// The expert is usually the metered model, and it is the one figure a paid
	// account actually needs. Beside the session's own on the same line, so the
	// comparison is there without an interaction.
	it("shows what the expert spent, labelled, when a task escalated", () => {
		render(
			<TaskTokenSummary
				{...base}
				expert={{
					tokensIn: 454_300,
					tokensOut: 24_300,
					generateTokens: 24_300,
					generateMs: 927_500,
					wallMs: 1_000_000,
					requests: 3,
				}}
			/>,
		)

		expect(screen.getByText(/Expert/)).toBeTruthy()
		expect(screen.getByText("↑ 454.3k")).toBeTruthy()
		expect(screen.getByText("↓ 24.3k")).toBeTruthy()
		// 24,300 tokens in 927.5s is 26.2/s, by the provider's own clock.
		expect(screen.getByText("26.2 tok/s")).toBeTruthy()
	})

	// A task that never escalated must look exactly as it did before this
	// feature existed: no label, no zeroes, no reserved space.
	it("says nothing about an expert that was never called", () => {
		render(<TaskTokenSummary {...base} />)

		expect(screen.queryByText(/Expert/)).toBeNull()
	})

	// Tokens with no provider timings behind them. A rate of zero would read as
	// a very slow model rather than as one nobody timed, which is the same rule
	// the session's own figure already follows.
	it("shows the expert's tokens without a rate when nothing timed it", () => {
		render(
			<TaskTokenSummary
				{...base}
				expert={{
					tokensIn: 40_000,
					tokensOut: 2_000,
					generateTokens: 0,
					generateMs: 0,
					wallMs: 95_000,
					requests: 1,
				}}
			/>,
		)

		expect(screen.getByText("↑ 40.0k")).toBeTruthy()
		expect(screen.queryByText(/0.0 tok\/s/)).toBeNull()
	})
})

describe("the connection breakdown behind the header count", () => {
	const twoConnections = [
		{
			providerId: "ollama",
			modelId: "gemma4:31b",
			tokensIn: 200_000,
			tokensOut: 10_000,
			cacheWrites: 0,
			cacheReads: 0,
			cost: 0,
			generateTokens: 10_000,
			generateMs: 100_000,
			requests: 42,
			agents: 0,
		},
		{
			providerId: "ollama",
			modelId: "gemma4:31b",
			source: "subagents" as const,
			tokensIn: 55_600,
			tokensOut: 4_800,
			cacheWrites: 0,
			cacheReads: 0,
			cost: 0,
			generateTokens: 4_800,
			generateMs: 71_800,
			requests: 0,
			agents: 3,
		},
	]

	// Collapsed is the ordinary state; the split is worth an interaction, not a
	// permanent three lines under every task header.
	it("says how many connections there were and shows nothing else until asked", () => {
		render(<TaskTokenSummary {...base} byProvider={twoConnections} />)

		expect(screen.getByRole("button", { name: /2 connections/ })).toBeTruthy()
		expect(screen.queryByText("sub-agents")).toBeNull()
	})

	// The reported ask: identify which connection it was, and what for. Both
	// rows are the same provider and the same model here -- which is the case
	// that used to collapse into one -- so the role is the only thing telling
	// them apart.
	it("identifies each connection and what it was used for", async () => {
		const { default: userEvent } = await import("@testing-library/user-event")
		render(<TaskTokenSummary {...base} byProvider={twoConnections} />)

		await userEvent.click(screen.getByRole("button", { name: /2 connections/ }))

		expect(screen.getAllByText("ollama · gemma4:31b")).toHaveLength(2)
		expect(screen.getByText("main")).toBeTruthy()
		expect(screen.getByText("sub-agents")).toBeTruthy()
		expect(screen.getByText("42 requests")).toBeTruthy()
		expect(screen.getByText("3 agents")).toBeTruthy()
	})

	// One connection is the ordinary task, and a disclosure over a single row
	// would be a control that reveals what the line above it already said.
	it("offers no disclosure when the task ran on one connection", () => {
		render(<TaskTokenSummary {...base} byProvider={[twoConnections[0]]} />)

		expect(screen.queryByRole("button")).toBeNull()
	})
})
