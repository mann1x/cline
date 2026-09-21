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

	// The tester could not tell whether the ledger was being written at all:
	// "the ledger additions at compaction (which i can only guess are there
	// cause they are not in the summary displayed in the chat panel)". It was
	// on the wire and in the transcript, and nowhere a reader could reach.
	it("shows the tool ledger it was sending all along", () => {
		render(
			<CompactionRow
				message={compactionMessage({
					summary: "what the task has done so far",
					toolLedger: "- read_files(manic_miner.html) -> ok @r3",
				})}
			/>,
		)

		expect(screen.getByText("Tool ledger")).toBeTruthy()
		fireEvent.click(screen.getByText("Tool ledger"))
		expect(screen.getByText("- read_files(manic_miner.html) -> ok @r3")).toBeTruthy()
	})

	it("offers no ledger row when checkpoints turned it off", () => {
		render(<CompactionRow message={compactionMessage({ summary: "just a summary" })} />)

		expect(screen.queryByText("Tool ledger")).toBeNull()
	})

	it("still reads as a divider for a compaction that is only starting", () => {
		render(<CompactionRow message={compactionMessage({ status: "started" })} />)

		expect(screen.getByText(/Auto compacting context/)).toBeTruthy()
		expect(screen.queryByText("Summary")).toBeNull()
	})

	it("says how far through its calls a running compaction is", () => {
		// One spinner for five sequential model calls reads as a hang. The pair
		// is what separates "working" from "stuck", and it is the only thing on
		// screen that can.
		render(
			<CompactionRow
				message={
					{
						ts: 1,
						type: "say",
						say: "info",
						text: JSON.stringify({
							status: "started",
							mode: "auto",
							step: 2,
							stepTotal: 5,
							stepLabel: "retrospective",
						}),
					} as ClineMessage
				}
			/>,
		)

		expect(screen.getByText(/\(2\/5\)/)).toBeTruthy()
		expect(screen.getByText(/retrospective/)).toBeTruthy()
	})
})
