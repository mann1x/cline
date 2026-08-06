import { beforeEach, describe, expect, it, vi } from "vitest"
import type { BrowserActionResult } from "@/shared/ExtensionMessage"
import {
	type BrowserDriver,
	createBrowserTool,
	localPathOf,
	renderBrowserResult,
	splitDataUrl,
	toNavigableUrl,
} from "./browser-tool"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const CWD = "/repo"

const PNG = "data:image/png;base64,QkFTRTY0REFUQQ=="

function result(overrides: Partial<BrowserActionResult> = {}): BrowserActionResult {
	return { logs: "", currentUrl: "file:///repo/game.html", screenshot: PNG, ...overrides } as BrowserActionResult
}

function fakeDriver(overrides: Partial<BrowserDriver> = {}) {
	const driver = {
		launchBrowser: vi.fn(async () => {}),
		navigateToUrl: vi.fn(async () => result()),
		click: vi.fn(async () => result()),
		type: vi.fn(async () => result()),
		scrollDown: vi.fn(async () => result()),
		scrollUp: vi.fn(async () => result()),
		closeBrowser: vi.fn(async () => ({})),
		...overrides,
	}
	return driver as BrowserDriver & typeof driver
}

function run(tool: ReturnType<typeof createBrowserTool>, input: unknown, modelSupportsImages = false) {
	return tool.execute(input, { metadata: { modelSupportsImages } } as never)
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("toNavigableUrl", () => {
	it("leaves a real URL alone", () => {
		expect(toNavigableUrl("http://localhost:5173/index.html", CWD)).toBe("http://localhost:5173/index.html")
		expect(toNavigableUrl("file:///c:/x/game.html", CWD)).toBe("file:///c:/x/game.html")
	})

	it("gives a bare host and port the scheme it is missing", () => {
		// `localhost:3000` parses as scheme `localhost`, which goes nowhere.
		expect(toNavigableUrl("localhost:3000", CWD)).toBe("http://localhost:3000")
		expect(toNavigableUrl("127.0.0.1:8080/app", CWD)).toBe("http://127.0.0.1:8080/app")
	})

	it("converts a Windows path, backslashes and all", () => {
		expect(toNavigableUrl("C:\\Users\\manni\\game.html", CWD)).toBe("file:///C:/Users/manni/game.html")
	})

	it("converts a POSIX path", () => {
		expect(toNavigableUrl("/repo/game.html", CWD)).toBe("file:///repo/game.html")
	})

	it("resolves a relative path against the working directory", () => {
		expect(toNavigableUrl("game.html", "/repo/src")).toBe("file:///repo/src/game.html")
	})

	it("escapes a path with a space in it", () => {
		expect(toNavigableUrl("/repo/my game.html", CWD)).toBe("file:///repo/my%20game.html")
	})
})

describe("renderBrowserResult", () => {
	it("says nothing was printed rather than printing nothing", () => {
		// Silence reads as a failed call, and a model that suspects a tool
		// failed goes back to asking the user.
		const text = renderBrowserResult("open", result({ logs: "" }))
		expect(text).toContain("Console: nothing")
		expect(text).toContain("printed no messages and threw no errors")
	})

	it("counts the errors it found", () => {
		const text = renderBrowserResult(
			"open",
			result({ logs: "[Page Error] SyntaxError: Unexpected token ')'\nlevel loaded\n[error] boom" }),
		)
		expect(text).toContain("Console (3 message(s), 2 of them errors):")
		expect(text).toContain("SyntaxError: Unexpected token ')'")
	})

	it("says so when there were messages but no errors", () => {
		expect(renderBrowserResult("open", result({ logs: "level loaded" }))).toContain("1 message(s), no errors")
	})

	it("names where it ended up, not only where it was sent", () => {
		const text = renderBrowserResult("open", result({ currentUrl: "http://localhost:3000/login" }), "http://localhost:3000")
		expect(text).toContain("http://localhost:3000/login")
	})
})

describe("splitDataUrl", () => {
	it("separates the media type from the payload", () => {
		expect(splitDataUrl(PNG)).toEqual({ mediaType: "image/png", data: "QkFTRTY0REFUQQ==" })
	})

	it("returns nothing for something that is not an image data URL", () => {
		expect(splitDataUrl("https://example.com/a.png")).toBeUndefined()
		expect(splitDataUrl("")).toBeUndefined()
	})
})

describe("localPathOf", () => {
	it("unwraps a Windows file URL", () => {
		expect(localPathOf("file:///C:/Users/manni/game.html")).toBe("C:/Users/manni/game.html")
	})

	it("unwraps a POSIX file URL and decodes escapes", () => {
		expect(localPathOf("file:///repo/my%20game.html")).toBe("/repo/my game.html")
	})

	it("declines anything remote", () => {
		// A remote page's source is not ours to scan, and the failing script may
		// live on another host entirely.
		expect(localPathOf("http://localhost:3000/app.js")).toBeUndefined()
		expect(localPathOf(undefined)).toBeUndefined()
	})
})

describe("the delimiter scan on a parse error", () => {
	const BROKEN = "<body><script>\nfoo.forEach(e=>{if(e){bar();}});\n</script></body>"

	function toolFor(logs: string, files: Record<string, string> = {}) {
		return createBrowserTool({
			cwd: CWD,
			createDriver: () => fakeDriver({ navigateToUrl: vi.fn(async () => result({ logs })) }),
			readFile: async (filePath: string) => {
				const text = files[filePath]
				if (text === undefined) {
					throw new Error(`ENOENT ${filePath}`)
				}
				return text
			},
		})
	}

	it("names the opener the browser could not", async () => {
		// Measured: the browser said `SyntaxError: missing ) after argument
		// list` with no line, and the model spent its entire 8,000-token
		// thinking budget counting brackets by hand rather than finding it.
		const tool = toolFor("[Page Error] SyntaxError: missing ) after argument list", {
			"/repo/game.html": "<body><script>\nfoo.forEach(e=>{if(e){bar();}}});\n</script></body>",
		})

		const output = await run(tool, { action: "open", url: "/repo/game.html" })

		expect(output).toContain("SyntaxError")
		expect(output).toContain("Delimiter scan")
		expect(output).toContain("line 2")
	})

	it("stays quiet when the page threw something that is not a parse error", async () => {
		const tool = toolFor("[Page Error] TypeError: x is not a function", { "/repo/game.html": BROKEN })

		expect(await run(tool, { action: "open", url: "/repo/game.html" })).not.toContain("Delimiter scan")
	})

	it("stays quiet for a remote page", async () => {
		const tool = toolFor("[Page Error] SyntaxError: Unexpected token )")

		const output = await run(tool, { action: "open", url: "http://localhost:3000" })

		expect(output).toContain("SyntaxError")
		expect(output).not.toContain("Delimiter scan")
	})

	it("is skipped, not fatal, when the file cannot be read", async () => {
		const tool = toolFor("[Page Error] SyntaxError: Unexpected token )")

		expect(await run(tool, { action: "open", url: "/repo/gone.html" })).toContain("SyntaxError")
	})
})

describe("browser", () => {
	it("launches once and reuses the page across calls", async () => {
		// Relaunching per call would cost seconds each time and lose the page.
		const driver = fakeDriver()
		const tool = createBrowserTool({ cwd: CWD, createDriver: () => driver })

		await run(tool, { action: "open", url: "/repo/game.html" })
		await run(tool, { action: "scroll_down" })

		expect(driver.launchBrowser).toHaveBeenCalledTimes(1)
	})

	it("does not spawn a browser until it is called", () => {
		const createDriver = vi.fn(() => fakeDriver())
		createBrowserTool({ cwd: CWD, createDriver })

		expect(createDriver).not.toHaveBeenCalled()
	})

	it("reports the console output of the page it opened", async () => {
		const driver = fakeDriver({
			navigateToUrl: vi.fn(async () => result({ logs: "[Page Error] SyntaxError: Unexpected token ')'" })),
		})
		const tool = createBrowserTool({ cwd: CWD, createDriver: () => driver })

		const output = await run(tool, { action: "open", url: "/repo/game.html" })

		expect(output).toContain("SyntaxError")
		expect(driver.navigateToUrl).toHaveBeenCalledWith("file:///repo/game.html")
	})

	it("attaches a screenshot for a model that can see it", async () => {
		const tool = createBrowserTool({ cwd: CWD, createDriver: () => fakeDriver() })

		const output = await run(tool, { action: "open", url: "/repo/game.html" }, true)

		expect(output).toEqual([
			{ type: "text", text: expect.stringContaining("Console") },
			{ type: "image", data: "QkFTRTY0REFUQQ==", mediaType: "image/png" },
		])
	})

	it("sends text only to a model that cannot", async () => {
		// An image a model cannot read is context window spent on nothing.
		const tool = createBrowserTool({ cwd: CWD, createDriver: () => fakeDriver() })

		expect(typeof (await run(tool, { action: "open", url: "/repo/game.html" }, false))).toBe("string")
	})

	it("withholds the image when the model declares no capabilities at all", async () => {
		// The metadata defaults to true in that case, so this asks for an
		// explicit yes rather than trusting the default.
		const tool = createBrowserTool({ cwd: CWD, createDriver: () => fakeDriver() })

		const output = await tool.execute({ action: "open", url: "/repo/game.html" }, {} as never)

		expect(typeof output).toBe("string")
	})

	it("asks for a url instead of failing when open has none", async () => {
		const driver = fakeDriver()
		const tool = createBrowserTool({ cwd: CWD, createDriver: () => driver })

		expect(await run(tool, { action: "open" })).toContain("needs a `url`")
	})

	it("clicks where it is told", async () => {
		const driver = fakeDriver()
		const tool = createBrowserTool({ cwd: CWD, createDriver: () => driver })

		await run(tool, { action: "click", coordinate: " 450 , 300 " })

		expect(driver.click).toHaveBeenCalledWith("450,300")
	})

	it("rejects a coordinate that is not one", async () => {
		const tool = createBrowserTool({ cwd: CWD, createDriver: () => fakeDriver() })

		expect(await run(tool, { action: "click", coordinate: "the button" })).toContain('"x,y"')
	})

	it("names the actions it has when given one it does not", async () => {
		const tool = createBrowserTool({ cwd: CWD, createDriver: () => fakeDriver() })

		const output = await run(tool, { action: "screenshot" })

		expect(output).toContain("is not a browser action")
		expect(output).toContain("scroll_down")
	})

	it("asks for an action when given none", async () => {
		const tool = createBrowserTool({ cwd: CWD, createDriver: () => fakeDriver() })

		expect(await run(tool, {})).toContain("No action was given")
	})

	it("closes the browser and can open a fresh one afterwards", async () => {
		const driver = fakeDriver()
		const tool = createBrowserTool({ cwd: CWD, createDriver: () => driver })

		await run(tool, { action: "open", url: "/repo/game.html" })
		expect(await run(tool, { action: "close" })).toBe("Browser closed.")
		await run(tool, { action: "open", url: "/repo/game.html" })

		expect(driver.closeBrowser).toHaveBeenCalledTimes(1)
		expect(driver.launchBrowser).toHaveBeenCalledTimes(2)
	})

	it("says the browser was not open rather than erroring", async () => {
		const tool = createBrowserTool({ cwd: CWD, createDriver: () => fakeDriver() })

		expect(await run(tool, { action: "close" })).toBe("The browser was not open.")
	})

	it("reports a browser that will not start, in words", async () => {
		const tool = createBrowserTool({
			cwd: CWD,
			createDriver: () =>
				fakeDriver({
					launchBrowser: vi.fn(async () => {
						throw new Error("Chrome not found")
					}),
				}),
		})

		expect(await run(tool, { action: "open", url: "/repo/game.html" })).toContain("Chrome not found")
	})

	it("reports a navigation that failed without claiming the page is fine", async () => {
		const tool = createBrowserTool({
			cwd: CWD,
			createDriver: () =>
				fakeDriver({
					navigateToUrl: vi.fn(async () => {
						throw new Error("net::ERR_CONNECTION_REFUSED")
					}),
				}),
		})

		const output = await run(tool, { action: "open", url: "http://localhost:3000" })

		expect(output).toContain("could not open")
		expect(output).toContain("ERR_CONNECTION_REFUSED")
	})
})
