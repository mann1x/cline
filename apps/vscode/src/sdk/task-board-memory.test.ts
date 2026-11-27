import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CoreTaskGraphControl, TaskGraphStore } from "@cline/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TaskBoardMemory } from "./task-board-memory"

vi.mock("./library-config", () => ({
	readMemorySettings: () => ({ enabled: memoryEnabled, selections: {} }),
}))

let memoryEnabled = true

interface SavedBoard {
	id: string
	memory: string
	text: string
	board: { sessionId: string; title?: string; keepUpdated: boolean; tasks: number; open: number; events: unknown[] }
}

function fakeMemory() {
	const boards = new Map<string, SavedBoard>()
	let next = 1
	return {
		boards,
		listMemories: () => [{ name: "main" }, { name: "acme" }],
		saveBoard: vi.fn(async (input: { memory?: string; text: string; board: SavedBoard["board"]; replaces?: string }) => {
			const id = input.replaces ?? `m${next++}`
			const saved = { id, memory: input.memory ?? "main", text: input.text, board: input.board }
			boards.set(id, saved)
			return { id, text: input.text, memory: saved.memory, tags: [], createdAt: "" }
		}),
		forget: vi.fn(async (id: string) => boards.delete(id)),
		readBoard: (id: string) => {
			const saved = boards.get(id)
			return saved ? { item: { id }, board: { ...saved.board, savedAt: "", format: "x", version: 1 } } : undefined
		},
	}
}

function control(sessionId: string, tasks = 2): CoreTaskGraphControl {
	return {
		sessionId,
		edit: vi.fn(),
		snapshot: vi.fn(),
		exportBoard: vi.fn(() => ({ events: [{ op: "create" }], text: `board of ${sessionId}`, tasks, open: 1 })),
	} as unknown as CoreTaskGraphControl
}

describe("TaskBoardMemory", () => {
	beforeEach(() => {
		memoryEnabled = true
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("saves the live board into the chosen memory, under the conversation's title", async () => {
		const memory = fakeMemory()
		const boards = new TaskBoardMemory({ memory: () => memory as never, cwd: async () => "/w" })
		boards.beginTask(true, "Fix the ledger")
		boards.attach(control("s1"))
		const lines = await boards.save({ sessionId: "s1", memory: "acme", keepUpdated: false })
		expect(lines[0]).toContain('Saved the board as m1 in "acme"')
		expect(memory.boards.get("m1")).toMatchObject({
			memory: "acme",
			text: "board of s1",
			board: { sessionId: "s1", title: "Fix the ledger", tasks: 2, open: 1, keepUpdated: false },
		})
	})

	it("saves a draft's events as a board tied to no conversation, and deletes a saved board", async () => {
		const memory = fakeMemory()
		const boards = new TaskBoardMemory({ memory: () => memory as never, cwd: async () => "/w" })
		const store = new TaskGraphStore()
		store.plan({ tasks: [{ title: "One" }, { title: "Two" }] }, { by: "person" }, { autoStart: false })
		const lines = await boards.saveEvents({ events: [...store.getEvents()], title: "Draft 2" })
		expect(lines[0]).toContain('Saved the board as m1 in "main" (2 tasks, 2 open)')
		expect(memory.boards.get("m1")?.board).toMatchObject({ title: "Draft 2", tasks: 2, keepUpdated: false })
		expect((await boards.saveEvents({ events: [] }))[0]).toContain("empty")
		expect(await boards.deleteSaved("m1", "main")).toBe(true)
		expect(memory.forget).toHaveBeenCalledWith("m1", { memories: ["main"] })
		expect(memory.boards.has("m1")).toBe(false)
	})

	it("refuses to save with Memory off, or an empty board", async () => {
		const memory = fakeMemory()
		const boards = new TaskBoardMemory({ memory: () => memory as never })
		boards.attach(control("s1", 0))
		// Another conversation with no log has nothing to save.
		expect((await boards.save({ sessionId: "s2", keepUpdated: false }))[0]).toContain("empty")
		expect((await boards.save({ sessionId: "s1", keepUpdated: false }))[0]).toContain("empty")
		memoryEnabled = false
		expect((await boards.save({ sessionId: "s1", keepUpdated: false }))[0]).toContain("Memory is off")
		expect(memory.saveBoard).not.toHaveBeenCalled()
	})

	it("saves the board of a conversation reopened from history, read from its log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "board-log-"))
		try {
			const logPath = join(dir, "old.tasks.jsonl")
			writeFileSync(
				logPath,
				[
					{ seq: 1, ts: 1, by: "model", call: "c1", op: "create", task: { id: "T1", title: "Store cents" } },
					{ seq: 2, ts: 2, by: "model", call: "c1", op: "create", task: { id: "T2", title: "Report" } },
					{ seq: 3, ts: 3, by: "model", call: "c2", op: "update", update: { id: "T1", status: "done" } },
				]
					.map((event) => JSON.stringify(event))
					.join("\n") + "\n",
			)
			const memory = fakeMemory()
			const boards = new TaskBoardMemory({
				memory: () => memory as never,
				logPath: async (id) => (id === "old" ? logPath : undefined),
			})
			boards.attach(control("live"))
			const lines = await boards.save({ sessionId: "old", keepUpdated: false, title: "ledger" })
			expect(lines[0]).toContain("Saved the board as m1")
			const saved = memory.boards.get("m1")
			expect(saved?.board).toMatchObject({ sessionId: "old", title: "ledger", tasks: 2, open: 1 })
			expect(saved?.text).toContain("Task board: ledger")
			expect(saved?.board.events.some((event) => typeof event === "object" && event !== null && "call" in event)).toBe(
				false,
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("starts the next new conversation from a picked board, not a resumed one", () => {
		const boards = new TaskBoardMemory({ memory: () => fakeMemory() as never })
		const seed = {
			events: [{ op: "create" }],
			by: "memory:m3",
			noteId: "m3",
			memory: "main",
			keepUpdated: true,
			about: 'm3, "ledger"',
		}
		boards.use(seed)
		boards.beginTask(false)
		expect(boards.takeSeed()).toBeUndefined()
		boards.beginTask(true)
		expect(boards.takeSeed()).toEqual({ events: seed.events, by: "memory:m3", about: 'm3, "ledger"' })
		// Once.
		expect(boards.takeSeed()).toBeUndefined()
	})

	it("rewrites a kept-updated board a moment after the last change, and only then", async () => {
		const memory = fakeMemory()
		await memory.saveBoard({
			memory: "main",
			text: "old",
			board: { sessionId: "s0", title: "ledger", keepUpdated: true, tasks: 1, open: 1, events: [] },
		})
		const boards = new TaskBoardMemory({ memory: () => memory as never, debounceMs: 100 })
		boards.use({ events: [], by: "memory:m1", noteId: "m1", memory: "main", keepUpdated: true })
		boards.beginTask(true)
		boards.takeSeed()
		boards.attach(control("s7"))
		memory.saveBoard.mockClear()
		boards.changed()
		boards.changed()
		await vi.advanceTimersByTimeAsync(150)
		expect(memory.saveBoard).toHaveBeenCalledTimes(1)
		expect(memory.boards.get("m1")).toMatchObject({
			text: "board of s7",
			board: { sessionId: "s7", title: "ledger", keepUpdated: true, tasks: 2 },
		})
		// Turned off in the Memory panel: left as it is.
		const saved = memory.boards.get("m1") as SavedBoard
		saved.board.keepUpdated = false
		boards.changed()
		await vi.advanceTimersByTimeAsync(150)
		expect(memory.saveBoard).toHaveBeenCalledTimes(1)
	})

	it("a session not tied to a saved board writes nothing", async () => {
		const memory = fakeMemory()
		const boards = new TaskBoardMemory({ memory: () => memory as never, debounceMs: 10 })
		boards.attach(control("s1"))
		boards.changed()
		await vi.advanceTimersByTimeAsync(50)
		expect(memory.saveBoard).not.toHaveBeenCalled()
	})

	it("a draft board from the Board tab says when it is taken, and keeps nothing updated", async () => {
		const memory = fakeMemory()
		const boards = new TaskBoardMemory({ memory: () => memory as never, debounceMs: 10 })
		const onTaken = vi.fn()
		boards.use({ events: [{ op: "create" }], by: "person", keepUpdated: false, onTaken })
		expect(onTaken).not.toHaveBeenCalled()
		boards.beginTask(true)
		expect(boards.takeSeed()).toEqual({ events: [{ op: "create" }], by: "person" })
		expect(onTaken).toHaveBeenCalledTimes(1)
		boards.attach(control("s9"))
		boards.changed()
		await vi.advanceTimersByTimeAsync(50)
		expect(memory.saveBoard).not.toHaveBeenCalled()
	})
})
