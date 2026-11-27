import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
	approvePipeline,
	boardToPipeline,
	findPipeline,
	listPipelines,
	type PipelineDefinition,
	pipelineSlug,
	pipelineToTemplate,
	rejectPipeline,
	savePipeline,
	saveTaskTemplate,
	TASK_TEMPLATE_DIR,
	templateSlug,
	validatePipeline,
} from "@cline/core"
import * as vscode from "vscode"
import { onBoardChanged } from "@/core/webview/board-viewer-hooks"
import { getNonce } from "@/core/webview/getNonce"
import {
	BOARD_VIEWER_DATA,
	BOARD_VIEWER_REPLY,
	type ViewerBoardEntry,
	type ViewerBoardTask,
	type ViewerCatalog,
	type ViewerData,
	type ViewerFocus,
	type ViewerReplyMessage,
	type ViewerRequest,
	type ViewerRunOp,
} from "@/shared/board-viewer"
import { Logger } from "@/shared/services/Logger"
import { exportBoard, loadBoard } from "./board-io"
import type { BoardSlots } from "./board-slots"
import { collectViewerData } from "./collect"

/**
 * The board viewer (pipelines plan phase 3): an editor-area panel beside the
 * chat that draws the conversation's task board, the workspace's pipelines
 * and their runs. Phase 4 made it an editor: the person's edits to a
 * pipeline are validated here and saved as approved versions, the model's
 * proposals are approved or rejected here, a board can be saved as a
 * pipeline and a pipeline as a task template, and a task can be changed as
 * the task panel changes it. It is the chat's own webview bundle, started
 * with `data-view="board"` on its root, so it shares the theme and the build.
 *
 * The data is read here, on the extension side, because pipeline runs never
 * reach the chat webview: the files under `.cerebriline/` are the record. It
 * is re-read when those files change, when the board changes, and when the
 * panel comes back into view, and posted only while the panel is visible.
 */

export const BOARD_VIEWER_PANEL_ID = "cerebriline.boardViewer"
/** Events land in bursts (a node's start and end, a board's several rows): one read per burst. */
const REFRESH_DELAY_MS = 250

export interface BoardViewerDeps {
	extensionUri: vscode.Uri
	/** The workspace whose `.cerebriline/` is read. */
	workspaceRoot: () => string | undefined
	/**
	 * Every board the tab lists and changes: this conversation's, the drafts,
	 * the recent conversations', the ones saved in Memory (board-slots.ts).
	 */
	boards?: BoardSlots
	/** What the step form completes from. */
	catalog?: () => ViewerCatalog
	/** The person's action on a run, through the conversation that started it. */
	runAction?: (action: { op: ViewerRunOp; run: string; node?: string }) => { ok: boolean; lines: string[]; run?: string }
}

/** The confirm for each run action: its button, and what it does. */
const RUN_OPS: Record<ViewerRunOp, { label: string; question: (run: string, node: string) => string }> = {
	retry: {
		label: "Retry",
		question: (run, node) => `Retry ${node}? ${run} resumes: ${node} runs again, then what comes after it.`,
	},
	skip: {
		label: "Skip",
		question: (run, node) =>
			`Skip ${node}? It counts as done without running again, its input goes on to the nodes after it, and ${run} resumes.`,
	},
	rerun: {
		label: "Re-run",
		question: (run, node) =>
			`Re-run ${run} from ${node}? A new run starts: it reuses what came before ${node} and runs ${node} and everything after it again.`,
	},
	stop: { label: "Stop", question: (run) => `Stop ${run}? The nodes running now are stopped.` },
}

let current: BoardViewer | undefined

export function openBoardViewerPanel(deps: BoardViewerDeps, focus?: ViewerFocus): void {
	if (current) {
		current.reveal(focus)
		return
	}
	current = new BoardViewer(deps, focus)
}

class BoardViewer {
	private readonly panel: vscode.WebviewPanel
	private readonly disposables: vscode.Disposable[] = []
	private focus: ViewerFocus | undefined
	private ready = false
	private timer: ReturnType<typeof setTimeout> | undefined
	private stale = true
	/** Counts the posts, so a slow one does not draw over a newer one. */
	private generation = 0

	constructor(
		private readonly deps: BoardViewerDeps,
		focus: ViewerFocus | undefined,
	) {
		this.focus = focus
		this.panel = vscode.window.createWebviewPanel(
			BOARD_VIEWER_PANEL_ID,
			"Board",
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [deps.extensionUri],
			},
		)
		this.panel.webview.html = this.html()
		this.panel.webview.onDidReceiveMessage((message) => this.receive(message), null, this.disposables)
		this.panel.onDidChangeViewState(
			() => {
				if (this.panel.visible && this.stale) this.schedule()
			},
			null,
			this.disposables,
		)
		this.panel.onDidDispose(() => this.dispose(), null, this.disposables)
		this.disposables.push({ dispose: onBoardChanged(() => this.schedule()) })
		this.watch()
	}

	reveal(focus: ViewerFocus | undefined): void {
		this.focus = focus
		this.panel.reveal()
		this.schedule(0)
	}

	private watch(): void {
		const root = this.deps.workspaceRoot()
		if (!root) return
		const watcher = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(vscode.Uri.file(root), ".cerebriline/{pipelines,pipeline-runs}/**"),
		)
		const refresh = () => this.schedule()
		watcher.onDidCreate(refresh, null, this.disposables)
		watcher.onDidChange(refresh, null, this.disposables)
		watcher.onDidDelete(refresh, null, this.disposables)
		this.disposables.push(watcher)
	}

	private schedule(delay = REFRESH_DELAY_MS): void {
		this.stale = true
		if (!this.ready || !this.panel.visible) return
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => {
			this.timer = undefined
			this.post()
		}, delay)
	}

	private post(): void {
		void this.postData()
	}

	private async postData(): Promise<void> {
		const generation = ++this.generation
		const workspace = this.deps.workspaceRoot()
		const focus = this.focus
		// A focus is for the post that follows the open; later refreshes keep
		// whatever the person picked since.
		this.focus = undefined
		this.stale = false
		const boards = this.deps.boards
		// The tab draws first, with the recent conversations as last read;
		// reading them again can take a while (owner, 2026-11-27: the tab sat
		// on "Reading the workspace…" while the history was read).
		await this.send(workspace, focus, boards ? await boards.list({ cachedOnly: true }).catch(() => undefined) : undefined)
		if (!boards || !workspace || boards.recentIsFresh()) return
		const entries = await boards.list().catch(() => undefined)
		// A later post has drawn the tab since: it has the newer state.
		if (generation !== this.generation || !entries) return
		await this.send(workspace, undefined, entries)
	}

	private async send(
		workspace: string | undefined,
		focus: ViewerFocus | undefined,
		entries: ViewerBoardEntry[] | undefined,
	): Promise<void> {
		let data: ViewerData
		try {
			const boards = this.deps.boards
			const home = boards?.home()
			data = workspace
				? collectViewerData({
						workspace,
						boardText: home ? boards?.text(home) : undefined,
						...(home && home !== "live" ? { boardDraft: true } : {}),
						...(entries ? { boards: entries } : {}),
						...(boards?.turnRunning() ? { turnRunning: true } : {}),
						...(this.deps.catalog ? { catalog: this.deps.catalog() } : {}),
						...(focus ? { focus } : {}),
					})
				: { workspace: "", pipelines: [], runs: [], ...(focus ? { focus } : {}) }
		} catch (error) {
			// The tab must leave "Reading the workspace…" even when a part fails.
			Logger.error("[board-viewer] collecting the tab's data failed", error)
			data = { workspace: workspace ?? "", pipelines: [], runs: [], ...(focus ? { focus } : {}) }
		}
		await this.panel.webview.postMessage({ type: BOARD_VIEWER_DATA, data })
	}

	private receive(message: unknown): void {
		const request = message as Partial<ViewerRequest> | undefined
		switch (request?.type) {
			case "boardViewer/ready":
				this.ready = true
				this.schedule(0)
				return
			case "boardViewer/openFile":
				if (typeof (request as { path?: unknown }).path === "string") {
					void vscode.window.showTextDocument(vscode.Uri.file((request as { path: string }).path), {
						preview: true,
						viewColumn: vscode.ViewColumn.Beside,
					})
				}
				return
			case "boardViewer/saveReport":
				void this.saveReport(request as { name?: unknown; text?: unknown })
				return
		}
		const id = (request as { id?: unknown } | undefined)?.id
		if (typeof id !== "number") return
		void this.answer(request as ViewerRequest & { id: number })
			.catch((error: unknown) => ({ ok: false, errors: [error instanceof Error ? error.message : String(error)] }))
			.then((outcome) => {
				const reply: ViewerReplyMessage = { type: BOARD_VIEWER_REPLY, id, ...outcome }
				void this.panel.webview.postMessage(reply)
				if (outcome.ok) this.schedule(0)
			})
	}

	/** A request the panel waits on: what it changed, or why it did not. */
	private async answer(
		request: ViewerRequest & { id: number },
	): Promise<{ ok: boolean; errors?: string[]; lines?: string[]; run?: string; pipeline?: string }> {
		const root = this.deps.workspaceRoot()
		switch (request.type) {
			case "boardViewer/validate": {
				const checked = validatePipeline(request.definition)
				return { ok: checked.ok, errors: checked.errors }
			}
			case "boardViewer/runAction":
				return this.runAction(request.op, request.run, request.node)
		}
		const boards = this.deps.boards
		switch (request.type) {
			case "boardViewer/editTask": {
				if (!boards) return { ok: false, errors: ["This editor cannot change the board."] }
				if (!Array.isArray(request.updates)) return { ok: false, errors: ["Not a board change."] }
				const outcome = boards.edit(boards.resolve(request.board), { op: "update", updates: request.updates })
				return outcome.ok
					? { ok: true, lines: outcome.lines }
					: { ok: false, lines: outcome.lines, errors: outcome.lines }
			}
			case "boardViewer/addTask": {
				if (!boards) return { ok: false, errors: ["This editor cannot change the board."] }
				const title = typeof request.title === "string" ? request.title.trim() : ""
				if (!title) return { ok: false, errors: ["Give the task a title."] }
				const parent = typeof request.parent === "string" && request.parent ? request.parent : undefined
				const outcome = boards.edit(boards.resolve(request.board), {
					op: "plan",
					tasks: [{ title, ...(parent ? { parent } : {}) }],
				})
				return outcome.ok ? { ok: true, lines: outcome.lines } : { ok: false, errors: outcome.lines }
			}
			case "boardViewer/deleteTask":
				return this.deleteTask(request.task, request.board)
			case "boardViewer/loadBoard": {
				if (!boards) return { ok: false, errors: ["This editor cannot load a board."] }
				const key = boards.resolve(request.board)
				const refused = boards.readOnly(key)
				if (refused) return { ok: false, errors: [refused] }
				return loadBoard(boards.io(key, { workspaceRoot: this.deps.workspaceRoot }))
			}
			case "boardViewer/exportBoard":
				if (!boards) return { ok: false, errors: ["This editor cannot export the board."] }
				return exportBoard(boards.io(boards.resolve(request.board), { workspaceRoot: this.deps.workspaceRoot }))
			case "boardViewer/startFromDraft": {
				if (!boards) return { ok: false, errors: ["This editor has no draft board."] }
				const outcome = boards.start(boards.resolve(request.board))
				return outcome.ok ? { ok: true, lines: outcome.lines } : { ok: false, errors: outcome.lines }
			}
			case "boardViewer/discardDraft": {
				if (!boards) return { ok: false, errors: ["This editor has no draft board."] }
				const key = boards.resolve(request.board)
				const answer = await vscode.window.showWarningMessage(
					"Discard this draft? Its tasks are gone for good.",
					{ modal: true },
					"Discard",
				)
				if (answer !== "Discard") return { ok: false }
				const outcome = boards.clear(key)
				return outcome.ok ? { ok: true, lines: outcome.lines } : { ok: false, errors: outcome.lines }
			}
			case "boardViewer/copyBoard": {
				if (!boards) return { ok: false, errors: ["This editor cannot copy boards."] }
				if (typeof request.from !== "string" || typeof request.to !== "string") {
					return { ok: false, errors: ["Pick the boards to copy from and to."] }
				}
				return boards.copy(request.from, request.to, async (question, ...buttons) =>
					vscode.window.showWarningMessage(question, { modal: true }, ...buttons),
				)
			}
			case "boardViewer/saveBoardToMemory": {
				if (!boards) return { ok: false, errors: ["This editor cannot save boards."] }
				const outcome = await boards.save(boards.resolve(request.board))
				return outcome.ok ? { ok: true, lines: outcome.lines } : { ok: false, errors: outcome.lines }
			}
			case "boardViewer/deleteSavedBoard": {
				if (!boards) return { ok: false, errors: ["This editor cannot delete boards."] }
				const answer = await vscode.window.showWarningMessage(
					"Delete this board from Memory? It is gone for good; conversations that started from it keep their own boards.",
					{ modal: true },
					"Delete",
				)
				if (answer !== "Delete") return { ok: false }
				const outcome = await boards.deleteSaved(boards.resolve(request.board))
				return outcome.ok ? { ok: true, lines: outcome.lines } : { ok: false, errors: outcome.lines }
			}
		}
		if (!root) return { ok: false, errors: ["Open a folder first: pipelines live in the workspace."] }
		switch (request.type) {
			case "boardViewer/save":
				return this.save(root, request.slug, request.base, request.definition)
			case "boardViewer/approve":
				return this.approve(root, request.slug, request.hash)
			case "boardViewer/reject":
				return this.reject(root, request.slug, request.hash)
			case "boardViewer/boardToPipeline":
				return this.boardToPipeline(root, request.tasks)
			case "boardViewer/toTemplate":
				return this.toTemplate(root, request.slug)
			case "boardViewer/newPipeline":
				return this.newPipeline(root)
			default:
				return { ok: false, errors: ["Not a request this panel knows."] }
		}
	}

	/**
	 * Delete a task for good, with its steps, after asking: only the person
	 * deletes (the model cancels), and the tasks after it stop waiting on it.
	 */
	private async deleteTask(task: unknown, board: unknown): Promise<{ ok: boolean; errors?: string[]; lines?: string[] }> {
		const boards = this.deps.boards
		if (!boards) return { ok: false, errors: ["This editor cannot change the board."] }
		if (typeof task !== "string" || !task) return { ok: false, errors: ["Pick a task first."] }
		const key = boards.resolve(board)
		const refused = boards.readOnly(key)
		if (refused) return { ok: false, errors: [refused] }
		const tasks = this.boardTasks(boards.text(key))
		const found = tasks.find((entry) => entry.id === task)
		const steps = tasks.filter((entry) => entry.id.startsWith(`${task}.`)).length
		const name = found ? `${task} "${found.title}"` : task
		const answer = await vscode.window.showWarningMessage(
			`Delete ${name}${steps ? ` and its ${steps} step${steps === 1 ? "" : "s"}` : ""}? It is gone from the board for good, and the tasks after it stop waiting on it.`,
			{ modal: true },
			"Delete",
		)
		if (answer !== "Delete") return { ok: false }
		const outcome = boards.edit(key, { op: "remove", ids: [task] })
		return outcome.ok ? { ok: true, lines: outcome.lines } : { ok: false, errors: outcome.lines }
	}

	/** A board's tasks, as their ids and titles. */
	private boardTasks(text: string | undefined): { id: string; title: string }[] {
		try {
			const parsed = text ? (JSON.parse(text) as { tasks?: { id?: unknown; title?: unknown }[] }) : undefined
			return (parsed?.tasks ?? [])
				.filter((entry) => typeof entry.id === "string")
				.map((entry) => ({ id: entry.id as string, title: String(entry.title ?? "") }))
		} catch {
			return []
		}
	}

	/**
	 * Retry, Skip, Re-run from a node, or Stop. Each changes what runs in
	 * the background (commands, tools, requests), so it is confirmed first;
	 * the conversation that started the run decides whether it can.
	 */
	private async runAction(
		op: ViewerRunOp,
		run: string,
		node: string | undefined,
	): Promise<{ ok: boolean; errors?: string[]; lines?: string[]; run?: string }> {
		if (!this.deps.runAction) return { ok: false, errors: ["This editor cannot act on runs."] }
		if (!RUN_OPS[op] || typeof run !== "string") return { ok: false, errors: ["Not a run action."] }
		if (op !== "stop" && typeof node !== "string") return { ok: false, errors: ["Pick a node of the run first."] }
		const { label, question } = RUN_OPS[op]
		const answer = await vscode.window.showWarningMessage(question(run, node ?? ""), { modal: true }, label)
		if (answer !== label) return { ok: false }
		const outcome = this.deps.runAction({ op, run, ...(node !== undefined ? { node } : {}) })
		return outcome.ok
			? { ok: true, lines: outcome.lines, ...(outcome.run ? { run: outcome.run } : {}) }
			: { ok: false, errors: outcome.lines }
	}

	/**
	 * A new pipeline the person names: one harmless `set` node to start from,
	 * saved as theirs and so approved. The viewer opens it to edit.
	 */
	/**
	 * A new pipeline: empty, or a copy of a saved one to start from (owner,
	 * 2026-11-27: "when I click new it just asks for a name, it doesn't propose
	 * a template"). A copy keeps its source's approval: the same steps the
	 * person approved are approved, and a copy of one nobody approved waits for
	 * approval as its source does, so copying never approves anything.
	 */
	private async newPipeline(root: string): Promise<{ ok: boolean; errors?: string[]; lines?: string[]; pipeline?: string }> {
		const sources = listPipelines(root).filter((file) => file.definition)
		type Start = vscode.QuickPickItem & { source?: (typeof sources)[number] }
		const picked: Start | undefined =
			sources.length === 0
				? { label: "Empty" }
				: await vscode.window.showQuickPick<Start>(
						[
							{ label: "Empty", description: "add its steps in the Board tab" },
							...sources.map((file) => {
								const steps = file.definition?.nodes.length ?? 0
								return {
									label: `A copy of ${file.name}`,
									description: `${steps} step${steps === 1 ? "" : "s"}, ${file.isApproved ? "approved" : "not approved"}`,
									...(file.definition?.description ? { detail: file.definition.description } : {}),
									source: file,
								}
							}),
						],
						{ title: "New pipeline", placeHolder: "Start from…", matchOnDescription: true },
					)
		if (!picked) return { ok: false }
		const source = picked.source
		const name = await vscode.window.showInputBox({
			title: source ? `New pipeline from ${source.name}` : "New pipeline",
			prompt: source
				? `Its name. ${source.name}'s steps are copied to it in .cerebriline/pipelines; ${source.name} is not changed.`
				: "Its name. It is saved to .cerebriline/pipelines; add its steps in the Board tab.",
			...(source ? { value: `${source.name} copy` } : {}),
			validateInput: (value) =>
				!value.trim()
					? "Give it a name."
					: findPipeline(root, value)
						? `There is a pipeline "${value.trim()}" already.`
						: undefined,
		})
		if (!name?.trim()) return { ok: false }
		const definition = source?.definition
			? ({ ...source.definition, name: name.trim() } as PipelineDefinition)
			: ({ name: name.trim(), nodes: [{ id: "start", type: "set", fields: {} }] } as PipelineDefinition)
		const saved = savePipeline(root, definition, undefined, {
			by: "person",
			...(source && !source.isApproved ? { approve: false } : {}),
		})
		if (!saved.ok) return { ok: false, errors: saved.errors }
		const slug = pipelineSlug(name.trim())
		return {
			ok: true,
			lines: [
				source
					? `Saved ${name.trim()}, a copy of ${source.name}${source.isApproved ? "" : ", for you to approve"}.`
					: `Saved ${name.trim()}. Add its steps from the palette, then Save.`,
			],
			pipeline: slug,
		}
	}

	/** The person's edit: saved and approved, as their own edits are (plan section 7). */
	private save(root: string, slug: string, base: string, definition: unknown): { ok: boolean; errors?: string[] } {
		const checked = validatePipeline(definition)
		if (!checked.ok || !checked.pipeline) return { ok: false, errors: checked.errors }
		if (pipelineSlug(checked.pipeline.name) !== slug) {
			return {
				ok: false,
				errors: [
					`The name gives the file its name: "${checked.pipeline.name}" would be a new file, not this one. Keep the name, or rename the file.`,
				],
			}
		}
		const saved = savePipeline(root, checked.pipeline, base, { by: "person" })
		return saved.ok ? { ok: true } : { ok: false, errors: saved.errors }
	}

	private async approve(root: string, slug: string, hash: string): Promise<{ ok: boolean; errors?: string[] }> {
		const file = findPipeline(root, slug)
		if (!file) return { ok: false, errors: [`No pipeline ${slug} any more.`] }
		if (file.hash !== hash) {
			return { ok: false, errors: [`The file changed to version ${file.hash} while you looked: read it again first.`] }
		}
		if (!file.valid) return { ok: false, errors: file.errors }
		const answer = await vscode.window.showWarningMessage(
			`Approve ${file.name} (version ${file.hash})? It can then run its commands and tools in the background.`,
			{ modal: true },
			"Approve",
		)
		if (answer !== "Approve") return { ok: false }
		approvePipeline(root, slug)
		return { ok: true }
	}

	private async reject(root: string, slug: string, hash: string): Promise<{ ok: boolean; errors?: string[] }> {
		const file = findPipeline(root, slug)
		if (!file) return { ok: false, errors: [`No pipeline ${slug} any more.`] }
		if (file.hash !== hash) {
			return { ok: false, errors: [`The file changed to version ${file.hash} while you looked: read it again first.`] }
		}
		const answer = await vscode.window.showWarningMessage(
			`Reject version ${file.hash} of ${file.name}? The file goes back to the approved version ${file.approved?.hash ?? ""}.`,
			{ modal: true },
			"Reject",
		)
		if (answer !== "Reject") return { ok: false }
		rejectPipeline(root, slug)
		return { ok: true }
	}

	/** The board as a new pipeline file: a proposal the person reads and approves. */
	private async boardToPipeline(root: string, tasks: ViewerBoardTask[]): Promise<{ ok: boolean; errors?: string[] }> {
		if (!Array.isArray(tasks) || tasks.length === 0) return { ok: false, errors: ["The board has no tasks."] }
		const name = await vscode.window.showInputBox({
			title: "Save the board as a pipeline",
			prompt: "The pipeline's name. It is saved to .cerebriline/pipelines for you to read and approve.",
			validateInput: (value) =>
				!value.trim()
					? "Give it a name."
					: findPipeline(root, value)
						? `${pipelineSlug(value)}.pipeline.json exists: choose another name.`
						: undefined,
		})
		if (!name?.trim()) return { ok: false }
		const { definition, notes } = boardToPipeline(tasks, name.trim())
		const saved = savePipeline(root, definition, undefined, { by: "person", approve: false })
		if (!saved.ok) return { ok: false, errors: saved.errors }
		this.focus = { pipeline: saved.file.slug }
		void vscode.window.showInformationMessage(
			[
				`Saved ${saved.file.name} with ${definition.nodes.length} nodes. Read it and approve it before it runs.`,
				...notes,
			].join(" "),
		)
		return { ok: true }
	}

	/** A pipeline as a task template in the workspace, for work the model should do rather than run. */
	private async toTemplate(root: string, slug: string): Promise<{ ok: boolean; errors?: string[] }> {
		const file = findPipeline(root, slug)
		if (!file?.definition) return { ok: false, errors: [file ? "It does not validate." : `No pipeline ${slug} any more.`] }
		// A plan with no tasks is refused, not saved empty (owner, 2026-11-27: a
		// pipeline of one check saved as a template with no tasks).
		if (pipelineToTemplate(file.definition as PipelineDefinition).tasks.length === 0) {
			const kinds = [...new Set((file.definition as PipelineDefinition).nodes.map((node) => node.type))]
			return {
				ok: false,
				errors: [
					`${file.name} has only ${kinds.join(" and ")} steps, and none of them becomes a task: a task plan takes the steps that do work (agent, command, tool, http, loop, swarm, pipeline), and a check becomes acceptance on the task before it. Run ${file.name} instead, or start a new pipeline from it with + New.`,
				],
			}
		}
		const name = await vscode.window.showInputBox({
			title: "Make a task plan from the pipeline",
			prompt: 'The plan\'s name. Its steps become tasks: load it onto a board with Load… → A saved plan, or the model starts from it with task_plan {"template": name}.',
			value: file.name,
			validateInput: (value) => (value.trim() ? undefined : "Give it a name."),
		})
		if (!name?.trim()) return { ok: false }
		const dir = join(root, TASK_TEMPLATE_DIR)
		if (existsSync(join(dir, `${templateSlug(name.trim())}.json`))) {
			const answer = await vscode.window.showWarningMessage(
				`A task plan named ${name.trim()} exists. Replace it?`,
				{ modal: true },
				"Replace",
			)
			if (answer !== "Replace") return { ok: false }
		}
		const template = pipelineToTemplate(file.definition as PipelineDefinition, name.trim())
		const path = saveTaskTemplate(dir, template)
		void vscode.window.showInformationMessage(
			`Saved ${template.tasks.length} task${template.tasks.length === 1 ? "" : "s"} as the plan ${name.trim()} in ${vscode.workspace.asRelativePath(path)}. Load it onto a board with Load… → A saved plan.`,
		)
		return { ok: true }
	}

	private async saveReport(request: { name?: unknown; text?: unknown }): Promise<void> {
		if (typeof request.text !== "string") return
		const name = typeof request.name === "string" && request.name ? request.name : "pipeline-run"
		const root = this.deps.workspaceRoot()
		const target = await vscode.window.showSaveDialog({
			...(root ? { defaultUri: vscode.Uri.file(`${root}/${name}-report.md`) } : {}),
			filters: { Markdown: ["md"] },
			saveLabel: "Save report",
		})
		if (!target) return
		try {
			writeFileSync(target.fsPath, request.text)
			void vscode.window.showInformationMessage(`Saved the report to ${vscode.workspace.asRelativePath(target)}.`)
		} catch (error) {
			void vscode.window.showErrorMessage(
				`Could not save the report: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}

	private html(): string {
		const webview = this.panel.webview
		const asset = (file: string) =>
			webview.asWebviewUri(vscode.Uri.joinPath(this.deps.extensionUri, "webview-ui", "build", "assets", file))
		const nonce = getNonce()
		const csp = webview.cspSource
		return /*html*/ `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta name="viewport" content="width=device-width,initial-scale=1">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; font-src ${csp} data:; style-src ${csp} 'unsafe-inline'; img-src ${csp} data:; script-src 'nonce-${nonce}' 'unsafe-eval';">
		<link rel="stylesheet" type="text/css" href="${asset("index.css")}">
		<title>Board</title>
	</head>
	<body>
		<div id="root" data-view="board"></div>
		<script type="module" nonce="${nonce}" src="${asset("index.js")}"></script>
	</body>
</html>`
	}

	private dispose(): void {
		if (this.timer) clearTimeout(this.timer)
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose()
		}
		if (current === this) current = undefined
	}
}
