import { describe, expect, it } from "vitest"
import {
	type BrowserDriverLike,
	BrowserWithIntegratedFallback,
	eventsFromSummary,
	INTEGRATED_BROWSER_TOOLS,
	imageSize,
	isIntegratedBrowserAvailable,
	type LmToolHost,
	VscodeIntegratedBrowser,
} from "./VscodeIntegratedBrowser"

/** A 1-byte JPEG body with a baseline frame header saying 1800 x 1200. */
function fakeJpeg(width: number, height: number): Uint8Array {
	return new Uint8Array([
		0xff,
		0xd8,
		0xff,
		0xe0,
		0x00,
		0x04,
		0x00,
		0x00,
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		height >> 8,
		height & 0xff,
		width >> 8,
		width & 0xff,
		0x03,
		0x01,
		0x22,
		0x00,
	])
}

const text = (value: string) => ({ value })

/** VS Code's browser tools, answering as 1.147 does. */
function fakeHost(summaries: Record<string, string>) {
	const calls: Array<{ name: string; input: Record<string, unknown> }> = []
	const host: LmToolHost = {
		toolNames: () => [...Object.values(INTEGRATED_BROWSER_TOOLS), "list_browser_pages"],
		invoke: async (name, input) => {
			calls.push({ name, input })
			if (name === INTEGRATED_BROWSER_TOOLS.screenshot) {
				return [{ mimeType: "image/jpeg", data: fakeJpeg(1800, 1200) }]
			}
			if (name === INTEGRATED_BROWSER_TOOLS.open) {
				return [text("Page ID: page-7\n\nSummary:\n"), text(summaries.open ?? "URL: about:blank\nSnapshot: <unchanged>")]
			}
			return [text(summaries[name] ?? "URL: file:///C:/game.html\nSnapshot: <unchanged>")]
		},
	}
	return { host, calls }
}

describe("reading VS Code's page summary", () => {
	it("turns its recent events into the console lines BrowserSession reports", () => {
		const summary = [
			"Page Title: Manic Miner",
			"URL: file:///C:/Users/manni/source/repos/test/manic_miner.html",
			"Recent events:",
			"- [2026-11-22T11:14:36.000Z] (console) [error] Uncaught ReferenceError: lvl is not defined",
			"- [2026-11-22T11:14:36.100Z] (pageError) SyntaxError: Unexpected token '}'",
			"    at manic_miner.html:812:3",
			'- [2026-11-22T11:14:36.200Z] (requestFailed) GET request to file:///C:/x.png failed: "net::ERR_FILE_NOT_FOUND"',
			"- [2026-11-22T11:14:36.300Z] (download) save.json",
			"Snapshot: - canvas",
		].join("\n")
		expect(eventsFromSummary(summary)).toEqual([
			"[error] Uncaught ReferenceError: lvl is not defined",
			"[Page Error] SyntaxError: Unexpected token '}'\n    at manic_miner.html:812:3",
			'[error] GET request to file:///C:/x.png failed: "net::ERR_FILE_NOT_FOUND"',
		])
	})

	it("reports nothing for a page that said nothing", () => {
		expect(eventsFromSummary("URL: file:///C:/ok.html\nSnapshot: - heading")).toEqual([])
	})

	it("reads the size of a JPEG and a PNG", () => {
		expect(imageSize(fakeJpeg(1800, 1200))).toEqual({ width: 1800, height: 1200 })
		const png = new Uint8Array(32)
		png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
		new DataView(png.buffer).setUint32(16, 900)
		new DataView(png.buffer).setUint32(20, 600)
		expect(imageSize(png)).toEqual({ width: 900, height: 600 })
	})
})

describe("VscodeIntegratedBrowser", () => {
	it("is available only when every tool it uses is registered", () => {
		expect(isIntegratedBrowserAvailable(fakeHost({}).host)).toBe(true)
		expect(
			isIntegratedBrowserAvailable({ toolNames: () => ["open_browser_page", "read_page"], invoke: async () => [] }),
		).toBe(false)
	})

	it("opens a page, then answers with its errors, its URL and a screenshot", async () => {
		const { host, calls } = fakeHost({
			open: "URL: file:///C:/game.html\nRecent events:\n- [t] (pageError) TypeError: x is null\nSnapshot: - canvas",
		})
		const browser = new VscodeIntegratedBrowser(host)
		await browser.launchBrowser()
		const result = await browser.navigateToUrl("file:///C:/game.html")
		expect(calls[0]).toEqual({ name: "open_browser_page", input: { url: "file:///C:/game.html", forceNew: true } })
		expect(calls[1]).toEqual({ name: "screenshot_page", input: { pageId: "page-7" } })
		expect(result.logs).toBe("[Page Error] TypeError: x is null")
		expect(result.currentUrl).toBe("file:///C:/game.html")
		expect(result.screenshot?.startsWith("data:image/jpeg;base64,")).toBe(true)

		await browser.navigateToUrl("file:///C:/other.html")
		expect(calls[2]).toEqual({
			name: "navigate_page",
			input: { pageId: "page-7", type: "url", url: "file:///C:/other.html" },
		})
	})

	it("clicks a screenshot point through Playwright, scaled to CSS pixels", async () => {
		const { host, calls } = fakeHost({})
		const browser = new VscodeIntegratedBrowser(host)
		await browser.navigateToUrl("file:///C:/game.html")
		const result = await browser.click("450,300")
		const run = calls.find((call) => call.name === "run_playwright_code")
		expect(run?.input.pageId).toBe("page-7")
		const code = String(run?.input.code)
		expect(code).toContain("window.innerWidth")
		expect(code).toContain("const scale = 1800 > 0")
		expect(code).toContain("page.mouse.click(450 / scale, 300 / scale)")
		expect(result.currentMousePosition).toBe("450,300")
	})

	it("types and scrolls with type_in_page, which asks the person nothing", async () => {
		const { host, calls } = fakeHost({})
		const browser = new VscodeIntegratedBrowser(host)
		await browser.navigateToUrl("file:///C:/game.html")
		await browser.type("hello")
		await browser.scrollDown()
		await browser.scrollUp()
		const typed = calls.filter((call) => call.name === "type_in_page").map((call) => call.input)
		expect(typed).toEqual([
			{ pageId: "page-7", text: "hello" },
			{ pageId: "page-7", key: "PageDown" },
			{ pageId: "page-7", key: "PageUp" },
		])
	})

	it("refuses an action before a page is open", async () => {
		await expect(new VscodeIntegratedBrowser(fakeHost({}).host).click("1,1")).rejects.toThrow("open a page first")
	})

	it("reports an open that returned no page", async () => {
		const host: LmToolHost = {
			toolNames: () => Object.values(INTEGRATED_BROWSER_TOOLS),
			invoke: async () => [text("You must provide a complete, valid URL.")],
		}
		await expect(new VscodeIntegratedBrowser(host).navigateToUrl("nope")).rejects.toThrow("did not open the page")
	})
})

describe("BrowserWithIntegratedFallback", () => {
	function driver(name: string, launchError?: Error): BrowserDriverLike & { launched: number } {
		return {
			launched: 0,
			async launchBrowser() {
				this.launched++
				if (launchError) {
					throw launchError
				}
			},
			navigateToUrl: async (url) => ({ currentUrl: `${name}:${url}` }),
			click: async () => ({ logs: name }),
			type: async () => ({ logs: name }),
			scrollDown: async () => ({ logs: name }),
			scrollUp: async () => ({ logs: name }),
			closeBrowser: async () => name,
		}
	}

	it("uses the local browser, quietly, when it starts", async () => {
		const warnings: string[] = []
		const local = driver("local")
		const wrapper = new BrowserWithIntegratedFallback(
			local,
			() => driver("vscode"),
			(m) => warnings.push(m),
		)
		await wrapper.launchBrowser()
		expect((await wrapper.navigateToUrl("u")).currentUrl).toBe("local:u")
		expect(warnings).toEqual([])
	})

	it("moves to VS Code's browser when no local one starts, and tells the person", async () => {
		const warnings: string[] = []
		const wrapper = new BrowserWithIntegratedFallback(
			driver("local", new Error("No local browser could be started. Chrome: x\n\nTROUBLESHOOTING: https://pptr.dev")),
			() => driver("vscode"),
			(m) => warnings.push(m),
		)
		await wrapper.launchBrowser()
		expect((await wrapper.navigateToUrl("u")).currentUrl).toBe("vscode:u")
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toContain("integrated browser")
		expect(warnings[0]).not.toContain("TROUBLESHOOTING")
	})

	it("passes the local failure on when VS Code's browser is not there, with the settings it needs", async () => {
		const warnings: string[] = []
		const failure = new Error("No local browser could be started.")
		const wrapper = new BrowserWithIntegratedFallback(
			driver("local", failure),
			() => undefined,
			(m) => warnings.push(m),
		)
		await expect(wrapper.launchBrowser()).rejects.toBe(failure)
		expect(warnings[0]).toContain("workbench.browser.enableChatTools")
	})

	it("tries the local browser again on the next launch", async () => {
		const local = driver("local", new Error("down"))
		const wrapper = new BrowserWithIntegratedFallback(
			local,
			() => driver("vscode"),
			() => {},
		)
		await wrapper.launchBrowser()
		await wrapper.closeBrowser()
		await wrapper.launchBrowser()
		expect(local.launched).toBe(2)
	})
})
