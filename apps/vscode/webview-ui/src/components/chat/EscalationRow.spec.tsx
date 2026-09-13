import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import EscalationRow from "./EscalationRow"

function row(info: Record<string, unknown>): ClineMessage {
	return { ts: 1, type: "say", say: "escalation", text: JSON.stringify(info) } as ClineMessage
}

describe("EscalationRow", () => {
	// The hand-over is a fact about the run, and the brief is long. Named on one
	// line, readable on demand -- a user paying for the expert is entitled to
	// see exactly what it was asked, but not to have it pushed into the middle
	// of the transcript every time.
	it("names the hand-over and keeps the brief behind a disclosure", () => {
		render(
			<EscalationRow
				message={row({
					phase: "started",
					index: 1,
					of: 3,
					text: "== ESCALATION ==\n\nfix the collision check",
				})}
			/>,
		)

		expect(screen.getByText(/Escalation 1 of 3/)).toBeTruthy()
		expect(screen.queryByText(/fix the collision check/)).toBeNull()

		fireEvent.click(screen.getByRole("button"))
		expect(screen.getByText(/fix the collision check/)).toBeTruthy()
	})

	// The delivery is the opposite: it is the thing the user opened the chat to
	// read, and the base model is about to act on it.
	it("shows the expert's delivery without an interaction", () => {
		render(
			<EscalationRow
				message={row({
					phase: "reply",
					text: "I clamped the row index in step().",
				})}
			/>,
		)

		expect(screen.getByText(/I clamped the row index/)).toBeTruthy()
	})

	// Which files a second model changed under you is not a detail. Every read
	// the base model had of them is stale, and so is anything the user had open.
	it("names the files the expert changed", () => {
		render(
			<EscalationRow
				message={row({
					phase: "reply",
					text: "done",
					changed: ["src/game.js", "src/board.js"],
				})}
			/>,
		)

		expect(screen.getByText(/src\/game\.js/)).toBeTruthy()
		expect(screen.getByText(/src\/board\.js/)).toBeTruthy()
	})

	// The cost, where it happened. The header carries the task's total; this is
	// what this one delivery spent, which is the number that explains a total
	// that has moved.
	it("says what the delivery cost", () => {
		render(
			<EscalationRow
				message={row({
					phase: "reply",
					text: "done",
					usage: {
						tokensIn: 40_000,
						tokensOut: 2_000,
						generateTokens: 2_000,
						generateMs: 80_000,
						wallMs: 95_000,
						requests: 1,
					},
				})}
			/>,
		)

		expect(screen.getByText(/↑ 40.0k/)).toBeTruthy()
		expect(screen.getByText(/↓ 2.0k/)).toBeTruthy()
	})

	it("says whether the expert was held or released", () => {
		render(<EscalationRow message={row({ phase: "ended", text: "on hold", held: true })} />)

		expect(screen.getByText(/on hold/)).toBeTruthy()
	})

	// Virtuoso cannot measure a zero-height item, so a payload this row cannot
	// read still has to render something.
	it("renders a spacer for a payload it cannot read", () => {
		const { container } = render(
			<EscalationRow message={{ ts: 1, type: "say", say: "escalation", text: "{" } as ClineMessage} />,
		)

		expect(container.querySelector("[aria-hidden]")).toBeTruthy()
	})
})
