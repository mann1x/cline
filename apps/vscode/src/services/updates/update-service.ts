/**
 * The VS Code half of the updater: ask, download, install, reload.
 *
 * Deliberately thin. Every decision that can be wrong in a way that looks like
 * working lives in `update-check.ts`, which is pure and tested; what is left
 * here is notifications and one command call, and it is the part that cannot
 * be unit-tested because it IS the editor.
 *
 * `workbench.extensions.installExtension` accepts a `Uri` to a `.vsix` as well
 * as a gallery id. It is a registered command rather than typed public API, so
 * it is called through `executeCommand` and every call is wrapped: if a future
 * VS Code withdraws it, the user is handed the downloaded file and the release
 * page instead of an error, which is exactly what they would have done by hand
 * anyway.
 *
 * The download goes to the extension's own global storage, never the system
 * temp directory. A `.vsix` is ~14 MB, `/tmp` is RAM-backed on at least one
 * machine this runs beside, and globalStorage is writable on every platform
 * without a permissions question. It is removed once the install is done.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { StateManager } from "@core/storage/StateManager"
import { asUpdateChannel } from "@shared/UpdateSettings"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import { DEFAULT_CHECK_INTERVAL_MS, decideUpdate, parseLatestRelease, shouldCheckNow, type UpdateChannel } from "./update-check"
import { downloadVsix } from "./update-download"
import { readUpdateState, writeUpdateState } from "./update-state"

const RELEASES_API = "https://api.github.com/repos/mann1x/cline/releases/latest"

/**
 * The activation context, kept so the webview's banner can install.
 *
 * A module-level binding rather than a parameter threaded through the gRPC
 * layer: the controller handler is host-agnostic by convention and has no
 * `ExtensionContext` to give, and there is exactly one extension host per
 * window, so there is exactly one right answer here.
 */
let activeContext: vscode.ExtensionContext | undefined

/** Long enough not to compete with activation, short enough to be this session. */
const FIRST_CHECK_DELAY_MS = 20_000

/**
 * Read from the plugin's own settings store, which is where the panel writes.
 *
 * Not `workspace.getConfiguration`. This was a `contributes.configuration`
 * entry first, and that would have left the General tab's dropdown and VS
 * Code's settings UI writing to two different places -- which is how a feature
 * ends up on in one and off in the other with nothing to say which won.
 */
function channelOf(): UpdateChannel {
	try {
		return asUpdateChannel(StateManager.get().getGlobalSettingsKey("updateChannel"))
	} catch {
		// The scheduled check is armed during activation and fires 20 seconds
		// later; if the store is somehow not up by then, the default is the
		// right answer rather than a thrown timer callback.
		return "notify"
	}
}

async function readLatest(): Promise<unknown> {
	const response = await fetch(RELEASES_API, {
		headers: {
			accept: "application/vnd.github+json",
			// Unauthenticated, so this is 60 requests an hour per IP shared with
			// everything else on the machine. The throttle above is what keeps
			// us well inside it; the header is so a rate-limit page in GitHub's
			// logs has something to blame.
			"user-agent": "cerebriline-update-check",
		},
	})
	if (!response.ok) {
		throw new Error(`GitHub answered ${response.status} ${response.statusText}`.trimEnd())
	}
	return await response.json()
}

async function installDownloaded(vsixPath: string, version: string): Promise<boolean> {
	try {
		await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(vsixPath))
		return true
	} catch (error) {
		Logger.error(`[Updates] installing ${version} failed`, error instanceof Error ? error : new Error(String(error)))
		const choice = await vscode.window.showErrorMessage(
			`Cerebriline ${version} downloaded but could not be installed automatically. The file is ready to install by hand.`,
			"Show the file",
		)
		if (choice === "Show the file") {
			await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(vsixPath))
		}
		return false
	}
}

async function offerReload(version: string): Promise<void> {
	const choice = await vscode.window.showInformationMessage(
		`Cerebriline ${version} is installed. Reload the window to start using it.`,
		"Reload Window",
		"Later",
	)
	if (choice === "Reload Window") {
		await vscode.commands.executeCommand("workbench.action.reloadWindow")
	}
}

async function runUpdate(
	context: vscode.ExtensionContext,
	release: { version: string; notesUrl: string; asset?: { name: string; url: string; size: number; sha256?: string } },
): Promise<void> {
	const asset = release.asset
	if (!asset) {
		return
	}
	const directory = path.join(context.globalStorageUri.fsPath, "updates")
	const target = path.join(directory, asset.name)
	await fs.mkdir(directory, { recursive: true })

	const result = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: `Downloading Cerebriline ${release.version}…` },
		() =>
			downloadVsix(asset, target, {
				fetch: (url) => fetch(url),
				writeFile: (file, body) => fs.writeFile(file, body),
				remove: (file) => fs.rm(file, { force: true }),
			}),
	)

	if (!result.ok) {
		Logger.warn(`[Updates] ${release.version} was not installed: ${result.reason}`)
		const choice = await vscode.window.showErrorMessage(
			`Cerebriline ${release.version} was not installed: ${result.reason}`,
			"Open the release",
		)
		if (choice === "Open the release" && release.notesUrl) {
			await vscode.env.openExternal(vscode.Uri.parse(release.notesUrl))
		}
		return
	}
	if (!result.verified) {
		// Said out loud rather than swallowed: the release carried no hash, so
		// what was installed is whatever the connection produced.
		Logger.warn(`[Updates] ${release.version} carried no published hash; it was installed unverified`)
	}

	const installed = await installDownloaded(result.path, release.version)
	if (installed) {
		await fs.rm(result.path, { force: true }).catch(() => undefined)
		// The banner has served its purpose; leaving it up would advertise a
		// version that is now installed and waiting for a reload.
		await rememberAvailable("")
		await offerReload(release.version)
	}
}

/** Put what the check found where the panel can read it. */
async function rememberAvailable(version: string): Promise<void> {
	try {
		const state = StateManager.get()
		if (state.getGlobalSettingsKey("availableUpdate") === version) {
			return
		}
		state.setGlobalState("availableUpdate", version)
	} catch {
		// Before the store is up, or after it is gone. The check still works;
		// only the banner is missed.
	}
}

/**
 * Install whatever the last check found. The home-page banner's button.
 *
 * Re-reads the release rather than trusting the remembered version: the stored
 * string survives a restart, and installing from a stale note is how someone
 * ends up being handed a version that has since been replaced.
 */
export async function installAvailableUpdate(): Promise<void> {
	const context = activeContext
	if (!context) {
		return
	}
	await checkForUpdates(context, { manual: true, install: true })
}

/**
 * @param manual A check the user asked for: ignores the throttle, and says so
 * when there is nothing to report. The scheduled check stays silent instead,
 * because a daily "you are up to date" is a daily interruption.
 */
export async function checkForUpdates(
	context: vscode.ExtensionContext,
	options: { manual?: boolean; install?: boolean } = {},
): Promise<void> {
	const channel = channelOf()
	const current = String(context.extension.packageJSON.version ?? "0.0.0")
	const extensionName = String(context.extension.packageJSON.name ?? "cerebriline")

	if (channel === "off" && !options.manual) {
		return
	}
	const storagePath = context.globalStorageUri.fsPath
	const state = await readUpdateState(storagePath)
	if (
		!options.manual &&
		!shouldCheckNow({
			channel,
			now: Date.now(),
			...(state.lastCheckedAt !== undefined ? { lastCheckedAt: state.lastCheckedAt } : {}),
			intervalMs: DEFAULT_CHECK_INTERVAL_MS,
		})
	) {
		return
	}

	let latest: ReturnType<typeof parseLatestRelease>
	try {
		latest = parseLatestRelease(await readLatest(), extensionName)
		await writeUpdateState(storagePath, { ...state, lastCheckedAt: Date.now() })
	} catch (error) {
		// Offline, rate-limited, or GitHub is down. None of those is the user's
		// problem and none of them is worth a popup on a scheduled check.
		Logger.debug(`[Updates] check failed: ${error instanceof Error ? error.message : String(error)}`)
		if (options.manual) {
			await vscode.window.showWarningMessage(
				`Could not check for updates: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
		return
	}

	const decision = decideUpdate({
		channel: options.manual && channel === "off" ? "notify" : channel,
		current,
		latest,
		...(state.skippedVersion !== undefined ? { skippedVersion: state.skippedVersion } : {}),
	})

	// Remembered before anything is offered, so the home-page banner is there
	// whether or not anyone was at the keyboard for the notification.
	await rememberAvailable(decision.kind === "offer" ? decision.release.version : "")

	if (decision.kind === "offer" && (decision.install || options.install)) {
		await runUpdate(context, decision.release)
		return
	}
	if (decision.kind === "offer") {
		const choice = await vscode.window.showInformationMessage(
			`Cerebriline ${decision.release.version} is available. You are on ${current}.`,
			"Install",
			"Release notes",
			"Skip this version",
		)
		if (choice === "Install") {
			await runUpdate(context, decision.release)
		} else if (choice === "Release notes" && decision.release.notesUrl) {
			await vscode.env.openExternal(vscode.Uri.parse(decision.release.notesUrl))
		} else if (choice === "Skip this version") {
			await writeUpdateState(storagePath, { ...state, lastCheckedAt: Date.now(), skippedVersion: decision.release.version })
		}
		return
	}
	if (!options.manual) {
		return
	}
	if (decision.kind === "no-asset") {
		await vscode.window.showWarningMessage(
			`Cerebriline ${decision.version} is released but has no .vsix attached yet. Try again shortly.`,
		)
		return
	}
	await vscode.window.showInformationMessage(`Cerebriline ${current} is the latest release.`)
}

/**
 * Arm the scheduled check.
 *
 * One check per activation, delayed, and then the throttle in `shouldCheckNow`
 * decides whether it does anything. There is no interval timer: a window that
 * stays open for a week is not the case worth serving, and a timer is a
 * disposable that has to be got right for no benefit.
 */
export function registerUpdateChecks(context: vscode.ExtensionContext): void {
	activeContext = context
	const timer = setTimeout(() => {
		void checkForUpdates(context)
	}, FIRST_CHECK_DELAY_MS)
	context.subscriptions.push(new vscode.Disposable(() => clearTimeout(timer)))
}
