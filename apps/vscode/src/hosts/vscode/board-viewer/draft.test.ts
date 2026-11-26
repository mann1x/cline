import { describe, expect, it } from "vitest"
import { DraftBoard, type DraftStorage } from "./draft"

/** The Board tab's draft board: built with no conversation open, kept across a reload. */

function memoryStorage(): DraftStorage & { saved: unknown[] | undefined } {
	const storage = {
		saved: undefined as unknown[] | undefined,
		get: () => storage.saved,
		set: (events: unknown[] | undefined) => {
			storage.saved = events
		},
	}
	return storage
}

const tasksOf = (board: DraftBoard) =>
	(
		JSON.parse(board.text() ?? '{"tasks":[]}') as {
			tasks: { id: string; title: string; status: string; gates?: { spec: string }[] }[]
		}
	).tasks

describe("the draft board", () => {
	it("takes the person's tasks and changes, starts nothing, and survives a reload", () => {
		const storage = memoryStorage()
		const board = new DraftBoard(storage)
		expect(board.isEmpty()).toBe(true)
		expect(board.text()).toBeUndefined()

		const added = board.edit({ op: "plan", tasks: [{ title: "Write the README" }] })
		expect(added.ok).toBe(true)
		board.edit({ op: "plan", tasks: [{ title: "Deploy it" }] })
		const gated = board.edit({ op: "update", updates: [{ id: "T2", gate: ["use-pipeline:deploy"], depends: ["T1"] }] })
		expect(gated.ok).toBe(true)
		// No model works on a draft: nothing is started for it.
		expect(tasksOf(board).map((task) => task.status)).toEqual(["pending", "pending"])
		expect(tasksOf(board)[1]?.gates?.map((gate) => gate.spec)).toEqual(["use-pipeline:deploy"])

		const reloaded = new DraftBoard(storage)
		expect(tasksOf(reloaded).map((task) => task.title)).toEqual(["Write the README", "Deploy it"])
		// Replayed as they were (a replay stamps its own time).
		const unstamped = (events: unknown[]) => (events as Record<string, unknown>[]).map(({ ts: _ts, ...event }) => event)
		expect(unstamped(reloaded.events())).toEqual(unstamped(board.events()))

		reloaded.clear()
		expect(reloaded.isEmpty()).toBe(true)
		expect(storage.saved).toBeUndefined()
		expect(new DraftBoard(storage).isEmpty()).toBe(true)
	})

	it("says why a change did not apply", () => {
		const board = new DraftBoard(memoryStorage())
		const missing = board.edit({ op: "update", updates: [{ id: "T9", title: "x" }] })
		expect(missing.ok).toBe(false)
		expect(missing.lines.join(" ")).toContain("T9")
	})
})
