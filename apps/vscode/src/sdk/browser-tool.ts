import { describeDelimiterBalance } from "@cline/core"
import { type AgentTool, createTool } from "@cline/shared"
import * as fs from "fs/promises"
import type { BrowserActionResult } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"

/**
 * A tool that answers "does this page actually work?".
 *
 * `check_file` answers that question for a file the editor understands. It has
 * nothing to say about a page: an `.html` file gets no syntax checking from VS
 * Code at all, and even a file that parses can throw the moment it runs. The
 * only component that knows is the browser, and until now the model had no way
 * to ask one.
 *
 * What it did instead was ask the user. Measured across four sessions: the
 * model finishes an edit, cannot verify it, and either declares success it has
 * not earned or asks whether the page works — a round trip that costs a human
 * turn to answer something a headless Chrome answers in two seconds.
 *
 * Nothing here is new machinery. `BrowserSession` — puppeteer, Chrome
 * discovery, remote-debug attach, screenshots, console capture — has been in
 * the tree the whole time; it was upstream's `browser_action` tool, and the SDK
 * migration cut the tool while leaving the service, its settings, its webview
 * menu and its five gRPC handlers in place. This is the wire that was cut.
 */

export const BROWSER_TOOL_NAME = "browser"

/**
 * Written at the failure it replaces, the way `check_file`'s is.
 *
 * The reflex being displaced here is not a shell command — it is asking the
 * user. So the description says, in the place the model is standing when it is
 * about to ask, that the answer is available without them.
 */
export const BROWSER_TOOL_DESCRIPTION = `Open a page in a real browser and report what it printed to the console and what it threw. This is how you check that a page works. Do not ask the user whether it works — open it and read the errors yourself.

Use it after editing any HTML, CSS or JavaScript the page loads, and before reporting a task finished. \`check_file\` cannot answer this: no language server checks the script inside an \`.html\` file, and a file that parses can still throw the moment it runs.

Actions:
- \`open\` — go to \`url\` and report the console output. Launches the browser on first use. A local file is a URL: pass the absolute path and it is converted for you.
- \`click\` — click at \`coordinate\` ("x,y" in page pixels, from the screenshot).
- \`type\` — type \`text\` at the current focus.
- \`scroll_down\`, \`scroll_up\` — one viewport.
- \`close\` — shut the browser down. Do this when finished with it.

Every action reports the console messages and uncaught errors produced while it ran, so a syntax error, a failed fetch or a null dereference comes back as text you can act on. \`[error]\` and \`[Page Error]\` lines are real failures. A page that says nothing printed nothing — that is a pass, not a failed call.

A parse error from the browser names no line, because the script never ran. For a local file a \`Delimiter scan\` section follows it and names the *opening* bracket the parser could not match — one line per place the trouble starts, since a file can be broken in several spots at once. Fix every line it lists in one edit and reload once, rather than one edit and one reload per line. Read those lines instead of counting brackets yourself: counting a whole file by hand costs more thinking than you have, and the scan skips strings, comments and regex literals, which counting does not.

The browser stays open between calls, so \`open\` once and then interact. Only one page is open at a time; \`open\` again to go elsewhere.`

/**
 * Exported so the template generator can state this tool's real call shape.
 *
 * Same reason `check_file` exports its schema: a model rewriting a prompt
 * template writes example calls, and an example is copied more readily than a
 * schema is read.
 */
export const BROWSER_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["open", "click", "type", "scroll_down", "scroll_up", "close"],
			description: "What to do.",
		},
		url: {
			type: "string",
			description: "For `open`: the page to load. An absolute file path is accepted and converted to a file URL.",
		},
		coordinate: {
			type: "string",
			description: 'For `click`: "x,y" in page pixels.',
		},
		text: {
			type: "string",
			description: "For `type`: the text to type.",
		},
	},
	required: ["action"],
} as const

export const BROWSER_ACTIONS = ["open", "click", "type", "scroll_down", "scroll_up", "close"] as const
export type BrowserToolAction = (typeof BROWSER_ACTIONS)[number]

/**
 * The subset of `BrowserSession` this tool drives.
 *
 * Declared structurally rather than imported: `BrowserSession` reaches for
 * `StateManager`, telemetry and the host bridge in its constructor, none of
 * which a unit test should have to stand up to check how a console log is
 * rendered.
 */
export interface BrowserDriver {
	launchBrowser(): Promise<void>
	navigateToUrl(url: string): Promise<BrowserActionResult>
	click(coordinate: string): Promise<BrowserActionResult>
	type(text: string): Promise<BrowserActionResult>
	scrollDown(): Promise<BrowserActionResult>
	scrollUp(): Promise<BrowserActionResult>
	closeBrowser(): Promise<unknown>
}

export interface BrowserToolOptions {
	cwd: string
	/** Built on first use, so a session that never browses never spawns Chrome. */
	createDriver: () => BrowserDriver | Promise<BrowserDriver>
	/** Injection point for tests; defaults to reading the file off disk. */
	readFile?: (filePath: string) => Promise<string>
}

interface BrowserToolInput {
	action?: unknown
	url?: unknown
	coordinate?: unknown
	text?: unknown
}

/** A text part, optionally followed by an image the model can actually see. */
type ToolOutput = string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mediaType: string }>

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/**
 * Turn what a model typed into something a browser will accept.
 *
 * Models pass local files three ways — a bare absolute path, a Windows path
 * with backslashes, and an already-correct `file://` URL — and only the third
 * works unaided. Rejecting the other two would teach the model to stop using
 * the tool rather than to write the third.
 */
export function toNavigableUrl(raw: string, cwd: string): string {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("about:") || raw.startsWith("data:")) {
		return raw
	}
	// `localhost:3000` is a host and port, not a scheme and path.
	if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(raw)) {
		return `http://${raw}`
	}
	const windowsAbsolute = /^[a-zA-Z]:[\\/]/.test(raw)
	const posixAbsolute = raw.startsWith("/")
	const absolute = windowsAbsolute || posixAbsolute ? raw : joinPath(cwd, raw)
	const normalized = absolute.replace(/\\/g, "/")
	return `file://${normalized.startsWith("/") ? "" : "/"}${encodeURI(normalized)}`
}

/** Join without importing `path`, which resolves for the *host* separator. */
function joinPath(cwd: string, relative: string): string {
	const base = cwd.replace(/[\\/]+$/, "")
	return `${base}/${relative}`.replace(/\\/g, "/")
}

/**
 * How a result reads to the model.
 *
 * The console block is the point of the tool, so it is labelled and never
 * silently omitted: "nothing" stated is a result, while nothing printed is
 * indistinguishable from the tool having failed — and a model that suspects a
 * tool failed goes back to asking the user.
 */
export function renderBrowserResult(action: string, result: BrowserActionResult, target?: string): string {
	const where = result.currentUrl ?? target
	const heading = where ? `${action}: ${where}` : action
	const logs = (result.logs ?? "").trim()
	if (logs === "") {
		return `${heading}\n\nConsole: nothing. The page printed no messages and threw no errors.`
	}
	const lines = logs.split("\n")
	const failures = lines.filter((line) => /^\[(error|Page Error)/.test(line)).length
	const summary =
		failures > 0
			? `Console (${lines.length} message(s), ${failures} of them errors):`
			: `Console (${lines.length} message(s), no errors):`
	return `${heading}\n\n${summary}\n${logs}`
}

/**
 * Split a data URL into the parts an image content block needs.
 *
 * `BrowserSession` hands back `data:image/png;base64,…` because that is what
 * the webview renders. The model's message wants the media type and the
 * payload apart.
 */
export function splitDataUrl(dataUrl: string): { data: string; mediaType: string } | undefined {
	const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(dataUrl)
	return match ? { mediaType: match[1], data: match[2] } : undefined
}

/**
 * A parse error the browser reports but cannot place.
 *
 * V8 says `SyntaxError: missing ) after argument list` and stops. There is no
 * line, no column, and for a parse failure there is no stack either — the
 * script never ran. That is the whole message the model gets.
 */
const PARSE_ERROR = /\bSyntaxError\b|\bUnexpected (token|end of input)\b/

/** The local path behind a `file://` URL, or nothing for anything remote. */
export function localPathOf(url: string | undefined): string | undefined {
	if (!url?.startsWith("file://")) {
		return undefined
	}
	try {
		const decoded = decodeURI(url.slice("file://".length))
		// `file:///C:/x` -> `C:/x`, but `file:///repo/x` -> `/repo/x`.
		return /^\/[a-zA-Z]:/.test(decoded) ? decoded.slice(1) : decoded
	} catch {
		return undefined
	}
}

/**
 * Locate a parse error the browser could only name.
 *
 * Measured, and this is why the tool exists in this shape: the browser
 * reported `SyntaxError: missing ) after argument list` on a 14 KB page, the
 * model had no position to work from, and it spent its entire 8,000-token
 * thinking budget counting brackets by hand — `forEach(` (1), `e=>{` (2) — and
 * still had not finished when the budget ran out. The scanner answers the same
 * question in milliseconds and it was already in this extension, one import
 * away, answering it for `check_file`.
 *
 * Only for local files: a remote page's source is not ours to scan, and the
 * error may come from a script on another host entirely.
 */
async function locateParseError(
	url: string | undefined,
	logs: string,
	readFile: (filePath: string) => Promise<string>,
): Promise<string | null> {
	if (!PARSE_ERROR.test(logs)) {
		return null
	}
	const filePath = localPathOf(url)
	if (!filePath) {
		return null
	}
	try {
		return describeDelimiterBalance(filePath, await readFile(filePath))
	} catch (error) {
		// Never mask the console output this is appended to.
		Logger.error(`[Browser] delimiter scan skipped for ${filePath}:`, error)
		return null
	}
}

export function createBrowserTool(options: BrowserToolOptions): AgentTool {
	// One browser per session, built on demand and reused: launching Chrome per
	// call would cost seconds each time and lose the page between them.
	let driver: BrowserDriver | undefined
	let launched = false

	async function ensureLaunched(): Promise<BrowserDriver> {
		if (!driver) {
			driver = await options.createDriver()
		}
		if (!launched) {
			await driver.launchBrowser()
			launched = true
		}
		return driver
	}

	return createTool({
		name: BROWSER_TOOL_NAME,
		description: BROWSER_TOOL_DESCRIPTION,
		inputSchema: BROWSER_TOOL_INPUT_SCHEMA,
		execute: async (input: unknown, context): Promise<ToolOutput> => {
			const request = (input ?? {}) as BrowserToolInput
			const action = readString(request.action)
			if (!action) {
				return `No action was given. Pass one of: ${BROWSER_ACTIONS.join(", ")}.`
			}
			if (!(BROWSER_ACTIONS as readonly string[]).includes(action)) {
				return `\`${action}\` is not a browser action. Use one of: ${BROWSER_ACTIONS.join(", ")}.`
			}

			if (action === "close") {
				if (!driver || !launched) {
					return "The browser was not open."
				}
				try {
					await driver.closeBrowser()
				} catch (error) {
					Logger.error("[Browser] failed to close:", error)
				}
				launched = false
				driver = undefined
				return "Browser closed."
			}

			let result: BrowserActionResult
			let target: string | undefined
			try {
				const session = await ensureLaunched()
				switch (action) {
					case "open": {
						const url = readString(request.url)
						if (!url) {
							return "`open` needs a `url`. Pass the page to load, or the absolute path of a local file."
						}
						target = toNavigableUrl(url, options.cwd)
						result = await session.navigateToUrl(target)
						break
					}
					case "click": {
						const coordinate = readString(request.coordinate)
						if (!coordinate || !/^\s*\d+\s*,\s*\d+\s*$/.test(coordinate)) {
							return '`click` needs a `coordinate` of the form "x,y" in page pixels.'
						}
						result = await session.click(coordinate.replace(/\s+/g, ""))
						break
					}
					case "type": {
						const text = readString(request.text)
						if (text === undefined) {
							return "`type` needs `text` to type."
						}
						result = await session.type(text)
						break
					}
					case "scroll_down":
						result = await session.scrollDown()
						break
					default:
						result = await session.scrollUp()
						break
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				Logger.error(`[Browser] ${action} failed:`, error)
				return `The browser could not ${action}: ${message}`
			}

			const rendered = renderBrowserResult(action, result, target)
			const located = await locateParseError(
				result.currentUrl ?? target,
				result.logs ?? "",
				options.readFile ?? ((filePath) => fs.readFile(filePath, "utf-8")),
			)
			const text = located ? `${rendered}\n\n${located}` : rendered

			// A screenshot is only worth its tokens to a model that can see it.
			// The metadata defaults to true when a model declares no capabilities
			// at all, so this asks for an explicit yes: sending an image to a
			// text-only model spends the context window on nothing it can read.
			if (context?.metadata?.modelSupportsImages !== true || !result.screenshot) {
				return text
			}
			const image = splitDataUrl(result.screenshot)
			if (!image) {
				return text
			}
			return [
				{ type: "text", text },
				{ type: "image", data: image.data, mediaType: image.mediaType },
			]
		},
	})
}
