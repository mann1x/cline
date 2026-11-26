import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { approvePipeline, findPipeline, savePipeline } from "@cline/core"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
const boardEdit = vi.fn((_action: { op: "update"; updates: unknown[] }) => ({ ok: true, lines: ["T1: renamed."] }))
const runAction = vi.fn((action: { op: string; run: string; node?: string }): { ok: boolean; lines: string[]; run?: string } =>
	action.op === "rerun"
		? { ok: true, lines: ["Re-running deploy-1 from up as deploy-2."], run: "deploy-2" }
		: { ok: false, lines: ["deploy-1 is still running. Stop it first."] },
)

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "board-viewer-panel-"))
	ui.posted.length = 0
	ui.info.length = 0
	ui.warning = undefined
	ui.input = undefined
	boardEdit.mockClear()
	runAction.mockClear()
	openBoardViewerPanel({
		extensionUri: {} as never,
		workspaceRoot: () => root,
		boardText: () => undefined,
		boardEdit,
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
})
