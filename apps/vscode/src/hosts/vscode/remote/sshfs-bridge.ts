/**
 * The SSH FS → Remote-SSH bridge.
 *
 * A folder opened with SSH FS (`ssh://<config>/<path>`) is served over SFTP to
 * the extension host on this computer, where Cerebriline's tools also run:
 * they read, edit and execute on this computer, and the folder's path names a
 * directory that does not exist here. Remote-SSH instead runs the extension
 * host on the remote machine, which is where the tools have to be. So when an
 * SSH FS folder is open, Cerebriline offers to reopen it with Remote-SSH,
 * adding the OpenSSH host entry built from the SSH FS config to the user's SSH
 * config file -- after showing it, and only if the user agrees.
 *
 * Config resolution: sshfs-config.ts. Entry building: ssh-config-entry.ts.
 */

import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import JSON5 from "json5"
import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import { appendMissingEntries, buildSshBridgePlan, type SshBridgePlan } from "./ssh-config-entry"
import { applySshFsLayers, resolveSshFsConnection, SshFsConfigError } from "./sshfs-config"

export const SSHFS_SCHEME = "ssh"
const REMOTE_SSH_EXTENSION_ID = "ms-vscode-remote.remote-ssh"

export function sshFsFolders(): vscode.WorkspaceFolder[] {
	return (vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === SSHFS_SCHEME)
}

/** Configs from one `configpaths` location: a JSON(C) file, or a folder of them. */
async function readConfigLocation(uri: vscode.Uri): Promise<unknown[]> {
	const parse = async (file: vscode.Uri): Promise<unknown[]> => {
		try {
			const parsed = JSON5.parse(Buffer.from(await vscode.workspace.fs.readFile(file)).toString("utf8"))
			return Array.isArray(parsed) ? parsed : []
		} catch (error) {
			Logger.warn(`[sshfs-bridge] Could not read SSH FS config file ${file.toString()}:`, error)
			return []
		}
	}
	try {
		const stat = await vscode.workspace.fs.stat(uri)
		if (stat.type & vscode.FileType.Directory) {
			const files = await vscode.workspace.fs.readDirectory(uri)
			const configs = await Promise.all(
				files
					.filter(([name, type]) => type & vscode.FileType.File && (name.endsWith(".json") || name.endsWith(".jsonc")))
					.map(([name]) => parse(vscode.Uri.joinPath(uri, name))),
			)
			return configs.flat()
		}
		return await parse(uri)
	} catch {
		return []
	}
}

/** An absolute `configpaths` entry as a URI; relative ones resolve against `base` when given. */
function configLocationUri(location: string, base?: vscode.Uri): vscode.Uri | undefined {
	if (/^[a-zA-Z0-9+.-]+:\/\//.test(location)) {
		return vscode.Uri.parse(location)
	}
	if (path.isAbsolute(location)) {
		return vscode.Uri.file(location)
	}
	return base ? vscode.Uri.joinPath(base, location) : undefined
}

/** SSH FS's config layers, most important first: folders, workspace, user. */
async function loadSshFsLayers(): Promise<unknown[][]> {
	const read = async (locations: readonly string[] | undefined, base?: vscode.Uri): Promise<unknown[]> => {
		const uris = (locations ?? []).map((l) => configLocationUri(l, base)).filter((u): u is vscode.Uri => !!u)
		return (await Promise.all(uris.map(readConfigLocation))).flat()
	}
	const configs = vscode.workspace.getConfiguration("sshfs").inspect<unknown[]>("configs")
	const paths = vscode.workspace.getConfiguration("sshfs").inspect<string[]>("configpaths")

	const folderLayer: unknown[] = []
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		const scoped = vscode.workspace.getConfiguration("sshfs", folder)
		folderLayer.push(...(scoped.inspect<unknown[]>("configs")?.workspaceFolderValue ?? []))
		const folderPaths = scoped.inspect<string[]>("configpaths")
		// Relative entries at any level resolve against each open folder.
		const relative = [
			...(folderPaths?.globalValue ?? []),
			...(folderPaths?.workspaceValue ?? []),
			...(folderPaths?.workspaceFolderValue ?? []),
		].filter((l) => !path.isAbsolute(l) && !/^[a-zA-Z0-9+.-]+:\/\//.test(l))
		folderLayer.push(...(await read(relative, folder.uri)))
	}
	const workspaceLayer = [...(configs?.workspaceValue ?? []), ...(await read(paths?.workspaceValue))]
	const globalLayer = [...(configs?.globalValue ?? []), ...(await read(paths?.globalValue))]
	return [folderLayer, workspaceLayer, globalLayer]
}

/** The SSH config file Remote-SSH reads: its `remote.SSH.configFile`, else ~/.ssh/config. */
export function sshConfigFilePath(): string {
	const configured = vscode.workspace.getConfiguration("remote.SSH").get<string>("configFile")?.trim()
	if (configured) {
		return configured.startsWith("~") ? path.join(os.homedir(), configured.slice(1)) : configured
	}
	return path.join(os.homedir(), ".ssh", "config")
}

async function planFor(folder: vscode.WorkspaceFolder): Promise<SshBridgePlan> {
	const configs = applySshFsLayers(await loadSshFsLayers())
	const localUser = (() => {
		try {
			return os.userInfo().username
		} catch {
			return ""
		}
	})()
	return buildSshBridgePlan(folder.uri.authority, (name) => resolveSshFsConnection(configs, name, process.env, localUser), {
		platform: process.platform,
		defaultAgent: process.env.SSH_AUTH_SOCK,
	})
}

async function readTextOrEmpty(file: string): Promise<string> {
	try {
		return await fs.readFile(file, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return ""
		}
		throw error
	}
}

/** The folder's Remote-SSH URI: same path, served by the alias's host. */
export function remoteSshFolderUri(alias: string, folder: vscode.Uri): vscode.Uri {
	return vscode.Uri.from({ scheme: "vscode-remote", authority: `ssh-remote+${alias}`, path: folder.path || "/" })
}

/**
 * Reopen an SSH FS folder with Remote-SSH: build the host entry, show it, add
 * it to the SSH config file when the user agrees, then open the folder.
 */
export async function reopenWithRemoteSsh(folder: vscode.WorkspaceFolder): Promise<void> {
	if (!vscode.extensions.getExtension(REMOTE_SSH_EXTENSION_ID)) {
		const choice = await vscode.window.showWarningMessage(
			"Remote - SSH is not installed. Install it to open this folder on its host.",
			"Show Remote - SSH",
		)
		if (choice) {
			await vscode.commands.executeCommand("extension.open", REMOTE_SSH_EXTENSION_ID)
		}
		return
	}

	let plan: SshBridgePlan
	try {
		plan = await planFor(folder)
	} catch (error) {
		const message = error instanceof SshFsConfigError ? error.message : `Could not read the SSH FS config: ${String(error)}`
		await vscode.window.showErrorMessage(message)
		return
	}

	const configFile = sshConfigFilePath()
	let current: string
	try {
		current = await readTextOrEmpty(configFile)
	} catch (error) {
		await vscode.window.showErrorMessage(`Could not read ${configFile}: ${String(error)}`)
		return
	}
	const { text, added, existing } = appendMissingEntries(current, plan.entries)
	const entriesText = plan.entries
		.filter((e) => added.includes(e.alias))
		.map((e) => e.text)
		.join("\n")
	const notes = plan.notes.length ? `\n\n${plan.notes.join("\n\n")}` : ""
	const kept = existing.length
		? `\n\nAlready in the file and used as written: ${existing.map((a) => `Host ${a}`).join(", ")}.`
		: ""

	if (added.length > 0) {
		const choice = await vscode.window.showInformationMessage(
			`Add ${added.length === 1 ? "this entry" : "these entries"} to ${configFile} and reopen "${folder.name}" with Remote-SSH?`,
			{ modal: true, detail: `${entriesText}${kept}${notes}` },
			"Add and Reopen",
			"Copy Entry",
		)
		if (choice === "Copy Entry") {
			await vscode.env.clipboard.writeText(entriesText)
			return
		}
		if (choice !== "Add and Reopen") {
			return
		}
		try {
			await fs.mkdir(path.dirname(configFile), { recursive: true })
			// The mode applies only when the file is created; an existing file keeps its own.
			await fs.writeFile(configFile, text, { encoding: "utf8", mode: 0o600 })
		} catch (error) {
			await vscode.window.showErrorMessage(`Could not write ${configFile}: ${String(error)}`)
			return
		}
	} else {
		const choice = await vscode.window.showInformationMessage(
			`Reopen "${folder.name}" with Remote-SSH through Host ${plan.alias}?`,
			{ modal: true, detail: `${kept.trim()}${notes}` },
			"Reopen",
		)
		if (choice !== "Reopen") {
			return
		}
	}

	// Opening a single folder replaces the window's workspace; with other
	// folders open, a new window keeps them.
	const forceNewWindow = (vscode.workspace.workspaceFolders?.length ?? 0) > 1
	await vscode.commands.executeCommand("vscode.openFolder", remoteSshFolderUri(plan.alias, folder.uri), { forceNewWindow })
}

/** The command: pick the SSH FS folder when there are several. */
async function runReopenCommand(): Promise<void> {
	const folders = sshFsFolders()
	if (folders.length === 0) {
		await vscode.window.showInformationMessage("No folder in this window is opened through SSH FS.")
		return
	}
	const folder =
		folders.length === 1
			? folders[0]
			: (
					await vscode.window.showQuickPick(
						folders.map((f) => ({ label: f.name, description: f.uri.toString(), folder: f })),
						{ placeHolder: "Folder to reopen with Remote-SSH" },
					)
				)?.folder
	if (folder) {
		await reopenWithRemoteSsh(folder)
	}
}

/**
 * Register the command and offer the bridge for each SSH FS folder, once per
 * window, unless the user turned it off for that config.
 */
export function registerSshFsBridge(context: vscode.ExtensionContext, commandId: string): void {
	context.subscriptions.push(vscode.commands.registerCommand(commandId, runReopenCommand))

	// In a remote window the extension host is already on a remote machine;
	// an ssh:// folder there is not this bridge's case.
	if (vscode.env.remoteName) {
		return
	}
	const offered = new Set<string>()
	const offer = (): void => {
		const dismissed = StateManager.get().getGlobalStateKey("sshFsBridgeDismissed") ?? []
		for (const folder of sshFsFolders()) {
			const name = folder.uri.authority.toLowerCase()
			if (offered.has(folder.uri.toString()) || dismissed.includes(name)) {
				continue
			}
			offered.add(folder.uri.toString())
			void vscode.window
				.showWarningMessage(
					`"${folder.name}" is opened through SSH FS, so Cerebriline's tools run on this computer: they cannot read, edit or run anything on its host. Reopen it with Remote-SSH to let them work there.`,
					"Reopen with Remote-SSH",
					"Don't Show Again",
				)
				.then(async (choice) => {
					if (choice === "Reopen with Remote-SSH") {
						await reopenWithRemoteSsh(folder)
					} else if (choice === "Don't Show Again") {
						const state = StateManager.get()
						const current = state.getGlobalStateKey("sshFsBridgeDismissed") ?? []
						state.setGlobalState("sshFsBridgeDismissed", [...new Set([...current, name])])
					}
				})
		}
	}
	offer()
	context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(offer))
}
