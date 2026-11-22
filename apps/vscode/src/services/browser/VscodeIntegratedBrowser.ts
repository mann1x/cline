import type { BrowserActionResult } from "@shared/ExtensionMessage"

/**
 * The `browser` tool on VS Code's integrated browser, for when no local
 * browser could be started.
 *
 * VS Code (1.110 on, read at 1.147) has a browser in an editor tab and gives
 * its own chat agent tools for it, registered in the same tool service every
 * extension reads through `vscode.lm.tools` and calls with
 * `vscode.lm.invokeTool`. They are registered only while
 * `chat.agent.enabled` and `workbench.browser.enableChatTools` are on (both
 * default to on), so their presence is the test for whether this works.
 *
 * What maps, and how:
 * - open: `open_browser_page` (forceNew), then `navigate_page` for later ones.
 * - screenshot: `screenshot_page`, a JPEG of the viewport in device pixels.
 * - console: every one of these tools returns the page summary, whose
 *   "Recent events" are the console errors and warnings, uncaught page errors
 *   and failed requests since the last summary. Plain `console.log` lines are
 *   not in it, so they are lost here; the failures the tool exists to report
 *   are not.
 * - type, scroll: `type_in_page` with text, or with PageDown / PageUp.
 * - click at x,y: no tool clicks a point (they take an element), so this one
 *   runs `page.mouse.click` through `run_playwright_code`, scaled from
 *   screenshot pixels to CSS pixels.
 *
 * Called outside a chat session, VS Code asks the person before a tool that
 * declares a confirmation: `open_browser_page`, `navigate_page` and
 * `run_playwright_code` do. "Chat: Manage Tool Approval" pre-approves them;
 * an extension cannot.
 */

export const INTEGRATED_BROWSER_TOOLS = {
	open: "open_browser_page",
	navigate: "navigate_page",
	screenshot: "screenshot_page",
	read: "read_page",
	type: "type_in_page",
	run: "run_playwright_code",
} as const

/** What this needs from `vscode.lm`, so it can be tested without VS Code. */
export interface LmToolHost {
	toolNames(): string[]
	/** The result's content parts, as `vscode.lm.invokeTool` returns them. */
	invoke(name: string, input: Record<string, unknown>): Promise<unknown[]>
}

export function isIntegratedBrowserAvailable(host: LmToolHost): boolean {
	const names = new Set(host.toolNames())
	return Object.values(INTEGRATED_BROWSER_TOOLS).every((name) => names.has(name))
}

function textOf(parts: unknown[]): string {
	return parts
		.map((part) => {
			const value = (part as { value?: unknown })?.value
			return typeof value === "string" ? value : ""
		})
		.filter(Boolean)
		.join("\n")
}

function imageOf(parts: unknown[]): { mimeType: string; data: Uint8Array } | undefined {
	for (const part of parts) {
		const candidate = part as { mimeType?: unknown; data?: unknown }
		if (
			typeof candidate?.mimeType === "string" &&
			candidate.mimeType.startsWith("image/") &&
			candidate.data instanceof Uint8Array
		) {
			return { mimeType: candidate.mimeType, data: candidate.data }
		}
	}
	return undefined
}

/** Width and height from a JPEG's frame header, or a PNG's IHDR. */
export function imageSize(data: Uint8Array): { width: number; height: number } | undefined {
	if (data.length > 24 && data[0] === 0x89 && data[1] === 0x50) {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
		return { width: view.getUint32(16), height: view.getUint32(20) }
	}
	if (data[0] !== 0xff || data[1] !== 0xd8) {
		return undefined
	}
	let offset = 2
	while (offset + 9 < data.length) {
		if (data[offset] !== 0xff) {
			offset++
			continue
		}
		const marker = data[offset + 1]
		const length = (data[offset + 2] << 8) | data[offset + 3]
		// SOF0..SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
			return {
				height: (data[offset + 5] << 8) | data[offset + 6],
				width: (data[offset + 7] << 8) | data[offset + 8],
			}
		}
		offset += 2 + length
	}
	return undefined
}

/**
 * The console lines a summary carries, in the form `BrowserSession` reports
 * them: `[error] …`, `[warning] …`, `[Page Error] …`.
 */
export function eventsFromSummary(summary: string): string[] {
	const start = summary.indexOf("Recent events:")
	if (start < 0) {
		return []
	}
	const lines = summary.slice(start + "Recent events:".length).split(/\r?\n/)
	const events: Array<{ type: string; text: string }> = []
	for (const line of lines) {
		if (/^Snapshot:/.test(line)) {
			break
		}
		const event = /^- \[[^\]]*\] \((\w+)\) ?(.*)$/.exec(line)
		if (event) {
			events.push({ type: event[1], text: event[2] })
		} else if (events.length > 0 && line.trim() !== "") {
			events[events.length - 1].text += `\n${line}`
		}
	}
	return events.flatMap(({ type, text }) => {
		switch (type) {
			case "console":
				return [text]
			case "pageError":
				return [`[Page Error] ${text}`]
			case "requestFailed":
				return [`[error] ${text}`]
			default:
				return []
		}
	})
}

function urlFromSummary(summary: string): string | undefined {
	return /^URL: (.+)$/m.exec(summary)?.[1]?.trim()
}

function toBase64(data: Uint8Array): string {
	return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("base64")
}

export class VscodeIntegratedBrowser {
	private pageId?: string
	private screenshotWidth?: number
	private mousePosition?: string

	constructor(private readonly host: LmToolHost) {}

	async launchBrowser(): Promise<void> {
		// The page is opened by the first navigation; nothing to start.
	}

	async navigateToUrl(url: string): Promise<BrowserActionResult> {
		if (!this.pageId) {
			const parts = await this.host.invoke(INTEGRATED_BROWSER_TOOLS.open, { url, forceNew: true })
			const text = textOf(parts)
			const id = /Page ID:\s*(\S+)/.exec(text)?.[1]
			if (!id) {
				throw new Error(`VS Code's integrated browser did not open the page: ${text || "no answer"}`)
			}
			this.pageId = id
			return this.finish(text)
		}
		const parts = await this.host.invoke(INTEGRATED_BROWSER_TOOLS.navigate, { pageId: this.pageId, type: "url", url })
		return this.finish(textOf(parts))
	}

	async click(coordinate: string): Promise<BrowserActionResult> {
		const pageId = this.requirePage()
		const [x, y] = coordinate.split(",").map(Number)
		// Screenshot pixels to CSS pixels: the screenshot is the viewport at the
		// device pixel ratio and zoom, the mouse works in CSS pixels.
		const width = this.screenshotWidth ?? 0
		const code = [
			"const cssWidth = await page.evaluate(() => window.innerWidth);",
			`const scale = ${width} > 0 && cssWidth > 0 ? ${width} / cssWidth : 1;`,
			`await page.mouse.click(${x} / scale, ${y} / scale);`,
			"await page.waitForTimeout(300);",
			"return scale;",
		].join("\n")
		const parts = await this.host.invoke(INTEGRATED_BROWSER_TOOLS.run, { pageId, code, timeoutMs: 10_000 })
		this.mousePosition = coordinate
		return this.finish(textOf(parts))
	}

	async type(text: string): Promise<BrowserActionResult> {
		const parts = await this.host.invoke(INTEGRATED_BROWSER_TOOLS.type, { pageId: this.requirePage(), text })
		return this.finish(textOf(parts))
	}

	async scrollDown(): Promise<BrowserActionResult> {
		const parts = await this.host.invoke(INTEGRATED_BROWSER_TOOLS.type, { pageId: this.requirePage(), key: "PageDown" })
		return this.finish(textOf(parts))
	}

	async scrollUp(): Promise<BrowserActionResult> {
		const parts = await this.host.invoke(INTEGRATED_BROWSER_TOOLS.type, { pageId: this.requirePage(), key: "PageUp" })
		return this.finish(textOf(parts))
	}

	/**
	 * Forget the page. Its tab stays open: closing it would take
	 * `run_playwright_code`, and with it one more question for the person.
	 */
	async closeBrowser(): Promise<BrowserActionResult> {
		this.pageId = undefined
		this.screenshotWidth = undefined
		this.mousePosition = undefined
		return {}
	}

	private requirePage(): string {
		if (!this.pageId) {
			throw new Error("Browser is not launched: open a page first.")
		}
		return this.pageId
	}

	/** The action's summary as console lines, plus a fresh screenshot. */
	private async finish(summary: string): Promise<BrowserActionResult> {
		const logs = eventsFromSummary(summary)
		const pageId = this.requirePage()
		const shot = imageOf(await this.host.invoke(INTEGRATED_BROWSER_TOOLS.screenshot, { pageId }))
		if (shot) {
			this.screenshotWidth = imageSize(shot.data)?.width ?? this.screenshotWidth
		}
		return {
			screenshot: shot ? `data:${shot.mimeType};base64,${toBase64(shot.data)}` : undefined,
			logs: logs.join("\n"),
			currentUrl: urlFromSummary(summary),
			currentMousePosition: this.mousePosition,
		}
	}
}

/** The driver surface the `browser` tool calls, as both browsers provide it. */
export interface BrowserDriverLike {
	launchBrowser(): Promise<void>
	navigateToUrl(url: string): Promise<BrowserActionResult>
	click(coordinate: string): Promise<BrowserActionResult>
	type(text: string): Promise<BrowserActionResult>
	scrollDown(): Promise<BrowserActionResult>
	scrollUp(): Promise<BrowserActionResult>
	closeBrowser(): Promise<unknown>
}

/**
 * The local browser (Chrome, then Edge), and VS Code's integrated browser when
 * neither starts. The switch is told to the person; the model gets the page
 * either way. Decided once per launch, so a later launch tries Chrome again.
 */
export class BrowserWithIntegratedFallback implements BrowserDriverLike {
	private active?: BrowserDriverLike

	constructor(
		private readonly local: BrowserDriverLike,
		private readonly integrated: () => BrowserDriverLike | undefined,
		private readonly warn: (message: string) => void,
	) {}

	async launchBrowser(): Promise<void> {
		try {
			await this.local.launchBrowser()
			this.active = this.local
			return
		} catch (error) {
			const reason = (error instanceof Error ? error.message : String(error)).replace(/\s*TROUBLESHOOTING:.*$/s, "").trim()
			const fallback = this.integrated()
			if (!fallback) {
				this.warn(
					`The browser tool could not start a local browser (${reason}). VS Code's integrated browser is not available either: it needs "chat.agent.enabled" and "workbench.browser.enableChatTools" turned on.`,
				)
				throw error
			}
			await fallback.launchBrowser()
			this.active = fallback
			this.warn(
				`The browser tool could not start a local browser (${reason}). It is using VS Code's integrated browser instead: plain console.log output is not captured there (errors and warnings are), and VS Code may ask before opening a page or clicking.`,
			)
		}
	}

	navigateToUrl(url: string): Promise<BrowserActionResult> {
		return this.current().navigateToUrl(url)
	}
	click(coordinate: string): Promise<BrowserActionResult> {
		return this.current().click(coordinate)
	}
	type(text: string): Promise<BrowserActionResult> {
		return this.current().type(text)
	}
	scrollDown(): Promise<BrowserActionResult> {
		return this.current().scrollDown()
	}
	scrollUp(): Promise<BrowserActionResult> {
		return this.current().scrollUp()
	}
	async closeBrowser(): Promise<unknown> {
		const active = this.active
		this.active = undefined
		return active?.closeBrowser()
	}

	private current(): BrowserDriverLike {
		// Before a launch, the local browser answers with its own "not launched".
		return this.active ?? this.local
	}
}
