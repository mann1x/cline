import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BrowserLaunchError, browserLabel, edgeCandidates, launchWithFallback, stagedUpdatePath } from "./browser-launch"

describe("where an update waits and which browser a path is", () => {
	it("stages the update beside the executable, Windows style", () => {
		expect(stagedUpdatePath("C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe")).toBe(
			"C:\\Program Files (x86)\\Google\\Chrome\\Application\\new_chrome.exe",
		)
		expect(stagedUpdatePath("C:\\Edge\\msedge.exe")).toBe("C:\\Edge\\new_msedge.exe")
	})

	it("names the browser from its executable", () => {
		expect(browserLabel("C:\\x\\chrome.exe")).toBe("Chrome")
		expect(browserLabel("C:\\x\\msedge.exe")).toBe("Microsoft Edge")
		expect(browserLabel("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")).toBe("Microsoft Edge")
		expect(browserLabel("C:\\x\\brave.exe")).toBe("Brave")
	})

	it("looks for Edge where each platform installs it", () => {
		expect(edgeCandidates("win32").every((p) => p.endsWith("msedge.exe"))).toBe(true)
		expect(edgeCandidates("darwin")[0]).toContain("Microsoft Edge.app")
		expect(edgeCandidates("linux")).toContain("/usr/bin/microsoft-edge")
	})
})

describe("launchWithFallback", () => {
	let dir: string
	let chrome: string
	let edge: string
	let warnings: string[]

	beforeEach(async () => {
		dir = await mkdtemp(path.join(os.tmpdir(), "browser-launch-"))
		chrome = path.join(dir, "chrome.exe")
		edge = path.join(dir, "msedge.exe")
		await writeFile(chrome, "old chrome")
		await writeFile(edge, "edge")
		warnings = []
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
	})

	const base = () => ({
		resolvePrimary: async () => ({ executablePath: chrome, source: "system" }),
		resolveFallback: async () => edge,
		warn: (message: string) => warnings.push(message),
		isWindows: true,
	})

	it("starts the first choice and says nothing when it starts", async () => {
		const result = await launchWithFallback({ ...base(), launch: async (exe) => `browser:${exe}` })
		expect(result.executablePath).toBe(chrome)
		expect(warnings).toEqual([])
	})

	it("starts Chrome again when its first start applied a staged update", async () => {
		// The pandorum case: new_chrome.exe waiting, the launch swaps it in,
		// Chrome relaunches itself and the spawned process exits.
		const staged = path.join(dir, "new_chrome.exe")
		await writeFile(staged, "new chrome")
		const tried: string[] = []
		const result = await launchWithFallback({
			...base(),
			launch: async (exe) => {
				tried.push(exe)
				if (tried.length === 1) {
					await rm(staged)
					await writeFile(chrome, "new chrome, a different size")
					throw new Error(
						"Failed to launch the browser process!\n\n\nTROUBLESHOOTING: https://pptr.dev/troubleshooting",
					)
				}
				return "browser"
			},
		})
		expect(tried).toEqual([chrome, chrome])
		expect(result.executablePath).toBe(chrome)
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain("Chrome installed an update")
	})

	it("treats a swapped executable as an update even without a staged file", async () => {
		const tried: string[] = []
		await launchWithFallback({
			...base(),
			launch: async (exe) => {
				tried.push(exe)
				if (tried.length === 1) {
					const later = new Date(Date.now() + 60_000)
					await writeFile(chrome, "replaced by the updater")
					await utimes(chrome, later, later)
					throw new Error("Failed to launch the browser process!")
				}
				return "browser"
			},
		})
		expect(tried).toEqual([chrome, chrome])
	})

	it("says an update is waiting when it was not applied, and falls back to Edge", async () => {
		await writeFile(path.join(dir, "new_chrome.exe"), "new chrome")
		const result = await launchWithFallback({
			...base(),
			launch: async (exe) => {
				if (exe === chrome) {
					throw new Error("Failed to launch the browser process!")
				}
				return "edge browser"
			},
		})
		expect(result.executablePath).toBe(edge)
		expect(warnings[0]).toContain("update waiting to be installed")
		expect(warnings[0]).toContain("Open Chrome once")
		expect(warnings[1]).toContain("using Microsoft Edge instead")
	})

	it("falls back to Edge without retrying Chrome when nothing points at an update", async () => {
		const tried: string[] = []
		const result = await launchWithFallback({
			...base(),
			launch: async (exe) => {
				tried.push(exe)
				if (exe === chrome) {
					throw new Error("spawn EACCES")
				}
				return "edge browser"
			},
		})
		expect(tried).toEqual([chrome, edge])
		expect(result.executablePath).toBe(edge)
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain("spawn EACCES")
	})

	it("falls back to Edge when no Chrome could be found or downloaded", async () => {
		const result = await launchWithFallback({
			...base(),
			resolvePrimary: async () => {
				throw new Error("download failed")
			},
			launch: async () => "edge browser",
		})
		expect(result.executablePath).toBe(edge)
		expect(warnings[0]).toContain("could not start a browser")
	})

	it("throws every attempt when nothing starts", async () => {
		const attempt = launchWithFallback({
			...base(),
			launch: async (exe) => {
				throw new Error(`no ${path.basename(exe)}`)
			},
		})
		await expect(attempt).rejects.toBeInstanceOf(BrowserLaunchError)
		await expect(attempt).rejects.toThrow(/Chrome: no chrome\.exe; Microsoft Edge: no msedge\.exe/)
	})

	it("does not try Edge twice when Edge was the first choice", async () => {
		const tried: string[] = []
		await expect(
			launchWithFallback({
				...base(),
				resolvePrimary: async () => ({ executablePath: edge, source: "settings" }),
				launch: async (exe) => {
					tried.push(exe)
					throw new Error("nope")
				},
			}),
		).rejects.toBeInstanceOf(BrowserLaunchError)
		expect(tried).toEqual([edge])
	})
})
