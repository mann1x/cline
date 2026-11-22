import { existsSync } from "node:fs";
import * as path from "node:path";

/**
 * The local browsers the `browser` tool can drive, and where each platform
 * installs them.
 *
 * One list for every host (the extension, the CLI, automaticum's runner), so
 * "which browsers are there" has one answer. Puppeteer drives the Chromium
 * family over the DevTools protocol and Firefox over WebDriver BiDi; nothing
 * else is listed because nothing else can be driven by the same code.
 */

export type LocalBrowserId =
	| "chrome"
	| "edge"
	| "brave"
	| "firefox"
	| "chromium";
export type BrowserEngine = "chromium" | "firefox";

export interface LocalBrowser {
	id: LocalBrowserId;
	name: string;
	engine: BrowserEngine;
	executablePath: string;
}

export const LOCAL_BROWSER_NAMES: Readonly<Record<LocalBrowserId, string>> = {
	chrome: "Chrome",
	edge: "Microsoft Edge",
	brave: "Brave",
	firefox: "Firefox",
	chromium: "Chromium",
};

/** The order a default launch tries them in, after any configured browser. */
export const LOCAL_BROWSER_ORDER: readonly LocalBrowserId[] = [
	"chrome",
	"edge",
	"brave",
	"firefox",
	"chromium",
];

export function engineOf(id: LocalBrowserId): BrowserEngine {
	return id === "firefox" ? "firefox" : "chromium";
}

type Env = Record<string, string | undefined>;

/** Windows install roots, per-machine first, then the per-user one. */
function windowsRoots(env: Env): string[] {
	const roots = [
		env.ProgramFiles,
		env["ProgramFiles(x86)"],
		env.LOCALAPPDATA,
		"C:\\Program Files",
		"C:\\Program Files (x86)",
	].filter((root): root is string => Boolean(root));
	return [...new Set(roots)];
}

/** Where `id` is installed on `platform`, most likely first. */
export function browserCandidatePaths(
	id: LocalBrowserId,
	platform: NodeJS.Platform = process.platform,
	env: Env = process.env,
): string[] {
	if (platform === "win32") {
		const tail: Record<LocalBrowserId, string[]> = {
			chrome: ["Google", "Chrome", "Application", "chrome.exe"],
			edge: ["Microsoft", "Edge", "Application", "msedge.exe"],
			brave: ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
			firefox: ["Mozilla Firefox", "firefox.exe"],
			chromium: ["Chromium", "Application", "chrome.exe"],
		};
		return windowsRoots(env).map((root) => path.win32.join(root, ...tail[id]));
	}
	if (platform === "darwin") {
		const apps: Record<LocalBrowserId, string> = {
			chrome: "Google Chrome.app/Contents/MacOS/Google Chrome",
			edge: "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			brave: "Brave Browser.app/Contents/MacOS/Brave Browser",
			firefox: "Firefox.app/Contents/MacOS/firefox",
			chromium: "Chromium.app/Contents/MacOS/Chromium",
		};
		const home = env.HOME;
		return [
			`/Applications/${apps[id]}`,
			...(home ? [`${home}/Applications/${apps[id]}`] : []),
		];
	}
	const linux: Record<LocalBrowserId, string[]> = {
		chrome: [
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/opt/google/chrome/chrome",
		],
		edge: [
			"/usr/bin/microsoft-edge",
			"/usr/bin/microsoft-edge-stable",
			"/opt/microsoft/msedge/msedge",
		],
		brave: [
			"/usr/bin/brave-browser",
			"/usr/bin/brave-browser-stable",
			"/opt/brave.com/brave/brave",
			"/snap/bin/brave",
		],
		firefox: [
			"/usr/bin/firefox",
			"/usr/lib/firefox/firefox",
			"/snap/bin/firefox",
			"/opt/firefox/firefox",
		],
		chromium: [
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
		],
	};
	return linux[id];
}

export function findLocalBrowser(
	id: LocalBrowserId,
	options: {
		platform?: NodeJS.Platform;
		env?: Env;
		exists?: (file: string) => boolean;
	} = {},
): LocalBrowser | undefined {
	const exists = options.exists ?? existsSync;
	const executablePath = browserCandidatePaths(
		id,
		options.platform,
		options.env,
	).find((candidate) => exists(candidate));
	return executablePath
		? {
				id,
				name: LOCAL_BROWSER_NAMES[id],
				engine: engineOf(id),
				executablePath,
			}
		: undefined;
}

/** Every listed browser this machine has, in `LOCAL_BROWSER_ORDER`. */
export function findLocalBrowsers(
	options: {
		platform?: NodeJS.Platform;
		env?: Env;
		exists?: (file: string) => boolean;
	} = {},
): LocalBrowser[] {
	return LOCAL_BROWSER_ORDER.map((id) => findLocalBrowser(id, options)).filter(
		(browser): browser is LocalBrowser => browser !== undefined,
	);
}

/** Which listed browser an executable is, by its file name; Chrome when unknown. */
export function identifyBrowser(executablePath: string): LocalBrowserId {
	const base = (executablePath.includes("\\") ? path.win32 : path.posix)
		.basename(executablePath)
		.toLowerCase();
	if (
		base.includes("msedge") ||
		base.includes("microsoft edge") ||
		base.includes("microsoft-edge")
	) {
		return "edge";
	}
	if (base.includes("brave")) {
		return "brave";
	}
	if (base.includes("firefox")) {
		return "firefox";
	}
	if (base.includes("chromium")) {
		return "chromium";
	}
	return "chrome";
}

/**
 * Puppeteer's launch options for a browser of `engine`.
 *
 * Firefox takes none of Chrome's flags (an unknown flag stops it starting) and
 * has no "shell" headless mode; puppeteer gives it a fresh profile and
 * `--no-remote`, so a Firefox the user already has open is not handed the page.
 */
export function puppeteerLaunchOptions(
	engine: BrowserEngine,
	base: {
		executablePath: string;
		chromiumArgs: string[];
		defaultViewport?: { width: number; height: number };
		timeout?: number;
	},
): Record<string, unknown> {
	const common = {
		executablePath: base.executablePath,
		...(base.defaultViewport ? { defaultViewport: base.defaultViewport } : {}),
		...(base.timeout ? { timeout: base.timeout } : {}),
	};
	if (engine === "firefox") {
		return { ...common, browser: "firefox", headless: true };
	}
	return { ...common, args: base.chromiumArgs, headless: "shell" };
}
