import { sendShowWebviewEvent } from "@core/controller/ui/subscribeToShowWebview"
import { WebviewProvider } from "@core/webview"
import * as vscode from "vscode"
import { handleGrpcRequest, handleGrpcRequestCancel } from "@/core/controller/grpc-handler"
import { getNonce } from "@/core/webview/getNonce"
import { HostProvider } from "@/hosts/host-provider"
import { ExtensionRegistryInfo } from "@/registry"
import { telemetryService } from "@/services/telemetry"
import type { ExtensionMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { WebviewMessage } from "@/shared/WebviewMessage"
import { setUndockedChatPanel } from "./undocked-chat"

/*
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/blob/main/default/weather-webview/src/providers/WeatherViewProvider.ts
https://github.com/KumarVariable/vscode-extension-sidebar-html/blob/master/src/customSidebarViewProvider.ts
*/

export class VscodeWebviewProvider extends WebviewProvider implements vscode.WebviewViewProvider {
	// Used in package.json as the view's id. This value cannot be changed due to how vscode caches
	// views based on their id, and updating the id would break existing instances of the extension.
	public static readonly SIDEBAR_ID = ExtensionRegistryInfo.views.Sidebar

	/** The `viewType` of the undocked chat's editor panel. Matches the `when` clauses in package.json. */
	public static readonly UNDOCKED_PANEL_ID = ExtensionRegistryInfo.views.UndockedChat

	private webview?: vscode.WebviewView
	private disposables: vscode.Disposable[] = []
	private hasResolvedView = false
	/**
	 * The chat as an editor tab in a window of its own, while undocked. There is
	 * one chat app at a time: undocked it runs here and the sidebar shows a
	 * placeholder, so the controller never has two views to keep in step.
	 */
	private panel?: vscode.WebviewPanel
	private panelDisposables: vscode.Disposable[] = []

	/** The webview the chat app is running in: the undocked panel if there is one, else the sidebar. */
	private get chatWebview(): vscode.Webview | undefined {
		return this.panel?.webview ?? this.webview?.webview
	}

	override getWebviewUrl(path: string) {
		const webview = this.chatWebview
		if (!webview) {
			throw new Error("Webview not initialized")
		}
		return webview.asWebviewUri(vscode.Uri.file(path)).toString()
	}

	override getCspSource() {
		const webview = this.chatWebview
		if (!webview) {
			throw new Error("Webview not initialized")
		}
		return webview.cspSource
	}

	override isVisible() {
		return this.panel ? this.panel.visible : this.webview?.visible || false
	}

	public get isUndocked(): boolean {
		return this.panel !== undefined
	}

	/**
	 * Bring the undocked chat forward. Returns false when the chat is docked,
	 * for a caller that then shows the sidebar as it always did.
	 */
	public revealUndocked(preserveFocus = false): boolean {
		if (!this.panel) {
			return false
		}
		this.panel.reveal(undefined, preserveFocus)
		return true
	}

	private chatHtml(): Promise<string> | string {
		return this.context.extensionMode === vscode.ExtensionMode.Development ? this.getHMRHtmlContent() : this.getHtmlContent()
	}

	/**
	 * Move the chat into a window of its own. VS Code has no call that opens a
	 * floating window, so the chat is opened as an editor tab and that tab is
	 * moved out with the workbench's own command. If the move is refused the
	 * chat stays as an editor tab, which still frees the sidebar.
	 */
	public async undock(): Promise<void> {
		if (this.panel) {
			this.panel.reveal()
			return
		}
		const panel = vscode.window.createWebviewPanel(
			VscodeWebviewProvider.UNDOCKED_PANEL_ID,
			"Cerebriline",
			{ viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.file(HostProvider.get().extensionFsPath)],
			},
		)
		this.panel = panel
		// The sidebar's first load clears stale task state. With the chat already
		// running here, a sidebar opened for the first time later must not.
		if (!this.hasResolvedView) {
			this.hasResolvedView = true
			this.controller.clearTask()
		}
		panel.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message), null, this.panelDisposables)
		panel.onDidDispose(
			() => {
				// Closing the window is docking.
				if (this.panel === panel) {
					void this.dock()
				}
			},
			null,
			this.panelDisposables,
		)
		setUndockedChatPanel(() => panel.viewColumn)
		await vscode.commands.executeCommand("setContext", ExtensionRegistryInfo.contextKeys.ChatUndocked, true)
		panel.webview.html = await this.chatHtml()
		if (this.webview) {
			this.webview.webview.html = this.getUndockedPlaceholderHtml()
		}
		try {
			await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow")
		} catch (error) {
			Logger.warn(`[VscodeWebviewProvider] Could not move the chat to its own window; it stays as an editor tab: ${error}`)
		}
		Logger.log("[VscodeWebviewProvider] Chat undocked")
	}

	/** Bring the chat back into the sidebar. The conversation is the controller's, so it carries on. */
	public async dock(): Promise<void> {
		const panel = this.panel
		if (!panel) {
			return
		}
		this.panel = undefined
		while (this.panelDisposables.length) {
			this.panelDisposables.pop()?.dispose()
		}
		setUndockedChatPanel(undefined)
		try {
			panel.dispose()
		} catch {
			// Already gone: docking was triggered by the window being closed.
		}
		await vscode.commands.executeCommand("setContext", ExtensionRegistryInfo.contextKeys.ChatUndocked, false)
		if (this.webview) {
			this.webview.webview.html = await this.chatHtml()
		}
		await vscode.commands.executeCommand(`${VscodeWebviewProvider.SIDEBAR_ID}.focus`)
		Logger.log("[VscodeWebviewProvider] Chat docked")
	}

	private getUndockedPlaceholderHtml(): string {
		const nonce = getNonce()
		return /*html*/ `
			<!DOCTYPE html>
			<html lang="en">
				<head>
					<meta charset="utf-8">
					<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
					<title>Cerebriline</title>
					<style>
						body { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 32px 16px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); text-align: center; }
						p { margin: 0; color: var(--vscode-descriptionForeground); }
						button { padding: 6px 14px; border: none; border-radius: 2px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font-family: inherit; font-size: inherit; }
						button:hover { background: var(--vscode-button-hoverBackground); }
					</style>
				</head>
				<body>
					<p>The chat is open in its own window.</p>
					<button id="dock">Dock chat here</button>
					<script nonce="${nonce}">
						const vscode = acquireVsCodeApi()
						document.getElementById("dock").addEventListener("click", () => vscode.postMessage({ type: "dock_chat" }))
					</script>
				</body>
			</html>
		`
	}

	public getWebview(): vscode.WebviewView | undefined {
		return this.webview
	}

	/**
	 * Initializes and sets up the webview when it's first created.
	 *
	 * @param webviewView - The sidebar webview view instance to be resolved
	 * @returns A promise that resolves when the webview has been fully initialized
	 */
	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		// A newer view supersedes any previous one (VS Code re-resolves this same
		// provider when the view is moved between sidebars). Release the previous
		// view's listeners up front in case its onDidDispose fired late or not at all.
		this.disposeView()
		this.webview = webviewView

		webviewView.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(HostProvider.get().extensionFsPath)],
		}

		// Undocked, the chat app is running in its own window; see `panel`.
		webviewView.webview.html = this.panel ? this.getUndockedPlaceholderHtml() : await this.chatHtml()

		// Sets up an event listener to listen for messages passed from the webview view context
		// and executes code based on the message that is received
		this.setWebviewMessageListener(webviewView.webview)
		telemetryService.capturePanelOpened("sidebar_resolved")

		// Logs show up in bottom panel > Debug Console
		//Logger.log("registering listener")

		// Listen for when the sidebar becomes visible
		// https://github.com/microsoft/vscode-discussions/discussions/840

		// onDidChangeVisibility is only available on the sidebar webview
		// Otherwise WebviewView and WebviewPanel have all the same properties except for this visibility listener
		// WebviewPanel is not currently used in the extension
		webviewView.onDidChangeVisibility(
			async () => {
				if (this.webview?.visible) {
					telemetryService.capturePanelOpened("sidebar_visible")
					// View becoming visible should not steal editor focus.
					await sendShowWebviewEvent(true)
				}
			},
			null,
			this.disposables,
		)

		// Listen for when the view is disposed. This happens when the user moves the
		// view between the primary and secondary sidebars: VS Code destroys the old
		// WebviewView and calls resolveWebviewView again on this same provider with a
		// new one. Only release view-scoped resources here — the controller must stay
		// alive so the re-resolved view keeps working. The controller is disposed on
		// extension deactivation (tearDown -> WebviewProvider.disposeAllInstances).
		webviewView.onDidDispose(
			() => {
				// resolveWebviewView awaits HTML generation, so an old view's dispose
				// event can arrive after a newer view has already been resolved. Only
				// tear down if this view is still the active one.
				if (this.webview === webviewView) {
					this.disposeView()
				}
			},
			null,
			this.disposables,
		)

		// Clear stale task state only when the view first loads after activation.
		// Re-resolves (e.g. the view moved between sidebars) must not terminate an
		// active task.
		if (!this.hasResolvedView) {
			this.hasResolvedView = true
			this.controller.clearTask()
		}

		Logger.log("[VscodeWebviewProvider] Webview view resolved")

		// Title setting logic removed to allow VSCode to use the container title primarily.
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * IMPORTANT: When passing methods as callbacks in JavaScript/TypeScript, the method's
	 * 'this' context can be lost. This happens because the method is passed as a
	 * standalone function reference, detached from its original object.
	 *
	 * The Problem:
	 * Doing: webview.onDidReceiveMessage(this.controller.handleWebviewMessage)
	 * Would cause 'this' inside handleWebviewMessage to be undefined or wrong,
	 * leading to "TypeError: this.setUserInfo is not a function"
	 *
	 * The Solution:
	 * We wrap the method call in an arrow function, which:
	 * 1. Preserves the lexical scope's 'this' binding
	 * 2. Ensures handleWebviewMessage is called as a method on the controller instance
	 * 3. Maintains access to all controller methods and properties
	 *
	 * Alternative solutions could use .bind() or making handleWebviewMessage an arrow
	 * function property, but this approach is clean and explicit.
	 *
	 * @param webview The webview instance to attach the message listener to
	 */
	private setWebviewMessageListener(webview: vscode.Webview) {
		webview.onDidReceiveMessage(
			(message) => {
				this.handleWebviewMessage(message)
			},
			null,
			this.disposables,
		)
	}

	/**
	 * Sets up an event listener to listen for messages passed from the webview context and
	 * executes code based on the message that is received.
	 *
	 * @param webview A reference to the extension webview
	 */
	async handleWebviewMessage(message: WebviewMessage) {
		const postMessageToWebview = (response: ExtensionMessage) => this.postMessageToWebview(response)

		switch (message.type) {
			case "grpc_request": {
				if (message.grpc_request) {
					await handleGrpcRequest(this.controller, postMessageToWebview, message.grpc_request)
				}
				break
			}
			case "grpc_request_cancel": {
				if (message.grpc_request_cancel) {
					await handleGrpcRequestCancel(postMessageToWebview, message.grpc_request_cancel)
				}
				break
			}
			case "dock_chat": {
				await this.dock()
				break
			}
			default: {
				Logger.error("Received unhandled WebviewMessage type:", JSON.stringify(message))
			}
		}
	}

	/**
	 * Sends a message from the extension to the webview.
	 *
	 * @param message - The message to send to the webview
	 * @returns A thenable that resolves to a boolean indicating success, or undefined if the webview is not available
	 */
	private async postMessageToWebview(message: ExtensionMessage): Promise<boolean | undefined> {
		return this.chatWebview?.postMessage(message)
	}

	/**
	 * Releases resources tied to the current WebviewView without tearing down the
	 * controller, so this provider can be re-resolved with a new WebviewView (e.g.
	 * when the user moves the view to the other sidebar).
	 */
	private disposeView() {
		// WebviewView doesn't have a dispose method, it's managed by VSCode
		// We just need to clean up our disposables
		while (this.disposables.length) {
			const x = this.disposables.pop()
			if (x) {
				x.dispose()
			}
		}
		this.webview = undefined
	}

	override async dispose() {
		const panel = this.panel
		this.panel = undefined
		while (this.panelDisposables.length) {
			this.panelDisposables.pop()?.dispose()
		}
		setUndockedChatPanel(undefined)
		panel?.dispose()
		this.disposeView()
		await super.dispose()
	}
}
