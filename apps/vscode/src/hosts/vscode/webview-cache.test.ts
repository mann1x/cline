import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { posixPurgeScript, WebviewLoadWatchdog, webviewCacheDir, windowsPurgeScript } from "./webview-cache"

describe("the panel's load watchdog (pandorum, 2026-11-25)", () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it("reports a visible page that never says a word", () => {
		const onStall = vi.fn()
		const dog = new WebviewLoadWatchdog(() => true, onStall, 1000)
		dog.arm()
		vi.advanceTimersByTime(999)
		expect(onStall).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(onStall).toHaveBeenCalledWith(1000)
		expect(dog.silent).toBe(true)
	})

	it("is quiet once the page has spoken", () => {
		const onStall = vi.fn()
		const dog = new WebviewLoadWatchdog(() => true, onStall, 1000)
		dog.arm()
		dog.contact()
		vi.advanceTimersByTime(5000)
		expect(onStall).not.toHaveBeenCalled()
		expect(dog.silent).toBe(false)
	})

	it("is quiet before it is armed: no page, nothing to wait for", () => {
		const onStall = vi.fn()
		const dog = new WebviewLoadWatchdog(() => true, onStall, 1000)
		vi.advanceTimersByTime(5000)
		expect(onStall).not.toHaveBeenCalled()
		expect(dog.silent).toBe(false)
	})

	it("gives a page that was hidden a fresh timeout once it is shown", () => {
		let visible = false
		const onStall = vi.fn()
		const dog = new WebviewLoadWatchdog(() => visible, onStall, 1000)
		dog.arm()
		vi.advanceTimersByTime(3000)
		expect(onStall).not.toHaveBeenCalled()
		visible = true
		dog.shown()
		vi.advanceTimersByTime(999)
		expect(onStall).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(onStall).toHaveBeenCalledTimes(1)
	})

	it("starts over when a new page is set", () => {
		const onStall = vi.fn()
		const dog = new WebviewLoadWatchdog(() => true, onStall, 1000)
		dog.arm()
		vi.advanceTimersByTime(800)
		dog.arm()
		vi.advanceTimersByTime(800)
		expect(onStall).not.toHaveBeenCalled()
		vi.advanceTimersByTime(200)
		expect(onStall).toHaveBeenCalledTimes(1)
	})
})

describe("where VS Code keeps the webview cache", () => {
	it("is beside User, found from the extension's global storage", () => {
		expect(webviewCacheDir("/home/u/.config/Code/User/globalStorage/mann1x.cerebriline")).toBe(
			"/home/u/.config/Code/Service Worker",
		)
	})

	it("is the same folder under a profile", () => {
		expect(webviewCacheDir("/home/u/.config/Code/User/profiles/3f1a/globalStorage/mann1x.cerebriline")).toBe(
			"/home/u/.config/Code/Service Worker",
		)
	})

	it("is unknown when the path has another shape", () => {
		expect(webviewCacheDir("/srv/somewhere/mann1x.cerebriline")).toBeUndefined()
		expect(webviewCacheDir("/a/b/c/d/globalStorage/mann1x.cerebriline")).toBeUndefined()
	})
})

describe("the Windows script", () => {
	const script = windowsPurgeScript({
		pid: 54384,
		target: "C:\\Users\\o'brien\\AppData\\Roaming\\Code\\Service Worker",
		log: "C:\\Users\\o'brien\\AppData\\Roaming\\Code\\User\\globalStorage\\mann1x.cerebriline\\webview-cache-purge.log",
		relaunch: { exe: "C:\\Program Files\\Microsoft VS Code\\Code.exe" },
	})

	it("waits for VS Code's main process, deletes only the target, and starts VS Code again", () => {
		expect(script).toContain("Get-Process -Id 54384")
		expect(script).toContain("$target = 'C:\\Users\\o''brien\\AppData\\Roaming\\Code\\Service Worker'")
		expect(script).toContain("Remove-Item -LiteralPath $target -Recurse -Force")
		expect(script).toContain("Start-Process -FilePath 'C:\\Program Files\\Microsoft VS Code\\Code.exe'")
		expect(script.match(/Remove-Item/g)).toHaveLength(2)
	})

	it("deletes nothing when VS Code never exits", () => {
		const loop = script.slice(0, script.indexOf("Remove-Item"))
		expect(loop).toContain('nothing deleted"; exit 1')
	})
})

describe.skipIf(process.platform === "win32")("the macOS and Linux script, run for real", () => {
	let root: string
	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "webview-cache-"))
	})
	afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

	it("waits for the process to exit, then deletes the folder and logs it", async () => {
		const target = path.join(root, "Service Worker")
		fs.mkdirSync(path.join(target, "CacheStorage"), { recursive: true })
		fs.writeFileSync(path.join(target, "CacheStorage", "x"), "x")
		const vscode = spawn("sleep", ["1"])
		const log = path.join(root, "purge.log")
		const file = path.join(root, "purge.sh")
		fs.writeFileSync(file, posixPurgeScript({ pid: vscode.pid as number, target, log }))
		const run = spawn("/bin/sh", [file])
		await new Promise((resolve) => setTimeout(resolve, 300))
		expect(fs.existsSync(target)).toBe(true)
		await new Promise((resolve) => run.on("exit", resolve))
		expect(fs.existsSync(target)).toBe(false)
		expect(fs.existsSync(file)).toBe(false)
		const lines = fs.readFileSync(log, "utf8")
		expect(lines).toContain(`waiting for VS Code (pid ${vscode.pid}) to exit`)
		expect(lines).toContain(`deleted ${target}`)
		expect(lines).toContain("start VS Code again yourself")
	})

	it("quotes a path with a quote in it", () => {
		const target = path.join(root, "o'brien", "Service Worker")
		fs.mkdirSync(target, { recursive: true })
		const log = path.join(root, "purge.log")
		const file = path.join(root, "purge.sh")
		fs.writeFileSync(file, posixPurgeScript({ pid: 2 ** 22 + 7, target, log }))
		const result = spawnSync("/bin/sh", [file])
		expect(result.status).toBe(0)
		expect(fs.existsSync(target)).toBe(false)
		expect(fs.existsSync(path.join(root, "o'brien"))).toBe(true)
	})
})
