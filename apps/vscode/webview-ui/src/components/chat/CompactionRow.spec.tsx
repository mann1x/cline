import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import CompactionRow, { measuredTokensAfterCompaction } from "./CompactionRow"

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

	it("says how long the compaction took", () => {
		// Several sequential model calls, minutes on a local model. The number
		// is how you tell a compaction that cost you a coffee from one that did
		// not, and it was only ever in telemetry.
		render(<CompactionRow message={compactionMessage({ durationMs: 452_000 })} />)

		expect(screen.getByText(/\(7m32s\)/)).toBeTruthy()
	})

	describe("the figure after the arrow", () => {
		const row = (ts: number, info: Record<string, unknown> = {}): ClineMessage =>
			({
				...compactionMessage({ tokensBefore: 48_900, tokensAfter: 39_900, ...info }),
				ts,
				say: "compaction",
			}) as ClineMessage
		const request = (ts: number, usage: Record<string, number>): ClineMessage =>
			({ ts, type: "say", say: "api_req_started", text: JSON.stringify(usage) }) as ClineMessage

		it("is the estimate, said as one, until a request has run", () => {
			render(<CompactionRow message={row(10)} />)
			expect(screen.getByText(/48\.9k → about 39\.9k tokens/)).toBeTruthy()
		})

		it("is the server's count once the next request has one", () => {
			render(<CompactionRow measuredAfter={28_298} message={row(10)} />)
			expect(screen.getByText(/48\.9k → 28\.3k tokens/)).toBeTruthy()
			expect(screen.queryByText(/about/)).toBeNull()
		})

		it("reads the first counted request after the row", () => {
			const messages = [
				request(5, { tokensIn: 48_914, tokensOut: 36_539 }),
				row(10),
				request(11, {}),
				request(12, { tokensIn: 20_000, cacheReads: 8_298, tokensOut: 256 }),
				request(13, { tokensIn: 34_400 }),
			]
			expect(measuredTokensAfterCompaction(messages, 10)).toBe(28_298)
		})

		it("has none while no request has been counted, or once another compaction came first", () => {
			expect(measuredTokensAfterCompaction([row(10), request(11, {})], 10)).toBeUndefined()
			expect(measuredTokensAfterCompaction([row(10), row(20), request(21, { tokensIn: 9_000 })], 10)).toBeUndefined()
			expect(measuredTokensAfterCompaction([row(10), row(20), request(21, { tokensIn: 9_000 })], 20)).toBe(9_000)
		})
	})
})
