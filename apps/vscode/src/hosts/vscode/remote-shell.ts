import { createServer } from "node:http"
import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
import { readRemoteTerminalsConfig } from "@/sdk/remote-terminals-config"
import {
	createPkce,
	createShellSession,
	deleteShellSession,
	enterFolderCommand,
	exchangeSignIn,
	normalizeBaseUrl,
	type OpenWebUiSession,
	RemoteShellConnection,
	refreshSignIn,
	requestSignIn,
	type ShellSocket,
	shellSocketUrl,
	tokenIsFresh,
} from "@/shared/remote-shell"
import { parseRemoteWorkspaces } from "@/shared/remote-terminals"

/**
 * "Open a shell on a remote terminal": a terminal tab the user types into, on
 * one of the remote terminals, in the same account the model uses and, when
 * picked, in one conversation's folder. Separate from the read-only tab that
 * shows what the model runs.
 *
 * The sign-in it needs is kept in VS Code's secret storage, never in settings.
 */

const SECRET_KEY = "cerebriline.openWebUiSession"
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

let secrets: vscode.SecretStorage | undefined
let refreshing: Promise<OpenWebUiSession> | undefined

async function readSession(baseUrl: string): Promise<OpenWebUiSession | undefined> {
	const raw = await secrets?.get(SECRET_KEY)
	if (!raw) return undefined
	try {
		const session = JSON.parse(raw) as OpenWebUiSession
		return session.baseUrl === normalizeBaseUrl(baseUrl) ? session : undefined
	} catch {
		return undefined
	}
}

async function storeSession(session: OpenWebUiSession | undefined) {
	if (!secrets) return
	if (session) await secrets.store(SECRET_KEY, JSON.stringify(session))
	else await secrets.delete(SECRET_KEY)
}

const callbackPage = (title: string, text: string) =>
	`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3rem;max-width:36rem"><h1 style="font-size:1.3rem">${title}</h1><p>${text}</p></body>`

/** The browser sign-in: Open WebUI asks the user to approve, then sends a code to a port on this machine. */
async function signIn(baseUrl: string): Promise<OpenWebUiSession> {
	const pkce = createPkce()
	return vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: "Approve the Cerebriline sign-in in your browser",
			cancellable: true,
		},
		(_progress, cancel) =>
			new Promise<OpenWebUiSession>((resolve, reject) => {
				let settled = false
				const server = createServer()
				const finish = (error: Error | undefined, session?: OpenWebUiSession) => {
					if (settled) return
					settled = true
					clearTimeout(timer)
					server.close()
					if (error) reject(error)
					else resolve(session as OpenWebUiSession)
				}
				const timer = setTimeout(
					() => finish(new Error("The sign-in was not approved within 5 minutes.")),
					SIGN_IN_TIMEOUT_MS,
				)
				cancel.onCancellationRequested(() => finish(new Error("Sign-in cancelled.")))
				let pending: { sessionId: string; redirectUri: string } | undefined
				server.on("request", (request, response) => {
					const url = new URL(request.url ?? "/", "http://127.0.0.1")
					if (url.pathname !== "/callback") {
						response.writeHead(404).end()
						return
					}
					const code = url.searchParams.get("code")
					if (!pending || url.searchParams.get("state") !== pkce.state || !code) {
						response
							.writeHead(400, { "Content-Type": "text/html" })
							.end(callbackPage("Sign-in refused", "This answer does not match the sign-in Cerebriline started."))
						return
					}
					const { sessionId, redirectUri } = pending
					exchangeSignIn(baseUrl, sessionId, code, pkce, redirectUri)
						.then((session) => {
							response
								.writeHead(200, { "Content-Type": "text/html" })
								.end(callbackPage("Cerebriline is signed in", "You can close this tab and go back to VS Code."))
							finish(undefined, session)
						})
						.catch((error: Error) => {
							response
								.writeHead(400, { "Content-Type": "text/html" })
								.end(callbackPage("Sign-in failed", error.message))
							finish(error)
						})
				})
				server.on("error", (error) => finish(error))
				server.listen(0, "127.0.0.1", async () => {
					try {
						const address = server.address()
						const port = typeof address === "object" && address ? address.port : 0
						const redirectUri = `http://127.0.0.1:${port}/callback`
						const started = await requestSignIn(
							baseUrl,
							redirectUri,
							pkce,
							`Cerebriline (VS Code, ${vscode.env.appName})`,
						)
						pending = { sessionId: started.sessionId, redirectUri }
						await vscode.env.openExternal(vscode.Uri.parse(started.approveUrl))
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)))
					}
				})
			}),
	)
}

/** A token good for at least a minute: the stored one, a refreshed one, or a new sign-in. */
async function freshSession(baseUrl: string, allowSignIn: boolean): Promise<OpenWebUiSession> {
	const stored = await readSession(baseUrl)
	if (stored && tokenIsFresh(stored)) return stored
	if (stored && stored.refreshExpiresAt > Date.now() / 1000) {
		// One refresh at a time: the refresh token changes on every use.
		refreshing ??= refreshSignIn(stored).finally(() => {
			refreshing = undefined
		})
		try {
			const session = await refreshing
			await storeSession(session)
			return session
		} catch {
			await storeSession(undefined)
		}
	}
	if (!allowSignIn) throw new Error("The Open WebUI sign-in ended; open the shell again to sign in.")
	const session = await signIn(baseUrl)
	await storeSession(session)
	return session
}

function openSocket(url: string): ShellSocket {
	const WebSocketImpl = (globalThis as { WebSocket?: new (url: string) => ShellSocket }).WebSocket
	if (!WebSocketImpl) throw new Error("This VS Code has no WebSocket support; update VS Code.")
	return new WebSocketImpl(url)
}

interface FolderPick extends vscode.QuickPickItem {
	path?: string
}

function folderChoices(machineId: string): FolderPick[] {
	const state = StateManager.get()
	const titles = new Map<string, string>(
		((state.getGlobalStateKey("taskHistory") ?? []) as Array<{ id: string; task?: string }>).map((item) => [
			item.id,
			(item.task ?? "").split("\n")[0].slice(0, 80),
		]),
	)
	const folders = parseRemoteWorkspaces(state.getGlobalStateKey("remoteWorkspaces"))
		.filter((entry) => entry.machineId === machineId && entry.deletedAt === undefined && entry.path)
		.sort((a, b) => b.firstUsed - a.firstUsed)
		.map((entry) => ({
			label: titles.get(entry.workspaceId) || entry.workspaceId,
			description: entry.path,
			detail: entry.firstUsed ? `first used ${new Date(entry.firstUsed).toLocaleString()}` : undefined,
			path: entry.path,
		}))
	return [{ label: "Account home folder", description: "where a new login starts" }, ...folders]
}

export async function openRemoteShell(): Promise<void> {
	const config = readRemoteTerminalsConfig()
	if (!config?.openWebUiUrl?.trim()) {
		void vscode.window.showWarningMessage(
			"Turn on remote terminals and set the Open WebUI address in Cerebriline's settings first.",
		)
		return
	}
	const machines = config.terminals
	if (machines.length === 0) {
		void vscode.window.showWarningMessage(
			"No remote terminals are offered: add one, or refresh from Open WebUI, in Cerebriline's settings.",
		)
		return
	}
	const machine =
		machines.length === 1
			? machines[0]
			: (
					await vscode.window.showQuickPick(
						machines.map((terminal) => ({
							label: terminal.name,
							description: terminal.machineId !== terminal.name ? terminal.machineId : undefined,
							detail: terminal.description,
							terminal,
						})),
						{ title: "Open a shell on which remote terminal?" },
					)
				)?.terminal
	if (!machine) return
	const folder = await vscode.window.showQuickPick(folderChoices(machine.machineId), {
		title: `Start the shell on ${machine.name} in`,
		matchOnDescription: true,
	})
	if (!folder) return

	const baseUrl = normalizeBaseUrl(config.openWebUiUrl)
	let shellId: string
	try {
		const session = await freshSession(baseUrl, true)
		shellId = await createShellSession(baseUrl, machine.machineId, session.token)
	} catch (error) {
		void vscode.window.showErrorMessage(
			`Could not open a shell on ${machine.name}: ${error instanceof Error ? error.message : String(error)}`,
		)
		return
	}

	const write = new vscode.EventEmitter<string>()
	const notice = (text: string) => write.fire(`\r\n\x1b[2m[${text}]\x1b[0m\r\n`)
	const connection = new RemoteShellConnection({
		url: shellSocketUrl(baseUrl, machine.machineId, shellId),
		getToken: async () => {
			const session = await freshSession(baseUrl, false)
			return { token: session.token, expiresAt: session.expiresAt }
		},
		openSocket,
		onOutput: (text) => write.fire(text),
		onNotice: notice,
		onEnded: (reason) => notice(`shell ended: ${reason}`),
	})
	const pty: vscode.Pseudoterminal = {
		onDidWrite: write.event,
		open: (dimensions) => {
			if (dimensions) connection.resize(dimensions.columns, dimensions.rows)
			connection
				.connect()
				.catch((error) => notice(`could not connect: ${error instanceof Error ? error.message : String(error)}`))
			if (folder.path) connection.input(enterFolderCommand(folder.path))
		},
		close: () => {
			connection.close()
			write.dispose()
			// The shell would otherwise keep running on the machine, detached.
			void freshSession(baseUrl, false)
				.then((session) => deleteShellSession(baseUrl, machine.machineId, shellId, session.token))
				.catch(() => {})
		},
		handleInput: (data) => connection.input(data),
		setDimensions: (dimensions) => connection.resize(dimensions.columns, dimensions.rows),
	}
	const terminal = vscode.window.createTerminal({
		name: `${machine.name} (shell)`,
		pty,
		iconPath: new vscode.ThemeIcon("terminal-linux"),
	})
	terminal.show()
}

export async function signOutOfOpenWebUi(): Promise<void> {
	const raw = await secrets?.get(SECRET_KEY)
	await storeSession(undefined)
	void vscode.window.showInformationMessage(
		raw
			? "Cerebriline signed out of Open WebUI here. The sign-in also ends on its own when it is not used."
			: "Cerebriline was not signed in to Open WebUI.",
	)
}

export function registerRemoteShell(context: vscode.ExtensionContext, openCommand: string, signOutCommand: string): void {
	secrets = context.secrets
	context.subscriptions.push(
		vscode.commands.registerCommand(openCommand, () => openRemoteShell()),
		vscode.commands.registerCommand(signOutCommand, () => signOutOfOpenWebUi()),
	)
}
