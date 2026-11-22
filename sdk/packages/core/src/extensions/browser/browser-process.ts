import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Starting a browser process so that a browser which restarts itself is still
 * reached.
 *
 * A Chromium browser on Windows with an update staged next to it swaps it in
 * on start and relaunches; when it cannot (Edge left running in the
 * background holds the files), it still hands the start to a new process. In
 * both cases the process puppeteer spawned exits at once, puppeteer reports
 * "Failed to launch the browser process!", and the browser that took over
 * keeps running with nobody attached. Seen on pandorum on 2026-11-22: Chrome
 * twice, then Edge on every start, each leaving a headless browser behind.
 *
 * The browser that takes over keeps the command line, so it opens the same
 * profile and writes its DevTools port to `DevToolsActivePort` there. Giving
 * every launch a profile of its own makes that file findable: when the spawn
 * fails, the file says where the browser that did start is listening, and
 * the caller is attached to it instead of being told it failed.
 */

/** The parts of puppeteer this uses, so it can be typed without it. */
export interface PuppeteerStarter<B> {
	launch(options: Record<string, unknown>): Promise<B>;
	connect(options: Record<string, unknown>): Promise<B>;
}

interface Closable {
	close(): Promise<void>;
}

export interface StartedBrowser<B> {
	browser: B;
	/** True when the spawned process exited and the browser it handed over to was attached. */
	adopted: boolean;
}

/** Browsers reached by following a spawn that exited, for the caller's message. */
const adoptedBrowsers = new WeakSet<object>();

/** Whether `browser` was reached by attaching to a browser that restarted itself. */
export function wasAdopted(browser: unknown): boolean {
	return (
		typeof browser === "object" &&
		browser !== null &&
		adoptedBrowsers.has(browser)
	);
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `DevToolsActivePort` is the port, a newline, and the browser target path. */
export function parseDevToolsActivePort(
	text: string,
): { port: number; path: string } | undefined {
	const [portLine, pathLine] = text.split(/\r?\n/);
	const port = Number(portLine);
	if (!Number.isInteger(port) || port <= 0 || !pathLine?.startsWith("/")) {
		return undefined;
	}
	return { port, path: pathLine.trim() };
}

async function waitForActivePort(
	profile: string,
	timeoutMs: number,
): Promise<{ port: number; path: string } | undefined> {
	const file = path.join(profile, "DevToolsActivePort");
	const until = Date.now() + timeoutMs;
	while (Date.now() < until) {
		try {
			const found = parseDevToolsActivePort(await readFile(file, "utf8"));
			if (found) {
				return found;
			}
		} catch {
			// Not written yet.
		}
		await sleep(200);
	}
	return undefined;
}

/** Remove the profile once the browser has let go of it; best effort. */
async function removeProfile(profile: string): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await rm(profile, { recursive: true, force: true });
			return;
		} catch {
			await sleep(400);
		}
	}
}

/** `close()` also removes the profile the launch made. */
function removeProfileOnClose<B>(browser: B, profile: string): B {
	const closable = browser as unknown as Closable;
	const close = closable.close.bind(closable);
	closable.close = async () => {
		try {
			await close();
		} finally {
			await removeProfile(profile);
		}
	};
	return browser;
}

/**
 * Start a browser with puppeteer. For the Chromium family the launch gets a
 * profile of its own, and a spawn that exits is followed to the browser that
 * took over. Firefox is launched as given: it does not hand over, and writes
 * no `DevToolsActivePort`.
 */
export async function startBrowserProcess<B>(
	puppeteer: PuppeteerStarter<B>,
	launchOptions: Record<string, unknown>,
	options: { adoptTimeoutMs?: number } = {},
): Promise<StartedBrowser<B>> {
	if (launchOptions.browser === "firefox" || launchOptions.userDataDir) {
		return { browser: await puppeteer.launch(launchOptions), adopted: false };
	}
	const profile = await mkdtemp(path.join(os.tmpdir(), "cerebriline-browser-"));
	try {
		const browser = await puppeteer.launch({
			...launchOptions,
			userDataDir: profile,
		});
		return { browser: removeProfileOnClose(browser, profile), adopted: false };
	} catch (error) {
		const active = await waitForActivePort(
			profile,
			options.adoptTimeoutMs ?? 5_000,
		);
		if (!active) {
			await removeProfile(profile);
			throw error;
		}
		const browser = await puppeteer.connect({
			browserWSEndpoint: `ws://127.0.0.1:${active.port}${active.path}`,
			...(launchOptions.defaultViewport
				? { defaultViewport: launchOptions.defaultViewport }
				: {}),
		});
		adoptedBrowsers.add(browser as object);
		return { browser: removeProfileOnClose(browser, profile), adopted: true };
	}
}
