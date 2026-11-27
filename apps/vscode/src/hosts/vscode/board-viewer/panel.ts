import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
	approvePipeline,
	boardToPipeline,
	findPipeline,
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
	type ViewerBoardTask,
	type ViewerFocus,
	type ViewerReplyMessage,
	type ViewerRequest,
	type ViewerRunOp,
} from "@/shared/board-viewer"
import { type BoardIoDeps, exportBoard, loadBoard } from "./board-io"
import { collectViewerData } from "./collect"
import type { BoardEditAction } from "./draft"

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
	/** The conversation's latest `task_graph` row text, when there is a conversation. */
	boardText: () => string | undefined
	/**
	 * A change to the board as the person's, as the task panel sends it: the
	 * open conversation's board, or the draft when no conversation is open.
	 */
	boardEdit?: (action: BoardEditAction) => { ok: boolean; lines: string[] }
	/** Whether the board shown is the draft for the next new conversation. */
	boardIsDraft?: () => boolean
	/** The draft goes to the next new conversation, or is thrown away. */
	draftStart?: () => { ok: boolean; lines: string[] }
	draftDiscard?: () => { ok: boolean; lines: string[] }
	/** Load onto and export the board shown. */
	boardIo?: BoardIoDeps
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
		const workspace = this.deps.workspaceRoot()
		const focus = this.focus
		// A focus is for the post that follows the open; later refreshes keep
		// whatever the person picked since.
		this.focus = undefined
		this.stale = false
		const data = workspace
			? collectViewerData({
					workspace,
					boardText: this.deps.boardText(),
					...(this.deps.boardIsDraft?.() ? { boardDraft: true } : {}),
					...(focus ? { focus } : {}),
				})
			: { workspace: "", pipelines: [], runs: [], ...(focus ? { focus } : {}) }
		void this.panel.webview.postMessage({ type: BOARD_VIEWER_DATA, data })
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
			case "boardViewer/editTask": {
				if (!this.deps.boardEdit) return { ok: false, errors: ["This editor cannot change the board."] }
				if (!Array.isArray(request.updates)) return { ok: false, errors: ["Not a board change."] }
				const outcome = this.deps.boardEdit({ op: "update", updates: request.updates })
				return { ok: outcome.ok, lines: outcome.lines }
			}
			case "boardViewer/runAction":
				return this.runAction(request.op, request.run, request.node)
			case "boardViewer/addTask": {
				if (!this.deps.boardEdit) return { ok: false, errors: ["This editor cannot change the board."] }
				const title = typeof request.title === "string" ? request.title.trim() : ""
				if (!title) return { ok: false, errors: ["Give the task a title."] }
				const parent = typeof request.parent === "string" && request.parent ? request.parent : undefined
				const outcome = this.deps.boardEdit({ op: "plan", tasks: [{ title, ...(parent ? { parent } : {}) }] })
				return outcome.ok ? { ok: true, lines: outcome.lines } : { ok: false, errors: outcome.lines }
			}
			case "boardViewer/deleteTask":
				return this.deleteTask(request.task)
			case "boardViewer/loadBoard":
				if (!this.deps.boardIo) return { ok: false, errors: ["This editor cannot load a board."] }
				return loadBoard(this.deps.boardIo)
			case "boardViewer/exportBoard":
				if (!this.deps.boardIo) return { ok: false, errors: ["This editor cannot export the board."] }
				return exportBoard(this.deps.boardIo)
			case "boardViewer/startFromDraft": {
				if (!this.deps.draftStart) return { ok: false, errors: ["This editor has no draft board."] }
				const outcome = this.deps.draftStart()
				return outcome.ok ? { ok: true, lines: outcome.lines } : { ok: false, errors: outcome.lines }
			}
			case "boardViewer/discardDraft": {
				if (!this.deps.draftDiscard) return { ok: false, errors: ["This editor has no draft board."] }
				const answer = await vscode.window.showWarningMessage(
					"Discard the draft board? Its tasks are gone for good.",
					{ modal: true },
					"Discard",
				)
				if (answer !== "Discard") return { ok: false }
				const outcome = this.deps.draftDiscard()
				return { ok: outcome.ok, lines: outcome.lines }
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
	private async deleteTask(task: unknown): Promise<{ ok: boolean; errors?: string[]; lines?: string[] }> {
		if (!this.deps.boardEdit) return { ok: false, errors: ["This editor cannot change the board."] }
		if (typeof task !== "string" || !task) return { ok: false, errors: ["Pick a task first."] }
		const board = this.boardTasks()
		const found = board.find((entry) => entry.id === task)
		const steps = board.filter((entry) => entry.id.startsWith(`${task}.`)).length
		const name = found ? `${task} "${found.title}"` : task
		const answer = await vscode.window.showWarningMessage(
			`Delete ${name}${steps ? ` and its ${steps} step${steps === 1 ? "" : "s"}` : ""}? It is gone from the board for good, and the tasks after it stop waiting on it.`,
			{ modal: true },
			"Delete",
		)
		if (answer !== "Delete") return { ok: false }
		const outcome = this.deps.boardEdit({ op: "remove", ids: [task] })
		return outcome.ok ? { ok: true, lines: outcome.lines } : { ok: false, errors: outcome.lines }
	}

	/** The board shown, as its tasks' ids and titles. */
	private boardTasks(): { id: string; title: string }[] {
		try {
			const text = this.deps.boardText()
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
	private async newPipeline(root: string): Promise<{ ok: boolean; errors?: string[]; lines?: string[]; pipeline?: string }> {
		const name = await vscode.window.showInputBox({
			title: "New pipeline",
			prompt: "Its name. It is saved to .cerebriline/pipelines; add its steps in the Board tab.",
			validateInput: (value) =>
				!value.trim()
					? "Give it a name."
					: findPipeline(root, value)
						? `There is a pipeline "${value.trim()}" already.`
						: undefined,
		})
		if (!name?.trim()) return { ok: false }
		const saved = savePipeline(
			root,
			{ name: name.trim(), nodes: [{ id: "start", type: "set", fields: {} }] } as PipelineDefinition,
			undefined,
			{ by: "person" },
		)
		if (!saved.ok) return { ok: false, errors: saved.errors }
		const slug = pipelineSlug(name.trim())
		return {
			ok: true,
			lines: [`Saved ${name.trim()}. Add its steps from the palette, then Save.`],
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
		const name = await vscode.window.showInputBox({
			title: "Save the pipeline as a task template",
			prompt: 'The template\'s name. The model starts from it with task_plan {"template": name}.',
			value: file.name,
			validateInput: (value) => (value.trim() ? undefined : "Give it a name."),
		})
		if (!name?.trim()) return { ok: false }
		const dir = join(root, TASK_TEMPLATE_DIR)
		if (existsSync(join(dir, `${templateSlug(name.trim())}.json`))) {
			const answer = await vscode.window.showWarningMessage(
				`A template named ${name.trim()} exists. Replace it?`,
				{ modal: true },
				"Replace",
			)
			if (answer !== "Replace") return { ok: false }
		}
		const template = pipelineToTemplate(file.definition as PipelineDefinition, name.trim())
		const path = saveTaskTemplate(dir, template)
		void vscode.window.showInformationMessage(
			`Saved ${template.tasks.length} tasks as the template ${name.trim()} in ${vscode.workspace.asRelativePath(path)}.`,
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
