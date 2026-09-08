import type { ClineMessage } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import TransactionRow from "./TransactionRow"

function row(info: Record<string, unknown>): ClineMessage {
	return { ts: 1, type: "say", say: "transaction", text: JSON.stringify(info) } as ClineMessage
}

describe("TransactionRow", () => {
	it("says a kept transaction was kept", () => {
		render(<TransactionRow message={row({ transaction: 2, kept: true, message: "TX-02 kept — the check passed." })} />)

		expect(screen.getByText(/TX-02 kept/)).toBeTruthy()
	})

	// The count is the part that appears nowhere else. The model's own account
	// of the edits is still on screen above this row, describing changes that no
	// longer exist on disk.
	it("says how many files a discarded transaction put back", () => {
		render(
			<TransactionRow
				message={row({
					transaction: 1,
					kept: false,
					message: "TX-01 discarded — the check failed (exit 1).",
					filesPutBack: 3,
				})}
			/>,
		)

		expect(screen.getByText(/3 files put back/)).toBeTruthy()
	})

	// Opened by default, unlike a kept one: the failures are what you need to
	// read, and in a run that finishes they are the minority.
	it("shows a failed check's output without being asked", () => {
		render(
			<TransactionRow
				message={row({
					transaction: 1,
					kept: false,
					message: "TX-01 discarded.",
					output: "TypeError: y is not a function",
				})}
			/>,
		)

		expect(screen.getByText(/TypeError: y is not a function/)).toBeTruthy()
	})

	it("keeps a kept transaction's output folded away", () => {
		render(<TransactionRow message={row({ transaction: 1, kept: true, message: "TX-01 kept.", output: "all good" })} />)

		expect(screen.queryByText("all good")).toBeNull()
	})

	// Virtuoso cannot handle zero-height items, so a malformed payload has to
	// render something rather than nothing.
	it("renders a spacer for a payload it cannot read", () => {
		const { container } = render(
			<TransactionRow message={{ ts: 1, type: "say", say: "transaction", text: "{" } as ClineMessage} />,
		)

		expect(container.querySelector("[aria-hidden]")).toBeTruthy()
	})
})
