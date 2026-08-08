import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import CompactionRow from "./CompactionRow"

/**
 * A compaction is the one operation whose output is otherwise unreachable: it
 * replaces the messages it was written from, so if the row does not show it,
 * nothing does.
 */
function compactionMessage(info: Record<string, unknown>): ClineMessage {
	return {
		ts: 1,
		type: "say",
		say: "info",
		text: JSON.stringify({
			status: "completed",
			mode: "auto",
			tokensBefore: 87_000,
			tokensAfter: 37_900,
			messagesBefore: 27,
			messagesAfter: 5,
			...info,
		}),
	} as ClineMessage
}

describe("CompactionRow", () => {
	it("keeps the summaries out of the way until they are asked for", () => {
		render(
			<CompactionRow
				message={compactionMessage({
					summary: "what the task has done so far",
					thinkingSummary: "editing from stale reads cost most of the time",
				})}
			/>,
		)

		expect(screen.getByText(/Context compacted/)).toBeTruthy()
		expect(screen.getByText("Summary")).toBeTruthy()
		expect(screen.getByText("Retrospective")).toBeTruthy()
		expect(screen.queryByText("what the task has done so far")).toBeNull()
	})

	it("opens each one on its own", () => {
		render(
			<CompactionRow
				message={compactionMessage({
					summary: "what the task has done so far",
					thinkingSummary: "editing from stale reads cost most of the time",
				})}
			/>,
		)

		fireEvent.click(screen.getByText("Retrospective"))

		expect(screen.getByText("editing from stale reads cost most of the time")).toBeTruthy()
		expect(screen.queryByText("what the task has done so far")).toBeNull()
	})

	it("offers nothing to expand when the compaction produced no retrospective", () => {
		render(<CompactionRow message={compactionMessage({ summary: "just a summary" })} />)

		expect(screen.getByText("Summary")).toBeTruthy()
		expect(screen.queryByText("Retrospective")).toBeNull()
	})

	it("still reads as a divider for a compaction that is only starting", () => {
		render(<CompactionRow message={compactionMessage({ status: "started" })} />)

		expect(screen.getByText(/Auto compacting context/)).toBeTruthy()
		expect(screen.queryByText("Summary")).toBeNull()
	})
})
