import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { approvePipeline, findPipeline, savePipeline, TaskGraphStore } from "@cline/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SavedBoardEntry } from "./board-io"
import { BoardSlots, draftKey, type RecentBoard } from "./board-slots"
import type { BoardEditAction } from "./draft"

/**
 * The board viewer's requests (pipelines phase 4), answered by the panel
 * against a real workspace folder. VS Code is a fake: a panel that records
 * what it posts, and dialogs whose answers each test sets.
 */

const ui = vi.hoisted(() => ({
	receive: undefined as ((message: unknown) => void) | undefined,
	posted: [] as unknown[],
	warning: undefined as string | undefined,
	input: undefined as string | undefined,
	/** The label the person picks in a quick pick; none: cancelled. */
	pick: undefined as string | undefined,
	picks: [] as string[][],
	info: [] as string[],
}))

vi.mock("vscode", () => {
	const disposable = { dispose: () => {} }
	const event = () => disposable
	return {
		ViewColumn: { Active: -1, Beside: -2 },
		Uri: { file: (path: string) => ({ fsPath: path }), joinPath: () => ({}) },
		RelativePattern: class {},
		workspace: {
			createFileSystemWatcher: () => ({ onDidCreate: event, onDidChange: event, onDidDelete: event, dispose: () => {} }),
			asRelativePath: (target: string | { fsPath: string }) => (typeof target === "string" ? target : target.fsPath),
		},
		window: {
			createWebviewPanel: () => ({
				visible: true,
				webview: {
					html: "",
					cspSource: "",
					asWebviewUri: () => "",
					onDidReceiveMessage: (handler: (message: unknown) => void) => {
						ui.receive = handler
						return disposable
					},
					postMessage: async (message: unknown) => {
						ui.posted.push(message)
						return true
					},
				},
				onDidChangeViewState: event,
				onDidDispose: event,
				reveal: () => {},
			}),
			showWarningMessage: async () => ui.warning,
			showInputBox: async () => ui.input,
			showQuickPick: async (items: { label: string }[]) => {
				ui.picks.push(items.map((item) => item.label))
				return items.find((item) => item.label === ui.pick)
			},
			showInformationMessage: async (text: string) => {
				ui.info.push(text)
				return undefined
			},
			showErrorMessage: async () => undefined,
			showTextDocument: async () => undefined,
			showSaveDialog: async () => undefined,
		},
	}
})

import { openBoardViewerPanel } from "./panel"

let root: string
let boardTextValue: string | undefined
let conversationValue: { id: string; live: boolean } | undefined
let running = false
let clock = 0
let recentBoards: RecentBoard[] = []
let savedList: SavedBoardEntry[] = []
const savedEventsById = new Map<string, unknown[]>()
const draftStore = new Map<number, unknown[] | undefined>()
const boardEdit = vi.fn((_action: BoardEditAction) => ({ ok: true, lines: ["T1: renamed."] }))
const startConversation = vi.fn((_events: unknown[], onTaken: () => void) => onTaken())
const saveConversation = vi.fn(async (_id: string, _title?: string) => ({ ok: true, lines: ["Saved the board as m9."] }))
const saveEvents = vi.fn(async (_events: unknown[], _title?: string) => ({ ok: true, lines: ["Saved the board as m8."] }))
const deleteSaved = vi.fn(async (_id: string, _memory: string) => true)
const runAction = vi.fn((action: { op: string; run: string; node?: string }): { ok: boolean; lines: string[]; run?: string } =>
	action.op === "rerun"
		? { ok: true, lines: ["Re-running deploy-1 from up as deploy-2."], run: "deploy-2" }
		: { ok: false, lines: ["deploy-1 is still running. Stop it first."] },
)
/** A board's events as core writes them: what Memory and a conversation's log hold. */
function eventsOf(...titles: string[]): unknown[] {
	const store = new TaskGraphStore()
	store.plan({ tasks: titles.map((title) => ({ title })) }, { by: "person" }, { autoStart: false })
	return [...store.getEvents()]
}
const boards = new BoardSlots(
	{
		workspaceRoot: () => root,
		conversation: () => conversationValue,
		liveText: () => boardTextValue,
		liveEvents: () => undefined,
		liveEdit: boardEdit,
		turnRunning: () => running,
		draftStorage: (slot) => ({ get: () => draftStore.get(slot), set: (events) => draftStore.set(slot, events) }),
		recent: async () => recentBoards,
		saved: () => savedList,
		savedEvents: (id) => savedEventsById.get(id),
		saveConversation,
		saveEvents,
		deleteSaved,
		startConversation,
	},
	() => clock,
)

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "board-viewer-panel-"))
	ui.posted.length = 0
	ui.info.length = 0
	ui.warning = undefined
	ui.input = undefined
	ui.pick = undefined
	ui.picks.length = 0
	boardTextValue = undefined
	conversationValue = { id: "c1", live: true }
	running = false
	clock += 60_000
	recentBoards = []
	savedList = []
	savedEventsById.clear()
	for (const slot of [1, 2, 3]) boards.clear(draftKey(slot))
	for (const mock of [boardEdit, runAction, startConversation, saveConversation, saveEvents, deleteSaved]) mock.mockClear()
	openBoardViewerPanel({
		extensionUri: {} as never,
		workspaceRoot: () => root,
		boards,
		runAction,
	})
})
afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

let nextId = 100
/** Send a request and wait for the panel's reply to it. */
async function request(message: Record<string, unknown>): Promise<{ ok: boolean; errors?: string[]; lines?: string[] }> {
	const id = nextId++
	ui.receive?.({ ...message, id })
	await vi.waitFor(() => {
		if (!ui.posted.some((posted) => (posted as { id?: number }).id === id)) throw new Error("no reply yet")
	})
	return ui.posted.find((posted) => (posted as { id?: number }).id === id) as { ok: boolean; errors?: string[] }
}

const deploy = (command: string) => ({ name: "deploy", nodes: [{ id: "up", type: "command", command }] })

describe("the board viewer's requests", () => {
	it("checks a draft without saving it", async () => {
		const reply = await request({ type: "boardViewer/validate", definition: { name: "x", nodes: [] } })
		expect(reply.ok).toBe(false)
		expect(reply.errors?.length).toBeGreaterThan(0)
		expect(existsSync(join(root, ".cerebriline"))).toBe(false)
	})

	it("saves the person's edit as an approved version, from the version it started at", async () => {
		const first = savePipeline(root, deploy("make up"))
		if (!first.ok) throw new Error("not saved")
		const saved = await request({
			type: "boardViewer/save",
			slug: "deploy",
			base: first.file.hash,
			definition: deploy("make up --wait"),
		})
		expect(saved).toMatchObject({ ok: true })
		const file = findPipeline(root, "deploy")
		expect(file).toMatchObject({ isApproved: true, author: "person" })
		// A second save from the old version is refused: the file moved on.
		const stale = await request({
			type: "boardViewer/save",
			slug: "deploy",
			base: first.file.hash,
			definition: deploy("make down"),
		})
		expect(stale.ok).toBe(false)
		expect(stale.errors?.join(" ")).toContain("changed since version")
	})

	it("refuses a save that renames the pipeline, which would write another file", async () => {
		const first = savePipeline(root, deploy("make up"))
		if (!first.ok) throw new Error("not saved")
		const reply = await request({
			type: "boardViewer/save",
			slug: "deploy",
			base: first.file.hash,
			definition: { ...deploy("make up"), name: "ship" },
		})
		expect(reply.ok).toBe(false)
		expect(reply.errors?.[0]).toContain("would be a new file")
		expect(existsSync(join(root, ".cerebriline", "pipelines", "ship.pipeline.json"))).toBe(false)
	})

	it("approves only the version the person looked at, and only when they confirm", async () => {
		const first = savePipeline(root, deploy("make up"))
		if (!first.ok) throw new Error("not saved")
		expect(await request({ type: "boardViewer/approve", slug: "deploy", hash: "0000000000000000" })).toMatchObject({
			ok: false,
			errors: [expect.stringContaining("changed to version")],
		})
		ui.warning = undefined
		expect(await request({ type: "boardViewer/approve", slug: "deploy", hash: first.file.hash })).toMatchObject({
			ok: false,
		})
		expect(findPipeline(root, "deploy")?.isApproved).toBe(false)
		ui.warning = "Approve"
		expect(await request({ type: "boardViewer/approve", slug: "deploy", hash: first.file.hash })).toMatchObject({
			ok: true,
		})
		expect(findPipeline(root, "deploy")?.isApproved).toBe(true)
	})

	it("rejects a proposal back to the approved version", async () => {
		const first = savePipeline(root, deploy("make up"))
		if (!first.ok) throw new Error("not saved")
		approvePipeline(root, "deploy")
		const proposal = savePipeline(root, deploy("rm -rf /srv"), first.file.hash)
		if (!proposal.ok) throw new Error("not saved")
		ui.warning = "Reject"
		expect(await request({ type: "boardViewer/reject", slug: "deploy", hash: proposal.file.hash })).toMatchObject({
			ok: true,
		})
		expect(readFileSync(first.file.path, "utf8")).toBe(first.file.text)
	})

	it("saves the board as a pipeline for the person to approve, and a pipeline as a task template", async () => {
		ui.input = "From the board"
		const reply = await request({
			type: "boardViewer/boardToPipeline",
			tasks: [
				{ id: "T1", title: "Build", acceptance: ["`make` passes"] },
				{ id: "T2", title: "Ship", depends: ["T1"], gates: ["human:Ship?"] },
			],
		})
		expect(reply).toMatchObject({ ok: true })
		const file = findPipeline(root, "From the board")
		expect(file).toMatchObject({ valid: true, isApproved: false })
		expect(file?.definition?.nodes.map((node) => node.id)).toEqual(["t1", "t1-check", "t2-gate", "t2"])

		ui.input = "Release recipe"
		expect(await request({ type: "boardViewer/toTemplate", slug: "from-the-board" })).toMatchObject({ ok: true })
		const template = JSON.parse(
			readFileSync(join(root, ".cerebriline", "task-templates", "release-recipe.json"), "utf8"),
		) as { tasks: { title: string; gate?: string[] }[] }
		expect(template.tasks.map((task) => task.title)).toEqual(["Build", "Ship"])
		expect(template.tasks[1]?.gate).toEqual(["human:Ship?"])
	})

	it("sends a task change to the conversation's board as the person's", async () => {
		const reply = await request({ type: "boardViewer/editTask", updates: [{ id: "T1", title: "Build it" }] })
		expect(boardEdit).toHaveBeenCalledWith({ op: "update", updates: [{ id: "T1", title: "Build it" }] })
		expect(reply).toMatchObject({ ok: true, lines: ["T1: renamed."] })
	})

	it("acts on a run only once the person confirms, and says what the conversation answered", async () => {
		ui.warning = undefined
		const declined = await request({ type: "boardViewer/runAction", op: "rerun", run: "deploy-1", node: "up" })
		expect(declined).toMatchObject({ ok: false })
		expect(runAction).not.toHaveBeenCalled()

		ui.warning = "Re-run"
		const rerun = await request({ type: "boardViewer/runAction", op: "rerun", run: "deploy-1", node: "up" })
		expect(runAction).toHaveBeenCalledWith({ op: "rerun", run: "deploy-1", node: "up" })
		expect(rerun).toMatchObject({ ok: true, run: "deploy-2", lines: ["Re-running deploy-1 from up as deploy-2."] })

		ui.warning = "Retry"
		const refused = await request({ type: "boardViewer/runAction", op: "retry", run: "deploy-1", node: "up" })
		expect(refused).toMatchObject({ ok: false, errors: ["deploy-1 is still running. Stop it first."] })

		// A node action without a node is not asked about.
		runAction.mockClear()
		const noNode = await request({ type: "boardViewer/runAction", op: "skip", run: "deploy-1" })
		expect(noNode).toMatchObject({ ok: false, errors: ["Pick a node of the run first."] })
		expect(runAction).not.toHaveBeenCalled()
	})

	it("adds a task to the board, and hands a draft on or discards it once confirmed", async () => {
		const added = await request({ type: "boardViewer/addTask", title: "  Write the README " })
		expect(boardEdit).toHaveBeenCalledWith({ op: "plan", tasks: [{ title: "Write the README" }] })
		expect(added).toMatchObject({ ok: true })
		expect(await request({ type: "boardViewer/addTask", title: " " })).toMatchObject({
			ok: false,
			errors: ["Give the task a title."],
		})

		// No conversation open: the board shown first is Draft 1.
		conversationValue = undefined
		expect(await request({ type: "boardViewer/addTask", title: "Plan the release" })).toMatchObject({ ok: true })
		expect(boards.hasTasks(draftKey(1))).toBe(true)
		expect(await request({ type: "boardViewer/startFromDraft" })).toMatchObject({
			ok: true,
			lines: ["Send your first message in the chat: the new conversation starts from this board."],
		})
		expect(startConversation).toHaveBeenCalledTimes(1)
		// Taken by the new conversation: the draft is empty again.
		expect(boards.hasTasks(draftKey(1))).toBe(false)

		await request({ type: "boardViewer/addTask", title: "Spare", board: "draft:2" })
		ui.warning = undefined
		expect(await request({ type: "boardViewer/discardDraft", board: "draft:2" })).toMatchObject({ ok: false })
		expect(boards.hasTasks(draftKey(2))).toBe(true)
		ui.warning = "Discard"
		expect(await request({ type: "boardViewer/discardDraft", board: "draft:2" })).toMatchObject({ ok: true })
		expect(boards.hasTasks(draftKey(2))).toBe(false)
	})

	it("lists this conversation's board, three drafts, the recent conversations' and the ones saved in Memory", async () => {
		boardTextValue = JSON.stringify({ tasks: [{ id: "T1", title: "Live", status: "active" }] })
		recentBoards = [
			{ id: "s-old", title: "Fix the game\nmore", at: "2026-11-27T06:00:00Z", events: eventsOf("Old one", "Old two") },
		]
		savedList = [{ id: "m1", memory: "main", title: "Release", tasks: 1, open: 1, savedAt: "2026-11-20T10:00:00Z" }]
		savedEventsById.set("m1", eventsOf("Saved one"))
		await request({ type: "boardViewer/addTask", title: "Draft task", board: "draft:3" })
		ui.posted.length = 0
		ui.receive?.({ type: "boardViewer/ready" })
		await vi.waitFor(() => {
			if (!ui.posted.some((posted) => (posted as { type?: string }).type === "boardViewer/data")) throw new Error("no data")
		})
		const data = (
			ui.posted.find((posted) => (posted as { type?: string }).type === "boardViewer/data") as {
				data: { boards: { key: string; kind: string; label: string; tasks: number; editable: boolean }[] }
			}
		).data
		expect(data.boards.map((entry) => [entry.key, entry.label, entry.tasks, entry.editable])).toEqual([
			["live", "This conversation", 1, true],
			["draft:1", "Draft 1", 0, true],
			["draft:2", "Draft 2", 0, true],
			["draft:3", "Draft 3", 1, true],
			["recent:s-old", "Fix the game", 2, false],
			["saved:main/m1", "Release", 1, false],
		])
	})

	it("copies a board to this conversation or a draft, Add or Replace, and Replace waits while the model works", async () => {
		recentBoards = [{ id: "s-old", title: "Earlier", events: eventsOf("Old one", "Old two") }]
		ui.posted.length = 0
		ui.receive?.({ type: "boardViewer/ready" })
		await vi.waitFor(() => {
			if (!ui.posted.some((posted) => (posted as { type?: string }).type === "boardViewer/data")) throw new Error("no data")
		})

		// Into an empty draft: nothing to ask.
		const intoDraft = await request({ type: "boardViewer/copyBoard", from: "recent:s-old", to: "draft:1" })
		expect(intoDraft).toMatchObject({ ok: true })
		expect(intoDraft.lines?.[0]).toBe('Copied 2 tasks from the board of "Earlier" to Draft 1.')
		// Into a draft with tasks: Replace empties it first.
		ui.warning = "Replace"
		await request({ type: "boardViewer/copyBoard", from: "recent:s-old", to: "draft:1" })
		expect(JSON.parse(boards.text(draftKey(1)) ?? "{}").tasks.map((task: { title: string }) => task.title)).toEqual([
			"Old one",
			"Old two",
		])

		// This conversation, with tasks: Replace removes its tasks, then plans.
		boardTextValue = JSON.stringify({
			tasks: [
				{ id: "T1", title: "Live" },
				{ id: "T1.1", title: "Step", parent: "T1" },
			],
		})
		await request({ type: "boardViewer/copyBoard", from: "draft:1", to: "live" })
		expect(boardEdit.mock.calls.map((call) => call[0].op)).toEqual(["remove", "plan"])
		expect(boardEdit.mock.calls[0]?.[0]).toEqual({ op: "remove", ids: ["T1"] })

		// While the model works only Add is offered; a Replace that slips in is refused.
		boardEdit.mockClear()
		running = true
		ui.warning = "Replace"
		const refused = await request({ type: "boardViewer/copyBoard", from: "draft:1", to: "live" })
		expect(refused).toMatchObject({ ok: false })
		expect(boardEdit).not.toHaveBeenCalled()
		ui.warning = "Add"
		expect(await request({ type: "boardViewer/copyBoard", from: "draft:1", to: "live" })).toMatchObject({ ok: true })
		expect(boardEdit.mock.calls.map((call) => call[0].op)).toEqual(["plan"])

		// An earlier conversation's board and a saved one are not changed in place.
		expect(await request({ type: "boardViewer/addTask", title: "No", board: "recent:s-old" })).toMatchObject({ ok: false })
		expect(await request({ type: "boardViewer/copyBoard", from: "draft:1", to: "recent:s-old" })).toMatchObject({
			ok: false,
		})
		// A conversation reopened and not resumed: its board changes once it is.
		conversationValue = { id: "c1", live: false }
		expect(await request({ type: "boardViewer/addTask", title: "Later" })).toMatchObject({
			ok: false,
			errors: ["This conversation's board changes while its session runs: send a message to resume it."],
		})
	})

	it("saves a board into Memory and deletes a saved one only once confirmed", async () => {
		await request({ type: "boardViewer/addTask", title: "Keep me", board: "draft:2" })
		expect(await request({ type: "boardViewer/saveBoardToMemory", board: "draft:2" })).toMatchObject({ ok: true })
		expect(saveEvents).toHaveBeenCalledWith(expect.any(Array), "Draft 2")
		expect(await request({ type: "boardViewer/saveBoardToMemory", board: "live" })).toMatchObject({ ok: true })
		expect(saveConversation).toHaveBeenCalledWith("c1", undefined)

		ui.warning = undefined
		expect(await request({ type: "boardViewer/deleteSavedBoard", board: "saved:main/m1" })).toMatchObject({ ok: false })
		expect(deleteSaved).not.toHaveBeenCalled()
		ui.warning = "Delete"
		expect(await request({ type: "boardViewer/deleteSavedBoard", board: "saved:main/m1" })).toMatchObject({ ok: true })
		expect(deleteSaved).toHaveBeenCalledWith("m1", "main")
	})

	it("deletes a task only once the person confirms, naming its steps; adds a step under a task", async () => {
		boardTextValue = JSON.stringify({
			tasks: [
				{ id: "T1", title: "Design" },
				{ id: "T1.1", title: "Sketch" },
				{ id: "T2", title: "Build" },
			],
		})
		ui.warning = undefined
		expect(await request({ type: "boardViewer/deleteTask", task: "T1" })).toMatchObject({ ok: false })
		expect(boardEdit).not.toHaveBeenCalled()
		ui.warning = "Delete"
		expect(await request({ type: "boardViewer/deleteTask", task: "T1" })).toMatchObject({ ok: true })
		expect(boardEdit).toHaveBeenCalledWith({ op: "remove", ids: ["T1"] })

		await request({ type: "boardViewer/addTask", title: "Sketch again", parent: "T2" })
		expect(boardEdit).toHaveBeenLastCalledWith({ op: "plan", tasks: [{ title: "Sketch again", parent: "T2" }] })
	})

	it("makes a new pipeline the person names, saved as theirs, and nothing when the name is cancelled", async () => {
		ui.input = "Deploy"
		const made = await request({ type: "boardViewer/newPipeline" })
		expect(made).toMatchObject({ ok: true, pipeline: "deploy" })
		expect(findPipeline(root, "deploy")).toMatchObject({ valid: true, isApproved: true, author: "person" })
		ui.input = undefined
		expect(await request({ type: "boardViewer/newPipeline" })).toMatchObject({ ok: false })
	})

	it("starts a new pipeline from a copy of a saved one, which keeps its source's approval", async () => {
		const steps = [{ id: "check", type: "check", command: "node -e 0" }]
		savePipeline(root, { name: "manic_miner", description: "Checks the game", nodes: steps }, undefined, { by: "person" })
		savePipeline(root, { name: "Draft", nodes: steps }, undefined, { by: "model" })

		ui.pick = "A copy of manic_miner"
		ui.input = "jet_set"
		const made = await request({ type: "boardViewer/newPipeline" })
		expect(ui.picks[0]).toEqual(["Empty", "A copy of Draft", "A copy of manic_miner"])
		expect(made).toMatchObject({ ok: true, pipeline: "jet-set" })
		const copy = findPipeline(root, "jet_set")
		expect(copy?.definition).toMatchObject({ name: "jet_set", description: "Checks the game", nodes: steps })
		expect(copy?.isApproved).toBe(true)
		expect(findPipeline(root, "manic_miner")?.definition?.name).toBe("manic_miner")

		// Copying one nobody approved does not approve it.
		ui.pick = "A copy of Draft"
		ui.input = "Draft two"
		expect(await request({ type: "boardViewer/newPipeline" })).toMatchObject({ ok: true })
		expect(findPipeline(root, "Draft two")).toMatchObject({ valid: true, isApproved: false })

		ui.pick = undefined
		expect(await request({ type: "boardViewer/newPipeline" })).toMatchObject({ ok: false })
	})

	it("refuses a task plan with no tasks and says why, instead of saving it empty", async () => {
		savePipeline(root, { name: "manic_miner", nodes: [{ id: "check", type: "check", command: "node -e 0" }] }, undefined, {
			by: "person",
		})
		ui.input = "manic_miner"
		const reply = await request({ type: "boardViewer/toTemplate", slug: "manic-miner" })
		expect(reply.ok).toBe(false)
		expect(reply.errors?.[0]).toContain("manic_miner has only check steps, and none of them becomes a task")
		expect(existsSync(join(root, ".cerebriline", "task-templates"))).toBe(false)
	})
})
