import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { saveTaskTemplate, TASK_TEMPLATE_DIR, TaskGraphStore } from "@cline/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({ window: {}, workspace: {}, Uri: { file: (path: string) => ({ fsPath: path }) } }))

import { type BoardIoDeps, type BoardIoUi, exportBoard, loadBoard, tasksFromBoardFile } from "./board-io"

/**
 * The Board tab's Load and Export (owner, 2026-11-27): a board saved in
 * Memory, a saved plan or a file onto the board shown; the board shown to a
 * file that loads again.
 */

let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "board-io-"))
})
afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

/** A board with an order, a step, a priority, a pipeline it is done by, and some history that does not carry over. */
function sourceBoard(): unknown[] {
	const store = new TaskGraphStore()
	store.plan(
		{
			tasks: [
				{ title: "Design", priority: "H" },
				{ title: "Sketch", parent: "#1" },
				{ title: "Deploy", depends: ["#1"], gate: ["use-pipeline:deploy", "timer:+1h"] },
			],
		},
		{ by: "model" },
	)
	store.update({ updates: [{ id: "T1", status: "done", note: "drawn" }] }, { by: "model" })
	return [...store.getEvents()]
}

/** Picks are labels: the item whose label starts with it. */
function fakeUi(answers: { picks?: string[]; confirm?: string; file?: string; text?: string; inputs?: string[] }) {
	const written: { file: string; text: string }[] = []
	const ui: BoardIoUi = {
		pick: async (items) => {
			const wanted = answers.picks?.shift() ?? ""
			return items.find((item) => item.label.startsWith(wanted))
		},
		input: async () => answers.inputs?.shift(),
		confirm: async () => answers.confirm,
		openFile: async () => answers.file,
		saveFile: async (defaultPath) => answers.file ?? defaultPath,
		readFile: async () => answers.text ?? "",
		writeFile: async (file, text) => {
			written.push({ file, text })
		},
	}
	return { ui, written }
}

function deps(over: Partial<BoardIoDeps> & { ui: BoardIoUi }): BoardIoDeps & { planned: Record<string, unknown>[][] } {
	const planned: Record<string, unknown>[][] = []
	return {
		workspaceRoot: () => root,
		isDraft: () => true,
		events: () => undefined,
		hasTasks: () => false,
		plan: (tasks) => {
			planned.push(tasks)
			return { ok: true, lines: [`Created ${tasks.length}.`] }
		},
		clearDraft: vi.fn(),
		savedBoards: () => [],
		savedBoardEvents: () => undefined,
		...over,
		planned,
	}
}

describe("Load", () => {
	it("adds a saved board's tasks as a fresh plan: order, steps, priority and the pipeline it is done by, not its history", async () => {
		const { ui } = fakeUi({ picks: ["A board saved in Memory", "Release"] })
		const d = deps({
			ui,
			savedBoards: () => [
				{ id: "m7", memory: "main", title: "Release", tasks: 3, open: 2, savedAt: "2026-11-20T10:00:00Z" },
			],
			savedBoardEvents: (id, memory) => (id === "m7" && memory === "main" ? sourceBoard() : undefined),
		})
		const outcome = await loadBoard(d)
		expect(outcome.ok).toBe(true)
		expect(outcome.lines?.[0]).toBe('Loaded 3 tasks from the saved board "Release".')
		expect(d.planned[0]).toEqual([
			{ title: "Design", priority: "H" },
			{ title: "Sketch", parent: "#1" },
			{ title: "Deploy", depends: ["#1"], gate: ["use-pipeline:deploy"] },
		])
	})

	it("fills a saved plan's names, and asks the draft Add or Replace", async () => {
		saveTaskTemplate(join(root, TASK_TEMPLATE_DIR), {
			name: "Ship it",
			tasks: [{ title: "Tag {{version}}" }, { title: "Announce", depends: ["#1"] }],
		})
		const { ui } = fakeUi({ picks: ["A saved plan", "Ship it"], inputs: ["1.2.3"], confirm: "Replace" })
		const d = deps({
			ui,
			hasTasks: () => true,
			savedBoards: () => [{ id: "m1", memory: "main", tasks: 1, open: 1, savedAt: "2026-11-20" }],
		})
		const outcome = await loadBoard(d)
		expect(outcome.ok).toBe(true)
		expect(d.clearDraft).toHaveBeenCalledTimes(1)
		expect(d.planned[0]).toEqual([{ title: "Tag 1.2.3" }, { title: "Announce", depends: ["#1"] }])
	})

	it("loads what Export wrote, and refuses a file with no tasks", async () => {
		const exported = fakeUi({})
		const out = await exportBoard(deps({ ui: exported.ui, events: () => sourceBoard() }))
		expect(out.ok).toBe(true)
		expect(exported.written[0]?.file).toMatch(/board-\d{4}-\d{2}-\d{2}\.json$/)
		const file = JSON.parse(exported.written[0]?.text ?? "{}")
		expect(file).toMatchObject({ format: "cerebriline-board", version: 1 })
		expect(file.events).toHaveLength(sourceBoard().length)

		const { ui } = fakeUi({ picks: ["A file"], file: join(root, "b.json"), text: exported.written[0]?.text })
		const d = deps({ ui })
		expect(await loadBoard(d)).toMatchObject({ ok: true })
		expect(d.planned[0]?.map((task) => task.title)).toEqual(["Design", "Sketch", "Deploy"])

		expect(tasksFromBoardFile('{"name":"x"}')).toEqual({
			error: "It holds no tasks: load a board exported from the Board tab, or a saved plan (a template).",
		})
		expect(tasksFromBoardFile("not json")).toMatchObject({ error: expect.stringMatching(/^It is not JSON/) })
		expect(tasksFromBoardFile('{"tasks":[{"title":"From a plan"}]}')).toEqual({ tasks: [{ title: "From a plan" }] })
	})

	it("Export says why when the board cannot be read now, or is empty", async () => {
		const { ui } = fakeUi({})
		expect(await exportBoard(deps({ ui }))).toMatchObject({
			ok: false,
			errors: ["The board can be exported while its conversation is running or waiting for you."],
		})
		expect(await exportBoard(deps({ ui, events: () => [] }))).toMatchObject({
			ok: false,
			errors: ["The board has no tasks to export."],
		})
	})
})
