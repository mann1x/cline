// A Cerebriline panel that never loads, and the VS Code cache behind it.
//
// "Error loading webview provided by 'mann1x.cerebriline': Could not register
// service worker: InvalidStateError: ... The document is in an invalid state"
// is VS Code's, not ours: every webview runs inside a frame that registers a
// service worker, and when the workbench's service worker cache
// (`<user data>/Service Worker`) has gone bad that registration fails and the
// panel stays empty. Chris hit it in October, pandorum on 2026-11-25 with a
// cache whose oldest part dated from April 2024; deleting the folder with VS
// Code closed fixed it, and VS Code rebuilt it on the next start.
//
// The error itself never reaches the extension. What does is its shape: the
// view resolves, the page is set, and the app inside it never sends a single
// message (it subscribes to state as soon as it mounts). The watchdog here
// turns that silence into a prompt. The cache cannot be cleared from inside:
// VS Code has it open. So the fix is a small detached script that waits for
// VS Code to exit, deletes the folder, starts VS Code again and leaves a log
// that the next start writes to the Cerebriline output.

import { execFile, spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"

/** How long a freshly set page may stay silent before it counts as not loaded. */
export const WEBVIEW_CONTACT_TIMEOUT_MS = 25_000

/** How long the script waits for VS Code to exit before giving up untouched. */
const QUIT_WAIT_SECONDS = 600

const PURGE_LOG = "webview-cache-purge.log"

/**
 * What these functions need of the extension's context: VS Code's own, or the
 * provider's `ClineExtensionContext`, which both have.
 */
export interface CacheContext {
	readonly globalStorageUri: { readonly fsPath: string }
	readonly extension: { readonly extensionKind: unknown }
}

/**
 * Waits for a newly loaded page to say anything. `arm` when a page is set,
 * `contact` on every message from it, `shown` when its view becomes visible.
 * A page that is hidden when the time runs out gets a fresh timeout once it is
 * shown, since a hidden page may not have been given the chance to load.
 */
export class WebviewLoadWatchdog {
	private timer: ReturnType<typeof setTimeout> | undefined
	private contacted = true
	private waitingForVisible = false
	private stalled = false
	private armedAt = 0

	constructor(
		private readonly isVisible: () => boolean,
		private readonly onStall: (waitedMs: number) => void,
		private readonly timeoutMs = WEBVIEW_CONTACT_TIMEOUT_MS,
	) {}

	/** A page was just set: it must speak within the timeout. */
	arm(): void {
		this.clear()
		this.contacted = false
		this.waitingForVisible = false
		this.stalled = false
		this.armedAt = Date.now()
		this.timer = setTimeout(() => this.check(), this.timeoutMs)
	}

	/** The page sent something: it loaded. */
	contact(): void {
		if (this.contacted) {
			return
		}
		this.contacted = true
		this.waitingForVisible = false
		this.clear()
		if (this.stalled) {
			Logger.log(
				`[webview] the panel answered after all, ${Math.round((Date.now() - this.armedAt) / 1000)} s after its page was set`,
			)
		}
	}

	/** Its view became visible. */
	shown(): void {
		if (!this.waitingForVisible || this.contacted) {
			return
		}
		this.waitingForVisible = false
		this.timer = setTimeout(() => this.check(), this.timeoutMs)
	}

	/** Armed, and nothing heard from the page yet. */
	get silent(): boolean {
		return !this.contacted
	}

	dispose(): void {
		this.clear()
	}

	private check(): void {
		this.timer = undefined
		if (this.contacted) {
			return
		}
		if (!this.isVisible()) {
			this.waitingForVisible = true
			return
		}
		this.stalled = true
		this.onStall(Date.now() - this.armedAt)
	}

	private clear(): void {
		if (this.timer) {
			clearTimeout(this.timer)
			this.timer = undefined
		}
	}
}

/**
 * The workbench's service worker cache for this VS Code, found from the
 * extension's own global storage: `<user data>/User/globalStorage/<id>`, or
 * `<user data>/User/profiles/<profile>/globalStorage/<id>` under a profile.
 * That holds for VS Code, Insiders, VSCodium and a portable install alike.
 * Undefined when the path does not have that shape.
 */
export function webviewCacheDir(globalStoragePath: string): string | undefined {
	let dir = path.dirname(globalStoragePath)
	if (path.basename(dir) !== "globalStorage") {
		return undefined
	}
	for (let i = 0; i < 3; i += 1) {
		dir = path.dirname(dir)
		if (path.basename(dir) === "User") {
			return path.join(path.dirname(dir), "Service Worker")
		}
	}
	return undefined
}

export interface PurgeScriptInput {
	/** VS Code's main process, which must be gone before the cache can go. */
	pid: number
	/** The folder to delete. */
	target: string
	/** Where the script reports what it did, for the next start to read. */
	log: string
	/** What starts VS Code again; undefined leaves that to the user. */
	relaunch?: { exe: string; macApp?: boolean }
}

const psQuote = (value: string) => `'${value.replace(/'/g, "''")}'`
const shQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`

/** The Windows script: PowerShell, run hidden and detached. */
export function windowsPurgeScript(input: PurgeScriptInput): string {
	const relaunch = input.relaunch
		? `Start-Process -FilePath ${psQuote(input.relaunch.exe)}\r\nLog ("started " + ${psQuote(input.relaunch.exe)})`
		: `Log "start VS Code again yourself"`
	return [
		"$ErrorActionPreference = 'Continue'",
		`$log = ${psQuote(input.log)}`,
		`$target = ${psQuote(input.target)}`,
		'function Log($m) { Add-Content -LiteralPath $log -Value ((Get-Date).ToString("o") + " " + $m) }',
		`Log "waiting for VS Code (pid ${input.pid}) to exit"`,
		`$deadline = (Get-Date).AddSeconds(${QUIT_WAIT_SECONDS})`,
		`while (Get-Process -Id ${input.pid} -ErrorAction SilentlyContinue) {`,
		`  if ((Get-Date) -gt $deadline) { Log "VS Code was still running after ${QUIT_WAIT_SECONDS} s; nothing deleted"; exit 1 }`,
		"  Start-Sleep -Milliseconds 500",
		"}",
		"# Its helper processes close right after it; retry while they hold files.",
		"for ($i = 0; $i -lt 30 -and (Test-Path -LiteralPath $target); $i++) {",
		"  Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue",
		"  if (Test-Path -LiteralPath $target) { Start-Sleep -Seconds 1 }",
		"}",
		'if (Test-Path -LiteralPath $target) { Log ("could not delete " + $target + ": files still in use") } else { Log ("deleted " + $target) }',
		relaunch,
		"Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue",
		"",
	].join("\r\n")
}

/** The macOS and Linux script: plain sh, run detached. */
export function posixPurgeScript(input: PurgeScriptInput): string {
	const relaunch = !input.relaunch
		? 'log "start VS Code again yourself"'
		: input.relaunch.macApp
			? `open ${shQuote(input.relaunch.exe)} && log "started ${input.relaunch.exe.replace(/"/g, "")}"`
			: `nohup ${shQuote(input.relaunch.exe)} >/dev/null 2>&1 &\nlog "started ${input.relaunch.exe.replace(/"/g, "")}"`
	return [
		"#!/bin/sh",
		`log_file=${shQuote(input.log)}`,
		`target=${shQuote(input.target)}`,
		'log() { printf \'%s %s\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$log_file"; }',
		`log "waiting for VS Code (pid ${input.pid}) to exit"`,
		"i=0",
		`while kill -0 ${input.pid} 2>/dev/null; do`,
		`  i=$((i + 1)); if [ "$i" -gt ${QUIT_WAIT_SECONDS * 2} ]; then log "VS Code was still running after ${QUIT_WAIT_SECONDS} s; nothing deleted"; exit 1; fi`,
		"  sleep 0.5",
		"done",
		'n=0; while [ -e "$target" ] && [ "$n" -lt 30 ]; do rm -rf -- "$target"; [ -e "$target" ] && sleep 1; n=$((n + 1)); done',
		'if [ -e "$target" ]; then log "could not delete $target: files still in use"; else log "deleted $target"; fi',
		relaunch,
		'rm -f -- "$0"',
		"",
	].join("\n")
}

/**
 * The Windows launcher: a short-lived PowerShell that has WMI create the
 * script's process and prints `<return value> <pid>`.
 *
 * Not a detached child: Node's `detached` on Windows is DETACHED_PROCESS, and
 * Windows PowerShell 5.1 started without a console exits 0 without running a
 * line (pandorum, 2026-11-25: the first live run quit VS Code and nothing
 * followed). A process WMI creates belongs to no one's tree or job, so VS
 * Code's exit cannot take it down, and it starts with the user's own
 * environment rather than the extension host's.
 */
export function windowsLauncherArgs(script: string): string[] {
	const commandLine = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}"`
	return [
		"-NoProfile",
		"-NonInteractive",
		"-Command",
		[
			"$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }",
			`$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(commandLine)}; ProcessStartupInformation = $si }`,
			'Write-Output ("" + $r.ReturnValue + " " + $r.ProcessId)',
		].join("; "),
	]
}

/** Start the script so that it outlives VS Code. Resolves to its pid. */
async function startDetached(script: string): Promise<number> {
	if (process.platform !== "win32") {
		const child = spawn("/bin/sh", [script], { detached: true, stdio: "ignore", env: cleanEnv() })
		child.unref()
		if (!child.pid) {
			throw new Error("/bin/sh could not be started")
		}
		return child.pid
	}
	const out = await new Promise<string>((resolve, reject) => {
		execFile(
			"powershell.exe",
			windowsLauncherArgs(script),
			{ windowsHide: true, timeout: 30_000 },
			(error, stdout, stderr) => (error ? reject(new Error(`${error.message} ${stderr}`.trim())) : resolve(stdout)),
		)
	})
	const [code, pid] = out.trim().split(/\s+/).map(Number)
	if (code !== 0 || !pid) {
		throw new Error(`Windows refused to start it (Win32_Process.Create returned ${out.trim() || "nothing"})`)
	}
	return pid
}

/**
 * What starts this VS Code again. In the extension host `execPath` is the
 * editor's own executable on Windows and Linux; on macOS it is a helper inside
 * the bundle, so the app is found from `appRoot` (`<X.app>/Contents/Resources/app`).
 */
function relaunchTarget(): PurgeScriptInput["relaunch"] {
	if (process.platform === "darwin") {
		const app = path.resolve(vscode.env.appRoot, "..", "..", "..")
		return app.endsWith(".app") && fs.existsSync(app) ? { exe: app, macApp: true } : undefined
	}
	const exe = process.execPath
	return fs.existsSync(exe) ? { exe } : undefined
}

/**
 * The environment the macOS and Linux script runs with (on Windows WMI gives
 * it the user's own). The extension host's carries
 * ELECTRON_RUN_AS_NODE and VS Code's IPC handles: an editor started with them
 * would come up as a bare Node or try to talk to the instance that just quit.
 */
function cleanEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {}
	for (const [key, value] of Object.entries(process.env)) {
		if (!/^(ELECTRON_|VSCODE_)/i.test(key)) {
			env[key] = value
		}
	}
	return env
}

/** Why this window cannot clear the cache itself, or undefined when it can. */
function cannotPurge(context: CacheContext): string | undefined {
	if (vscode.env.uiKind === vscode.UIKind.Web) {
		return "VS Code is running in a browser here, where the cache belongs to the browser."
	}
	if (vscode.env.remoteName && context.extension.extensionKind === vscode.ExtensionKind.Workspace) {
		return "Cerebriline is running on the remote machine, and the cache is on this one."
	}
	return undefined
}

/**
 * Start the script, then quit VS Code. VS Code asks about unsaved files as it
 * always does; if the quit is cancelled the script gives up after ten minutes
 * without touching anything.
 */
export async function purgeWebviewCacheAndRestart(context: CacheContext): Promise<void> {
	const target = webviewCacheDir(context.globalStorageUri.fsPath)
	const refused = cannotPurge(context) ?? (target ? undefined : "Its location could not be worked out.")
	if (refused || !target) {
		void vscode.window.showWarningMessage(
			`Cerebriline cannot clear VS Code's webview cache from here. ${refused} Close VS Code and delete the "Service Worker" folder in VS Code's user data folder yourself.`,
		)
		return
	}
	const storage = context.globalStorageUri.fsPath
	await fs.promises.mkdir(storage, { recursive: true })
	const input: PurgeScriptInput = {
		pid: Number(process.env.VSCODE_PID) || process.ppid,
		target,
		log: path.join(storage, PURGE_LOG),
		relaunch: relaunchTarget(),
	}
	const windows = process.platform === "win32"
	const script = path.join(storage, windows ? "webview-cache-purge.ps1" : "webview-cache-purge.sh")
	await fs.promises.writeFile(script, windows ? windowsPurgeScript(input) : posixPurgeScript(input), { mode: 0o700 })
	let helper: number
	try {
		helper = await startDetached(script)
	} catch (error) {
		// Quitting with nothing left to do the work is the one outcome to avoid.
		Logger.error(`[webview] could not start the cache-clearing script ${script}: ${error}`)
		void vscode.window.showErrorMessage(
			`Cerebriline could not start the script that clears VS Code's webview cache, so VS Code stays open. Close VS Code and delete ${target} yourself. (${error instanceof Error ? error.message : String(error)})`,
		)
		return
	}
	Logger.log(
		`[webview] clearing VS Code's webview cache: ${target} is deleted once VS Code (pid ${input.pid}) has exited, by ${script} (pid ${helper})`,
	)
	await vscode.commands.executeCommand("workbench.action.quit")
}

let offered = false

/**
 * The panel stayed silent: log it, and once per session offer the fix. A page
 * that answers before the button is pressed needs nothing.
 */
export async function offerWebviewCachePurge(context: CacheContext, waitedMs: number, stillSilent: () => boolean): Promise<void> {
	const target = webviewCacheDir(context.globalStorageUri.fsPath)
	Logger.warn(
		`[webview] the panel's page has sent nothing ${Math.round(waitedMs / 1000)} s after it was set: VS Code most likely could not load it ("Could not register service worker"). VS Code's webview cache: ${target ?? "unknown"}`,
	)
	if (offered) {
		return
	}
	offered = true
	const clear = "Clear Cache and Restart VS Code"
	const reload = "Reload Window"
	const choice = await vscode.window.showWarningMessage(
		'The Cerebriline panel did not load. This is usually VS Code\'s webview cache, which can go bad after an update ("Could not register service worker"). Clearing it closes every VS Code window and starts VS Code again.',
		clear,
		reload,
	)
	if (choice && !stillSilent()) {
		Logger.log("[webview] the panel loaded before the prompt was answered; nothing to do")
		return
	}
	if (choice === clear) {
		await purgeWebviewCacheAndRestart(context)
	} else if (choice === reload) {
		await vscode.commands.executeCommand("workbench.action.reloadWindow")
	}
}

/** The palette command: the same fix on request, after a confirmation. */
export async function confirmWebviewCachePurge(context: CacheContext): Promise<void> {
	const target = webviewCacheDir(context.globalStorageUri.fsPath)
	const go = "Clear and Restart"
	const choice = await vscode.window.showWarningMessage(
		"Clear VS Code's webview cache and restart VS Code?",
		{
			modal: true,
			detail: `Every VS Code window closes (VS Code asks about unsaved files first), the folder ${target ?? '"Service Worker"'} is deleted, and VS Code starts again. VS Code rebuilds the cache by itself. This is the fix for "Could not register service worker" when a panel does not load.`,
		},
		go,
	)
	if (choice === go) {
		await purgeWebviewCacheAndRestart(context)
	}
}

/** At start-up: write what the last clear did to the log, then forget it. */
export async function reportWebviewCachePurge(context: CacheContext): Promise<void> {
	const log = path.join(context.globalStorageUri.fsPath, PURGE_LOG)
	let text: string
	try {
		text = await fs.promises.readFile(log, "utf8")
	} catch {
		return
	}
	for (const line of text.split(/\r?\n/).filter(Boolean)) {
		Logger.log(`[webview] cache clear: ${line}`)
	}
	await fs.promises.rm(log, { force: true })
}
