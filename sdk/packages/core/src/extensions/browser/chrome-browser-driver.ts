import { existsSync } from "node:fs";
import type { BrowserActionResult, BrowserDriver } from "../tools/browser";

/**
 * A `browser` driver for a host without VS Code: the seven methods the tool
 * needs, against a headless Chrome, through puppeteer.
 *
 * The extension drives the tool through its `BrowserSession`, which is wired
 * into the editor's state manager and webview. Moved here from the CLI so
 * every other host (the CLI, automaticum's runner) drives the same code.
 * Deliberately the same library the extension uses rather than a second
 * implementation over the DevTools protocol: `browser` decides whether a page
 * works, and two hosts answering that through different machinery is how
 * hosts drift apart.
 *
 * `puppeteer-core` is an optional peer of this package, loaded on the first
 * page opened: a host that never browses neither pays for it nor needs it.
 */

/** Matches the extension's `BrowserSession`, which reports PNG for the model. */
const SCREENSHOT_TYPE = "png" as const;

/** What the extension's default viewport is, so a screenshot means the same. */
const DEFAULT_VIEWPORT = { width: 900, height: 600 };

/**
 * How a page is waited for, as the extension's `BrowserSession` waits: until
 * the DOM is in and the network is nearly idle, for at most 7 s, then until
 * the HTML has stopped growing. The same page has to produce the same console
 * text on every host, and these waits decide what text there is.
 */
const NAVIGATION_TIMEOUT_MS = 7_000;
const NAVIGATION_WAIT_UNTIL = ["domcontentloaded", "networkidle2"];
const HTML_STABLE_TIMEOUT_MS = 5_000;
const HTML_STABLE_CHECK_MS = 500;
const HTML_STABLE_ITERATIONS = 3;
/** How long the console has to be quiet before the answer is taken. */
const CONSOLE_QUIET_MS = 500;
const CONSOLE_QUIET_TIMEOUT_MS = 3_000;
/** The extension's local-mode user agent. */
export const CHROME_USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Where Chrome usually is, in the order a Linux or macOS box tends to have it.
 * Built on each call so an environment set after import is read.
 */
export function chromeCandidates(): string[] {
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
		"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
		"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	].filter((candidate): candidate is string => Boolean(candidate));
}

/**
 * The browser this machine already has. No download: a host that silently
 * pulled 150 MB on the first tool call would be a worse surprise than a clear
 * message saying which paths were tried.
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

/** Only the parts of puppeteer used here, so it can be typed without it. */
interface PuppeteerLike {
	launch: (options: Record<string, unknown>) => Promise<PuppeteerBrowser>;
}
interface PuppeteerBrowser {
	newPage: () => Promise<PuppeteerPage>;
	close: () => Promise<void>;
}
interface PuppeteerPage {
	goto: (url: string, options: Record<string, unknown>) => Promise<unknown>;
	waitForNavigation: (options: Record<string, unknown>) => Promise<unknown>;
	content: () => Promise<string>;
	url: () => string;
	screenshot: (options: Record<string, unknown>) => Promise<string | Buffer>;
	evaluate: (fn: (delta: number) => void, delta: number) => Promise<unknown>;
	mouse: { click: (x: number, y: number) => Promise<void> };
	keyboard: { type: (text: string) => Promise<void> };
	on: (event: string, handler: (payload: unknown) => void) => void;
	off: (event: string, handler: (payload: unknown) => void) => void;
}
/**
 * How a host hands over puppeteer: `() => import("puppeteer-core")` written in
 * the host's own code, so its bundler sees the import and includes the module.
 */
export type PuppeteerLoader = () => Promise<unknown>;

/**
 * Named through a variable so neither this package's bundler nor a host's
 * pulls puppeteer in through core: it is an optional peer, resolved at run
 * time from where the host installed it, unless the host passes a loader.
 */
const PUPPETEER_MODULE: string = "puppeteer-core";

/**
 * Load puppeteer-core, or say what is missing. Kept in one place so both
 * drivers fail the same way when a host was installed without it.
 */
export async function loadPuppeteer(
	loader?: PuppeteerLoader,
): Promise<unknown> {
	try {
		const loaded = (await (loader ? loader() : import(PUPPETEER_MODULE))) as {
			launch?: unknown;
			default?: unknown;
		};
		// A CommonJS build seen through `import()` has its exports on `default`.
		return loaded.launch ? loaded : (loaded.default ?? loaded);
	} catch (error) {
		throw new Error(
			`puppeteer-core is not installed, so Chrome cannot be driven: ${
				error instanceof Error ? error.message : String(error)
			}. Install puppeteer-core beside @cline/core.`,
		);
	}
}

/**
 * Formatted exactly as the extension's `BrowserSession` formats it. Not
 * cosmetic: the tool scans this text for a parse failure and locates the
 * unbalanced bracket in the file. A plain `log` goes through unprefixed there,
 * so it does here.
 */
function describeConsoleMessage(message: unknown): string {
	const typed = message as { type?: () => string; text?: () => string };
	const kind = typed.type?.() ?? "log";
	const text = typed.text?.() ?? String(message);
	return kind === "log" ? text : `[${kind}] ${text}`;
}

export interface ChromeBrowserDriverOptions {
	headless?: boolean;
	/** Chrome's executable. Defaults to the first of `chromeCandidates()` that exists. */
	chromePath?: string;
	launchTimeoutMs?: number;
	/**
	 * Arguments Chrome starts with. The default disables the sandbox, because
	 * a CLI is routinely run as root in a container, where Chrome's sandbox
	 * refuses to start; this browser only opens pages the model could already
	 * read off disk.
	 */
	args?: string[];
	/** How to load puppeteer-core. Defaults to resolving the installed peer. */
	loadPuppeteer?: PuppeteerLoader;
}

export const DEFAULT_CHROME_ARGS = [
	`--user-agent=${CHROME_USER_AGENT}`,
	"--no-sandbox",
	"--disable-setuid-sandbox",
	"--disable-dev-shm-usage",
	"--allow-file-access-from-files",
];

/**
 * Wait until the page's HTML has stopped growing: `networkidle0` may never
 * come, and not waiting could answer before a script has run.
 */
async function waitTillHtmlStable(page: PuppeteerPage): Promise<void> {
	const maxChecks = HTML_STABLE_TIMEOUT_MS / HTML_STABLE_CHECK_MS;
	let lastSize = 0;
	let stable = 0;
	for (let check = 1; check <= maxChecks; check++) {
		const size = (await page.content()).length;
		stable = lastSize !== 0 && size === lastSize ? stable + 1 : 0;
		if (stable >= HTML_STABLE_ITERATIONS) {
			return;
		}
		lastSize = size;
		await sleep(HTML_STABLE_CHECK_MS);
	}
}

function isTimeout(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}

/**
 * A driver that launches Chrome on first use and keeps it for the session,
 * answering every action as the extension's `BrowserSession` (local mode)
 * does. The tool owns the lifecycle -- it builds the driver lazily and calls
 * `closeBrowser` at the end.
 */
export function createChromeBrowserDriver(
	options?: ChromeBrowserDriverOptions,
): BrowserDriver {
	let browser: PuppeteerBrowser | undefined;
	let page: PuppeteerPage | undefined;
	let mousePosition: string | undefined;

	async function ensurePage(): Promise<PuppeteerPage> {
		if (page) {
			return page;
		}
		const executablePath = options?.chromePath ?? findChrome();
		if (!executablePath) {
			throw new MissingChromeError();
		}
		const puppeteer = (await loadPuppeteer(
			options?.loadPuppeteer,
		)) as PuppeteerLike;
		browser = await puppeteer.launch({
			executablePath,
			headless: options?.headless === false ? false : "shell",
			args: options?.args ?? DEFAULT_CHROME_ARGS,
			defaultViewport: DEFAULT_VIEWPORT,
			timeout: options?.launchTimeoutMs ?? 30_000,
		});
		page = await browser.newPage();
		return page;
	}

	/**
	 * Run one action and report what the page said during it: console output,
	 * uncaught errors (`[Page Error]`, by `toString()` so a parse failure keeps
	 * the `SyntaxError:` the tool's bracket locator keys on), a failure of the
	 * action (`[Error]`), and a timeout only when nothing else was said -- a
	 * page that polls never reaches networkidle2 and is working fine, but a
	 * timeout that is the only thing that happened may be a page that never
	 * loaded.
	 */
	async function doAction(
		action: (current: PuppeteerPage) => Promise<void>,
	): Promise<BrowserActionResult> {
		const current = await ensurePage();
		const logs: string[] = [];
		let lastLogAt = Date.now();
		const onConsole = (message: unknown) => {
			logs.push(describeConsoleMessage(message));
			lastLogAt = Date.now();
		};
		const onPageError = (error: unknown) => {
			logs.push(`[Page Error] ${String(error)}`);
			lastLogAt = Date.now();
		};
		current.on("console", onConsole);
		current.on("pageerror", onPageError);
		try {
			try {
				await action(current);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (!isTimeout(error)) {
					logs.push(`[Error] ${message}`);
				} else if (logs.length === 0) {
					logs.push(`[Timeout] ${message}`);
				}
			}
			const quietBy = Date.now() + CONSOLE_QUIET_TIMEOUT_MS;
			while (
				Date.now() - lastLogAt < CONSOLE_QUIET_MS &&
				Date.now() < quietBy
			) {
				await sleep(100);
			}
			let screenshot: string | undefined;
			try {
				const shot = await current.screenshot({
					encoding: "base64",
					type: SCREENSHOT_TYPE,
				});
				screenshot = shot ? `data:image/png;base64,${String(shot)}` : undefined;
			} catch {
				// The console output says whether the page works; losing the
				// image must not lose it.
				screenshot = undefined;
			}
			return {
				screenshot,
				logs: logs.join("\n"),
				currentUrl: current.url(),
				...(mousePosition ? { currentMousePosition: mousePosition } : {}),
			};
		} finally {
			current.off("console", onConsole);
			current.off("pageerror", onPageError);
		}
	}

	const scrollBy = (delta: number) =>
		doAction(async (current) => {
			await current.evaluate((top: number) => {
				// biome-ignore lint/suspicious/noExplicitAny: the page's window
				(globalThis as any).scrollBy({ top, behavior: "auto" });
			}, delta);
			await sleep(300);
		});

	return {
		async launchBrowser() {
			await ensurePage();
		},
		navigateToUrl(url: string) {
			return doAction(async (current) => {
				await current.goto(url, {
					timeout: NAVIGATION_TIMEOUT_MS,
					waitUntil: NAVIGATION_WAIT_UNTIL,
				});
				await waitTillHtmlStable(current);
			});
		},
		async click(coordinate: string) {
			const [x, y] = coordinate.split(",").map((part) => Number(part.trim()));
			if (!Number.isFinite(x) || !Number.isFinite(y)) {
				throw new Error(
					`\`coordinate\` must be "x,y" in pixels; received ${coordinate}.`,
				);
			}
			return doAction(async (current) => {
				let networkActivity = false;
				const onRequest = () => {
					networkActivity = true;
				};
				current.on("request", onRequest);
				try {
					await current.mouse.click(x, y);
					mousePosition = coordinate;
					await sleep(100);
					// A click that started a load is waited for like a navigation.
					if (networkActivity) {
						await current
							.waitForNavigation({
								waitUntil: NAVIGATION_WAIT_UNTIL,
								timeout: NAVIGATION_TIMEOUT_MS,
							})
							.catch(() => {});
						await waitTillHtmlStable(current);
					}
				} finally {
					current.off("request", onRequest);
				}
			});
		},
		type(text: string) {
			return doAction(async (current) => {
				await current.keyboard.type(text);
			});
		},
		scrollDown: () => scrollBy(DEFAULT_VIEWPORT.height),
		scrollUp: () => scrollBy(-DEFAULT_VIEWPORT.height),
		async closeBrowser() {
			const closing = browser;
			browser = undefined;
			page = undefined;
			mousePosition = undefined;
			await closing?.close();
			return {};
		},
	};
}
