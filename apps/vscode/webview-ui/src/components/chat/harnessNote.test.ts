import { describe, expect, it } from "vitest"
import { HARNESS_NOTE_PREFIX, readHarnessNote } from "./harnessNote"

const note = (body: string) => `${HARNESS_NOTE_PREFIX}\n\n${body}`

describe("readHarnessNote", () => {
	it("is nothing for a row that is not a harness note", () => {
		expect(readHarnessNote("Context compacted.")).toBeUndefined()
		expect(readHarnessNote(undefined)).toBeUndefined()
	})

	it("shows a one-line note whole, with nothing to unfold", () => {
		expect(readHarnessNote(note("[SYSTEM MESSAGE] r1-3 looping; waiting for you."))).toEqual({
			headline: "r1-3 looping; waiting for you.",
		})
	})

	it("folds a round's report behind a headline that says how it ended", () => {
		// pandorum pecyh r1: 16,000 characters of JSON, shown whole in the chat.
		const report = {
			round: "r1",
			summary: { total: 15, completed: 3, errored: 0, cancelled: 12, awaitingLead: 0 },
			agents: [],
			reports: [{ name: "a", text: "x" }],
		}
		const read = readHarnessNote(
			note(`[SYSTEM MESSAGE] Round r1 finished (background spawn_agent). Report:\n\n${JSON.stringify(report)}`),
		)
		expect(read?.headline).toBe("Round r1 finished (background spawn_agent): 15 agents, 3 completed, 12 cancelled")
		expect(read?.detail).toBe(JSON.stringify(report, null, 2))
	})

	it("counts errored and waiting agents when there are any", () => {
		const report = { summary: { total: 4, completed: 1, errored: 2, cancelled: 0, awaitingLead: 1 } }
		expect(
			readHarnessNote(note(`[SYSTEM MESSAGE] Round r2 finished (x). Report:\n\n${JSON.stringify(report)}`))?.headline,
		).toBe("Round r2 finished (x): 4 agents, 1 completed, 2 errored, 1 waiting for the lead")
	})

	it("folds a long note that is not a report after its first line", () => {
		const read = readHarnessNote(note("[SYSTEM MESSAGE] Two agents are stuck.\nr1-1 waiting 300s\nr1-2 waiting 280s"))
		expect(read).toEqual({
			headline: "Two agents are stuck.",
			detail: "r1-1 waiting 300s\nr1-2 waiting 280s",
		})
	})
})
