import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import ThinkingCondensedRow from "./ThinkingCondensedRow"

/**
 * The note is the only surviving account of what a capped turn concluded — the
 * reasoning it replaces is never sent again — so if this row does not show it,
 * nothing does.
 */
function condensedMessage(info: Record<string, unknown>): ClineMessage {
	return {
		ts: 1,
		type: "say",
		say: "thinking_condensed",
		text: JSON.stringify({
			note: "## Settled\nThe parse error is in dPw, not dEn.",
			thinkingChars: 43_000,
			noteChars: 620,
			budgetTokens: 16_000,
			...info,
		}),
	} as ClineMessage
}

describe("ThinkingCondensedRow", () => {
	it("reads as a divider until it is asked for", () => {
		render(<ThinkingCondensedRow message={condensedMessage({})} />)

		expect(screen.getByText(/Thinking budget spent/)).toBeTruthy()
		expect(screen.getByText(/43k → 620 chars/)).toBeTruthy()
		expect(screen.queryByText(/dPw, not dEn/)).toBeNull()
	})

	it("shows the note on demand", () => {
		render(<ThinkingCondensedRow message={condensedMessage({})} />)

		fireEvent.click(screen.getByText(/Thinking budget spent/))

		expect(screen.getByText(/dPw, not dEn/)).toBeTruthy()
	})

	it("still reads as a divider when the sizes are missing", () => {
		render(<ThinkingCondensedRow message={condensedMessage({ thinkingChars: undefined, noteChars: undefined })} />)

		expect(screen.getByText("Thinking budget spent · reasoning condensed")).toBeTruthy()
	})

	it("renders nothing readable for a payload it cannot parse", () => {
		const { container } = render(
			<ThinkingCondensedRow message={{ ts: 1, type: "say", say: "thinking_condensed", text: "{" } as ClineMessage} />,
		)

		expect(container.textContent).toBe("")
	})
})
