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
