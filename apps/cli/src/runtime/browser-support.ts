import { existsSync } from "node:fs";
import type { BrowserActionResult, BrowserDriver } from "@cline/core";

/**
 * The CLI half of `browser`.
 *
 * The tool itself is shared with the extension, which drives it through
 * `BrowserSession` — puppeteer, Chrome discovery, screenshots, console capture,
 * all of it wired into the editor's state manager and its webview. None of that
 * is reachable from a terminal, and none of it needs to be: the tool takes its
 * driver as an injected interface of seven methods, so this is those seven
 * methods against a headless Chrome and nothing else.
 *
 * Deliberately the same library the extension uses rather than a second
 * implementation over the DevTools protocol. `browser` is the tool that decides
 * whether a page works, and two hosts answering that question through different
 * machinery is how the hosts drifted apart in the first place.
 */

/** Matches the extension's `BrowserSession`, which reports PNG for the model. */
const SCREENSHOT_TYPE = "png" as const;

/** What the extension's default viewport is, so a screenshot means the same. */
const DEFAULT_VIEWPORT = { width: 900, height: 600 };

/**
 * How long a navigation gets before it is called done.
 *
 * `networkidle2` rather than `load`: a page whose script throws on the first
 * frame has still "loaded", and the console messages that say so arrive after.
 * The timeout is a bound rather than a target — a page that never settles still
 * reports whatever it printed before the clock ran out, which is the answer the
 * model asked for.
 */
const NAVIGATION_TIMEOUT_MS = 15_000;

/**
 * Where Chrome usually is, in the order a Linux or macOS box tends to have it.
 *
 * Built on each call rather than at module load, so the environment is read
 * when it is asked about. A frozen copy would ignore a `CHROME_PATH` set by
 * anything that runs after this file is imported.
 */
function chromeCandidates(): string[] {
	return [
		process.env.CHROME_PATH,
		process.env.PUPPETEER_EXECUTABLE_PATH,
		"/usr/bin/google-chrome",
		"/usr/bin/google-chrome-stable",
		"/usr/bin/chromium",
		"/usr/bin/chromium-browser",
		"/snap/bin/chromium",
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
	].filter((candidate): candidate is string => Boolean(candidate));
}

/**
 * The browser this machine already has.
 *
 * No download. The extension can fall back to fetching a Chromium because it
 * has a progress UI to report it in; a CLI that silently pulled 150 MB on the
 * first tool call would be a worse surprise than a clear message saying which
 * paths were tried.
 */
export function findChrome(): string | undefined {
	return chromeCandidates().find((candidate) => existsSync(candidate));
}

export class MissingChromeError extends Error {
	constructor() {
		super(
			"No Chrome or Chromium was found, so the `browser` tool cannot open a page. " +
				`Install one, or set CHROME_PATH to its executable. Looked in: ${chromeCandidates().join(", ")}.`,
		);
		this.name = "MissingChromeError";
	}
}

/** Console output and page errors, in the order the page produced them. */
interface CapturedPage {
	logs: string[];
	url: () => string;
}

/** Only the parts of puppeteer this file uses, so it can be typed without it. */
interface PuppeteerLike {
	launch: (options: Record<string, unknown>) => Promise<PuppeteerBrowser>;
}
interface PuppeteerBrowser {
	newPage: () => Promise<PuppeteerPage>;
	close: () => Promise<void>;
}
interface PuppeteerPage {
	setViewport: (viewport: { width: number; height: number }) => Promise<void>;
	goto: (url: string, options: Record<string, unknown>) => Promise<unknown>;
	url: () => string;
	screenshot: (options: Record<string, unknown>) => Promise<string | Buffer>;
	mouse: {
		click: (x: number, y: number) => Promise<void>;
		wheel: (delta: { deltaY: number }) => Promise<void>;
	};
	keyboard: { type: (text: string) => Promise<void> };
	on: (event: string, handler: (payload: unknown) => void) => void;
}

/**
 * Formatted exactly as the extension's `BrowserSession` formats it.
 *
 * Not cosmetic. The tool scans this text for a parse failure and, when it finds
 * one, locates the unbalanced bracket in the file -- which is the difference
 * between a model being told "missing ) after argument list" and being told
 * which line to look at. A plain `log` goes through unprefixed there, so it
 * does here.
 */
function describeConsoleMessage(message: unknown): string {
	const typed = message as { type?: () => string; text?: () => string };
	const kind = typed.type?.() ?? "log";
	const text = typed.text?.() ?? String(message);
	return kind === "log" ? text : `[${kind}] ${text}`;
}

/**
 * A driver that launches Chrome on first use and keeps it for the session.
 *
 * The tool already owns the lifecycle — it builds the driver lazily and calls
 * `closeBrowser` at the end — so nothing here launches anything until the model
 * actually asks to open a page.
 */
export function createCliBrowserDriver(options?: {
	headless?: boolean;
	chromePath?: string;
	launchTimeoutMs?: number;
}): BrowserDriver {
	let browser: PuppeteerBrowser | undefined;
	let page: PuppeteerPage | undefined;
	let captured: CapturedPage | undefined;

	async function ensurePage(): Promise<PuppeteerPage> {
		if (page) {
			return page;
		}
		const executablePath = options?.chromePath ?? findChrome();
		if (!executablePath) {
			throw new MissingChromeError();
		}
		// Imported here rather than at module load: a session that never browses
		// should not pay puppeteer's start-up cost, and a CLI installed without
		// it should fail when the tool is used rather than when it starts.
		const puppeteer = (await import("puppeteer-core")) as unknown as PuppeteerLike;
		browser = await puppeteer.launch({
			executablePath,
			headless: options?.headless ?? true,
			// `--no-sandbox` because a CLI is routinely run as root in a container,
			// where Chrome's sandbox refuses to start at all. This browser only
			// ever opens pages the model was already able to read off disk.
			args: [
				"--no-sandbox",
				"--disable-setuid-sandbox",
				"--disable-dev-shm-usage",
				"--allow-file-access-from-files",
			],
			timeout: options?.launchTimeoutMs ?? 30_000,
		});
		page = await browser.newPage();
		await page.setViewport(DEFAULT_VIEWPORT);

		const logs: string[] = [];
		captured = { logs, url: () => page?.url() ?? "" };
		page.on("console", (message) => logs.push(describeConsoleMessage(message)));
		// The one that matters most: an uncaught exception never reaches
		// `console`, so a page that throws on load would otherwise report a clean
		// run. This is the line the model is looking for.
		//
		// `toString()` rather than `.message`, which is what the extension does
		// and is load-bearing: `message` for a parse failure is "missing ) after
		// argument list" with the `SyntaxError:` stripped off, and the tool keys
		// its bracket locator on the name. Measured before this was fixed -- the
		// page reported the fault correctly and the scan that says *where* it is
		// never ran.
		page.on("pageerror", (error) => {
			logs.push(`[Page Error] ${String(error)}`);
		});
		page.on("requestfailed", (request) => {
			const failed = request as {
				url?: () => string;
				failure?: () => { errorText?: string } | null;
			};
			logs.push(
				`[error] failed to load ${failed.url?.() ?? "a request"}: ${
					failed.failure?.()?.errorText ?? "unknown error"
				}`,
			);
		});
		return page;
	}

	/** Everything the page said since the last action, then a clean slate. */
	async function report(current: PuppeteerPage): Promise<BrowserActionResult> {
		const logs = captured?.logs.join("\n") ?? "";
		if (captured) {
			captured.logs.length = 0;
		}
		let screenshot: string | undefined;
		try {
			const shot = await current.screenshot({
				encoding: "base64",
				type: SCREENSHOT_TYPE,
			});
			screenshot = `data:image/png;base64,${String(shot)}`;
		} catch {
			// A screenshot is the optional half of the answer. The console output
			// is the half that says whether the page works, and it is already in
			// hand — losing the image must not lose that.
			screenshot = undefined;
		}
		return { screenshot, logs, currentUrl: current.url() };
	}

	return {
		async launchBrowser() {
			await ensurePage();
		},
		async navigateToUrl(url: string) {
			const current = await ensurePage();
			try {
				await current.goto(url, {
					waitUntil: "networkidle2",
					timeout: NAVIGATION_TIMEOUT_MS,
				});
			} catch (error) {
				// Reported rather than thrown: a page that never settles has still
				// usually printed the error the model is asking about, and the
				// timeout itself is worth saying out loud.
				captured?.logs.push(
					`[error] navigation did not settle: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			return report(current);
		},
		async click(coordinate: string) {
			const current = await ensurePage();
			const [x, y] = coordinate.split(",").map((part) => Number(part.trim()));
			if (!Number.isFinite(x) || !Number.isFinite(y)) {
				throw new Error(
					`\`coordinate\` must be "x,y" in pixels; received ${coordinate}.`,
				);
			}
			await current.mouse.click(x, y);
			return report(current);
		},
		async type(text: string) {
			const current = await ensurePage();
			await current.keyboard.type(text);
			return report(current);
		},
		async scrollDown() {
			const current = await ensurePage();
			await current.mouse.wheel({ deltaY: DEFAULT_VIEWPORT.height });
			return report(current);
		},
		async scrollUp() {
			const current = await ensurePage();
			await current.mouse.wheel({ deltaY: -DEFAULT_VIEWPORT.height });
			return report(current);
		},
		async closeBrowser() {
			const closing = browser;
			browser = undefined;
			page = undefined;
			captured = undefined;
			await closing?.close();
			return {};
		},
	};
}

/** Kept for symmetry with the extension's driver, which spawns Chrome itself. */
export function chromeIsAvailable(): boolean {
	return findChrome() !== undefined;
}
