import { type BoardBackend, type BoardHostUi, type BoardSlots, createBoardBackend } from "@cline/taskboard"
import * as vscode from "vscode"
import { onBoardChanged } from "@/core/webview/board-viewer-hooks"
import { getNonce } from "@/core/webview/getNonce"
import { BOARD_VIEWER_DATA, type ViewerCatalog, type ViewerFocus, type ViewerRunOp } from "@/shared/board-viewer"
import { Logger } from "@/shared/services/Logger"

/**
 * The board viewer (pipelines plan phase 3): an editor-area panel beside the
 * chat that draws the conversation's task board, the workspace's pipelines
 * and their runs, and edits them. It is the chat's own webview bundle,
 * started with `data-view="board"` on its root, so it shares the theme and
 * the build.
 *
 * What the tab asks is answered by @cline/taskboard's board backend, the same
 * one any host embedding the Board tab uses; this panel is its VS Code half:
 * the webview, the file watcher, and VS Code's pickers, dialogs and editor as
 * the backend's way to ask the person. The data is read on this side because
 * pipeline runs never reach the chat webview: the files under `.cerebriline/`
 * are the record. It is re-read when those files change, when the board
 * changes, and when the panel comes back into view, and posted only while the
 * panel is visible.
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
	 * the recent conversations', the ones saved in Memory (@cline/taskboard's
	 * BoardSlots).
	 */
	boards?: BoardSlots
	/** What the step form completes from. */
	catalog?: () => ViewerCatalog
	/** The person's action on a run, through the conversation that started it. */
	runAction?: (action: { op: ViewerRunOp; run: string; node?: string }) => { ok: boolean; lines: string[]; run?: string }
	/** How the person is asked; VS Code's pickers and dialogs unless a test answers. */
	ui?: BoardHostUi
}

/** The backend's way to ask the person: VS Code's own pickers, dialogs and editor. */
export const vscodeBoardUi: BoardHostUi = {
	pick: async (items, placeholder) =>
		vscode.window.showQuickPick(items, { placeHolder: placeholder, matchOnDescription: true }),
	input: async (prompt, placeholder) => vscode.window.showInputBox({ prompt, placeHolder: placeholder, ignoreFocusOut: true }),
	ask: async ({ title, prompt, value, validate }) =>
		vscode.window.showInputBox({
			...(title ? { title } : {}),
			prompt,
			...(value !== undefined ? { value } : {}),
			...(validate ? { validateInput: validate } : {}),
		}),
	confirm: async (question, ...buttons) => vscode.window.showWarningMessage(question, { modal: true }, ...buttons),
	info: (message) => void vscode.window.showInformationMessage(message),
	error: (message) => void vscode.window.showErrorMessage(message),
	showFile: (path) =>
		void vscode.window.showTextDocument(vscode.Uri.file(path), { preview: true, viewColumn: vscode.ViewColumn.Beside }),
	relative: (path) => vscode.workspace.asRelativePath(path),
	openFile: async (defaultDir) =>
		(
			await vscode.window.showOpenDialog({
				canSelectMany: false,
				filters: { "Boards and plans": ["json"] },
				...(defaultDir ? { defaultUri: vscode.Uri.file(defaultDir) } : {}),
				openLabel: "Load",
			})
		)?.[0]?.fsPath,
	saveFile: async (defaultPath, options) =>
		(
			await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(defaultPath),
				filters: options?.filters ?? { Board: ["json"] },
				saveLabel: options?.label ?? "Export",
			})
		)?.fsPath,
	readFile: async (file) => Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(file))).toString("utf8"),
	writeFile: async (file, text) => vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(text, "utf8")),
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
	private readonly backend: BoardBackend
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
		this.backend = createBoardBackend({
			workspaceRoot: deps.workspaceRoot,
			...(deps.boards ? { boards: deps.boards } : {}),
			...(deps.catalog ? { catalog: deps.catalog } : {}),
			...(deps.runAction ? { runAction: deps.runAction } : {}),
			ui: deps.ui ?? vscodeBoardUi,
			onError: (message, error) => Logger.error(message, error),
		})
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
		const focus = this.focus
		// A focus is for the post that follows the open; later refreshes keep
		// whatever the person picked since.
		this.focus = undefined
		this.stale = false
		// The tab draws first, with the recent conversations as last read;
		// reading them again can take a while (owner, 2026-11-27: the tab sat
		// on "Reading the workspace…" while the history was read).
		await this.send(await this.backend.data({ ...(focus ? { focus } : {}), cachedOnly: true }))
		if (!this.deps.boards || !this.deps.workspaceRoot() || this.backend.recentIsFresh()) return
		const data = await this.backend.data({ cachedOnly: false })
		// A later post has drawn the tab since: it has the newer state.
		if (generation !== this.generation) return
		await this.send(data)
	}

	private async send(data: Awaited<ReturnType<BoardBackend["data"]>>): Promise<void> {
		await this.panel.webview.postMessage({ type: BOARD_VIEWER_DATA, data })
	}

	private receive(message: unknown): void {
		void this.backend.handle(message).then((answer) => {
			if (answer.ready) this.ready = true
			if (answer.reply) void this.panel.webview.postMessage(answer.reply)
			if (answer.ready) this.schedule(0)
			else if (answer.refresh) this.schedule(0)
		})
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
