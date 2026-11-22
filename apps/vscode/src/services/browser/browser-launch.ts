import { stat } from "node:fs/promises"
import * as path from "node:path"
import { fileExistsAtPath } from "@utils/fs"

/**
 * Starting a local browser for the `browser` tool when the first choice does
 * not start.
 *
 * Measured on pandorum, 2026-11-22: Chrome had an update staged for five days
 * (`new_chrome.exe` beside `chrome.exe`) because nobody opened it. The tool's
 * launch was the first start, so Chrome swapped its executable and relaunched
 * itself. The process puppeteer had spawned exited without a word, puppeteer
 * reported "Failed to launch the browser process!", and the relaunched browser
 * ran on with nothing attached to it. The same flags a minute later started in
 * 300 ms. So the first thing to try after a failure is the same browser again,
 * but only when there is evidence an update was the cause, and the person at
 * the keyboard is told -- the model is not: the page it asked for still opens,
 * and how the browser got started is not something it can act on.
 */

/** Microsoft Edge, where each platform installs it. Every Windows has one. */
export function edgeCandidates(platform: NodeJS.Platform = process.platform): string[] {
	if (platform === "win32") {
		const roots = [process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.LOCALAPPDATA]
		const defaults = ["C:\\Program Files (x86)", "C:\\Program Files"]
		const found = [...roots, ...defaults].filter((root): root is string => Boolean(root))
		return [...new Set(found)].map((root) => path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe"))
	}
	if (platform === "darwin") {
		return ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
	}
	return ["/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable", "/opt/microsoft/msedge/msedge"]
}

export async function findEdge(platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
	for (const candidate of edgeCandidates(platform)) {
		if (await fileExistsAtPath(candidate)) {
			return candidate
		}
	}
	return undefined
}

/**
 * Where a Chromium-family browser on Windows stages an update it cannot apply
 * while it runs: `new_chrome.exe`, `new_msedge.exe`, `new_brave.exe`, next to
 * the executable. The next start swaps it in and relaunches. Nothing on the
 * other platforms leaves a file to look for; their updates show up as a
 * changed executable instead.
 */
export function stagedUpdatePath(executablePath: string): string {
	// The separator the path already uses: a Windows path off a POSIX test
	// machine, or the reverse, must still name the file next to it.
	const flavour = executablePath.includes("\\") ? path.win32 : path.posix
	return flavour.join(flavour.dirname(executablePath), `new_${flavour.basename(executablePath)}`)
}

/** Size and modification time: what changes when an updater swaps the file. */
async function fingerprint(executablePath: string): Promise<string | undefined> {
	try {
		const info = await stat(executablePath)
		return `${info.size}:${info.mtimeMs}`
	} catch {
		return undefined
	}
}

export interface UpdateEvidence {
	/** An update was staged before the launch. */
	stagedBefore: boolean
	/** It is still staged after the launch failed, so it was not applied. */
	stagedAfter: boolean
	/** The executable is a different file than before the launch. */
	swapped: boolean
}

/** Read before a launch; compare with `after` once it failed. */
export async function readUpdateState(
	executablePath: string,
	isWindows = process.platform === "win32",
): Promise<{ staged: boolean; fingerprint?: string }> {
	return {
		staged: isWindows ? await fileExistsAtPath(stagedUpdatePath(executablePath)) : false,
		fingerprint: await fingerprint(executablePath),
	}
}

export async function updateEvidence(
	executablePath: string,
	before: { staged: boolean; fingerprint?: string },
	isWindows = process.platform === "win32",
): Promise<UpdateEvidence> {
	const after = await readUpdateState(executablePath, isWindows)
	return {
		stagedBefore: before.staged,
		stagedAfter: after.staged,
		swapped: before.fingerprint !== undefined && after.fingerprint !== undefined && before.fingerprint !== after.fingerprint,
	}
}

/** The browser's name for a message, from its executable. */
export function browserLabel(executablePath: string): string {
	const base = path.win32.basename(executablePath).toLowerCase()
	if (base.includes("msedge") || base.includes("microsoft edge") || base.includes("microsoft-edge")) {
		return "Microsoft Edge"
	}
	if (base.includes("brave")) {
		return "Brave"
	}
	if (base.includes("chromium")) {
		return "Chromium"
	}
	return "Chrome"
}

export interface LaunchCandidate {
	executablePath: string
	/** Where it came from, for the log: settings, system, bundled. */
	source: string
}

export interface LaunchWithFallbackOptions<T> {
	/** The browser the settings and discovery chose. Throws when none could be found. */
	resolvePrimary: () => Promise<LaunchCandidate>
	/** The browser to try once the first one cannot start. */
	resolveFallback: () => Promise<string | undefined>
	launch: (executablePath: string) => Promise<T>
	/** A message for the person, never the model. */
	warn: (message: string) => void
	log?: (message: string) => void
	isWindows?: boolean
}

export interface LaunchOutcome<T> {
	browser: T
	executablePath: string
}

function messageOf(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error)
	// Puppeteer appends a troubleshooting link and blank lines.
	return text.replace(/\s*TROUBLESHOOTING:.*$/s, "").trim()
}

/**
 * Start the chosen browser; when it does not start, start it again if an
 * update was the cause, then fall back to Edge. Throws when nothing started,
 * with every attempt named, so the caller can try a browser that is not a
 * local process at all.
 */
export async function launchWithFallback<T>(options: LaunchWithFallbackOptions<T>): Promise<LaunchOutcome<T>> {
	const isWindows = options.isWindows ?? process.platform === "win32"
	const failures: string[] = []
	let primary: LaunchCandidate | undefined
	try {
		primary = await options.resolvePrimary()
	} catch (error) {
		failures.push(`no browser to start: ${messageOf(error)}`)
	}

	if (primary) {
		const label = browserLabel(primary.executablePath)
		const before = await readUpdateState(primary.executablePath, isWindows)
		try {
			return { browser: await options.launch(primary.executablePath), executablePath: primary.executablePath }
		} catch (error) {
			const evidence = await updateEvidence(primary.executablePath, before, isWindows)
			options.log?.(
				`[browser] ${label} (${primary.source}, ${primary.executablePath}) did not start: ${messageOf(error)}; update evidence ${JSON.stringify(evidence)}`,
			)
			const applied = (evidence.stagedBefore && !evidence.stagedAfter) || evidence.swapped
			if (applied) {
				options.warn(
					`${label} installed an update when the browser tool started it, and restarted itself, so the first start failed. Starting it again.`,
				)
				try {
					return { browser: await options.launch(primary.executablePath), executablePath: primary.executablePath }
				} catch (retryError) {
					failures.push(`${label} after its update: ${messageOf(retryError)}`)
				}
			} else if (evidence.stagedAfter) {
				options.warn(
					`${label} has an update waiting to be installed, and it did not start for the browser tool. Open ${label} once to finish the update.`,
				)
				failures.push(`${label} (update waiting): ${messageOf(error)}`)
			} else {
				failures.push(`${label}: ${messageOf(error)}`)
			}
		}
	}

	const fallback = await options.resolveFallback().catch(() => undefined)
	if (fallback && fallback !== primary?.executablePath) {
		const label = browserLabel(fallback)
		try {
			const browser = await options.launch(fallback)
			const reason = failures.length > 0 ? failures[failures.length - 1] : "it could not be started"
			options.warn(
				`The browser tool could not start ${primary ? browserLabel(primary.executablePath) : "a browser"} (${reason}). It is using ${label} instead.`,
			)
			return { browser, executablePath: fallback }
		} catch (error) {
			failures.push(`${label}: ${messageOf(error)}`)
		}
	}

	throw new BrowserLaunchError(failures)
}

export class BrowserLaunchError extends Error {
	constructor(readonly failures: string[]) {
		super(`No local browser could be started. ${failures.join("; ")}`)
		this.name = "BrowserLaunchError"
	}
}
