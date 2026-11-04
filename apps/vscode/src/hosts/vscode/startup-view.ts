import * as vscode from "vscode"
import { getNonce } from "@/core/webview/getNonce"
import { Logger } from "@/shared/services/Logger"

/**
 * The sidebar's provider while the extension starts.
 *
 * The real provider exists only once `initialize` has run, and VS Code shows a
 * view whose provider is not registered as a blank panel with a spinner,
 * indefinitely and without a word. A start-up that threw or stalled looked
 * exactly like one still running (#112). Registered first thing in
 * `activate`, this resolves the view at once, hands it to the real provider
 * when that is ready, and otherwise says what happened and where the log is.
 *
 * It also lets start-up open the sidebar (worktree auto-open runs inside
 * `initialize`): the focus command no longer waits on a provider that is
 * registered only after it returns.
 */
export class StartupView implements vscode.WebviewViewProvider {
	private pending:
		| { view: vscode.WebviewView; context: vscode.WebviewViewResolveContext; token: vscode.CancellationToken }
		| undefined
	private provider: vscode.WebviewViewProvider | undefined
	private step = "starting"
	private failure: unknown
	private stalled = false
	private readonly startedAt = Date.now()
	private stallTimer: ReturnType<typeof setTimeout> | undefined

	constructor(
		private readonly logPaths: () => string[],
		private readonly stallMs = 20_000,
	) {
		this.stallTimer = setTimeout(() => this.stall(), this.stallMs)
	}

	resolveWebviewView(
		view: vscode.WebviewView,
		context: vscode.WebviewViewResolveContext,
		token: vscode.CancellationToken,
	): void | Thenable<void> {
		if (this.provider) {
			return this.provider.resolveWebviewView(view, context, token)
		}
		this.pending = { view, context, token }
		view.webview.options = { enableScripts: true }
		view.webview.onDidReceiveMessage((message) => {
			if (message?.type === "reload") {
				void vscode.commands.executeCommand("workbench.action.reloadWindow")
			}
		})
		view.onDidDispose(() => {
			if (this.pending?.view === view) {
				this.pending = undefined
			}
		})
		this.render()
	}

	/** Names the start-up step now running, for the stalled message. */
	setStep(step: string): void {
		this.step = step
		if (this.stalled && !this.provider && this.failure === undefined) {
			this.render()
		}
	}

	/** Start-up finished: the real provider takes the view, now and from here on. */
	async ready(provider: vscode.WebviewViewProvider): Promise<void> {
		this.clearStallTimer()
		this.provider = provider
		const pending = this.pending
		this.pending = undefined
		if (!pending) {
			return
		}
		try {
			await provider.resolveWebviewView(pending.view, pending.context, pending.token)
		} catch (error) {
			this.provider = undefined
			this.pending = pending
			this.fail(error)
		}
	}

	/** Start-up threw: say so in the view instead of leaving it blank. */
	fail(error: unknown): void {
		this.clearStallTimer()
		this.failure = error
		report(`start-up failed while ${this.step}`, error)
		this.render()
	}

	dispose(): void {
		this.clearStallTimer()
	}

	private stall(): void {
		this.stallTimer = undefined
		if (this.provider || this.failure !== undefined) {
			return
		}
		this.stalled = true
		report(`start-up still running after ${this.stallMs} ms, at: ${this.step}`)
		this.render()
	}

	private clearStallTimer(): void {
		if (this.stallTimer) {
			clearTimeout(this.stallTimer)
			this.stallTimer = undefined
		}
	}

	private render(): void {
		if (!this.pending) {
			return
		}
		this.pending.view.webview.html = startupHtml({
			failure: this.failure,
			stalled: this.stalled,
			step: this.step,
			seconds: Math.round((Date.now() - this.startedAt) / 1000),
			logPaths: this.logPaths(),
		})
	}
}

export function startupHtml(state: {
	failure: unknown
	stalled: boolean
	step: string
	seconds: number
	logPaths: string[]
}): string {
	const nonce = getNonce()
	const failed = state.failure !== undefined
	let body: string
	if (failed) {
		const err = state.failure
		const message = err instanceof Error ? err.message : String(err)
		const stack = err instanceof Error && err.stack ? err.stack.split("\n").slice(1, 8).join("\n") : ""
		body = `
			<h2>Cerebriline could not start</h2>
			<p>It failed while ${escapeHtml(state.step)}:</p>
			<pre>${escapeHtml(message)}${stack ? `\n${escapeHtml(stack)}` : ""}</pre>
			${logsHtml(state.logPaths)}
			<button id="reload">Reload Window</button>`
	} else if (state.stalled) {
		body = `
			<h2>Cerebriline is still starting</h2>
			<p>${state.seconds} s so far, at: ${escapeHtml(state.step)}.</p>
			<p>If this does not change, the cause is in the logs, and a reload starts it again.</p>
			${logsHtml(state.logPaths)}
			<button id="reload">Reload Window</button>`
	} else {
		body = "<p>Cerebriline is starting…</p>"
	}
	return /*html*/ `<!DOCTYPE html>
<html lang="en">
	<head>
		<meta charset="utf-8">
		<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
		<title>Cerebriline</title>
		<style>
			body { display: flex; flex-direction: column; gap: 10px; padding: 16px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
			h2 { margin: 0; font-size: 1.1em; }
			p { margin: 0; color: var(--vscode-descriptionForeground); }
			pre, code { font-family: var(--vscode-editor-font-family); font-size: 0.95em; }
			pre { margin: 0; padding: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background); }
			ul { margin: 0; padding-left: 18px; }
			button { align-self: flex-start; padding: 6px 14px; border: none; border-radius: 2px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-family: inherit; font-size: inherit; }
			button:hover { background: var(--vscode-button-hoverBackground); }
		</style>
	</head>
	<body>
		${body}
		<script nonce="${nonce}">
			const vscode = acquireVsCodeApi()
			document.getElementById("reload")?.addEventListener("click", () => vscode.postMessage({ type: "reload" }))
		</script>
	</body>
</html>`
}

function logsHtml(logPaths: string[]): string {
	const files = logPaths.map((p) => `<li><code>${escapeHtml(p)}</code></li>`).join("")
	return `<p>Logs:</p><ul>${files}<li>Output panel → <b>Extension Host</b></li><li>Help → Toggle Developer Tools → Console</li></ul>`
}

/**
 * Logger has no outputs until `initialize` subscribes them, so a step before
 * that would log nowhere; the console reaches the extension host's log.
 */
function report(message: string, error?: unknown): void {
	Logger.error(`[Cerebriline] ${message}`, error)
	// biome-ignore lint/plugin: Logger writes nowhere before initialize() subscribes its outputs, and these are the steps before it
	console.error(`[Cerebriline] ${message}`, error ?? "")
}

function escapeHtml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
