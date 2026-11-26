import { writeFileSync } from "node:fs"
import * as vscode from "vscode"
import { onBoardChanged } from "@/core/webview/board-viewer-hooks"
import { getNonce } from "@/core/webview/getNonce"
import { BOARD_VIEWER_DATA, type ViewerFocus, type ViewerRequest } from "@/shared/board-viewer"
import { collectViewerData } from "./collect"

/**
 * The board viewer (pipelines plan phase 3): an editor-area panel beside the
 * chat that draws the conversation's task board, the workspace's pipelines
 * and their runs. Read-only. It is the chat's own webview bundle, started
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
			? collectViewerData({ workspace, boardText: this.deps.boardText(), ...(focus ? { focus } : {}) })
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
