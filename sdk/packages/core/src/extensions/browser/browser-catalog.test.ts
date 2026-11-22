import { describe, expect, it } from "vitest";
import {
	browserCandidatePaths,
	findLocalBrowsers,
	identifyBrowser,
	puppeteerLaunchOptions,
} from "./browser-catalog";

const windowsEnv = {
	ProgramFiles: "C:\\Program Files",
	"ProgramFiles(x86)": "C:\\Program Files (x86)",
	LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
};

describe("the browser catalog", () => {
	it("looks for each browser where Windows installs it, per user included", () => {
		expect(browserCandidatePaths("brave", "win32", windowsEnv)).toContain(
			"C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
		);
		expect(browserCandidatePaths("firefox", "win32", windowsEnv)).toContain(
			"C:\\Program Files\\Mozilla Firefox\\firefox.exe",
		);
		expect(browserCandidatePaths("chrome", "win32", windowsEnv)).toContain(
			"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
		);
	});

	it("finds what is installed, in the default order", () => {
		// pandorum, 2026-11-22: all four, Brave per user.
		const installed = new Set([
			"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
			"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
			"C:\\Users\\me\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
			"C:\\Program Files\\Mozilla Firefox\\firefox.exe",
		]);
		const found = findLocalBrowsers({
			platform: "win32",
			env: windowsEnv,
			exists: (file) => installed.has(file),
		});
		expect(found.map((browser) => browser.id)).toEqual([
			"chrome",
			"edge",
			"brave",
			"firefox",
		]);
		expect(found.find((browser) => browser.id === "firefox")?.engine).toBe(
			"firefox",
		);
	});

	it("covers macOS and Linux", () => {
		expect(browserCandidatePaths("firefox", "darwin", {})).toContain(
			"/Applications/Firefox.app/Contents/MacOS/firefox",
		);
		expect(browserCandidatePaths("brave", "linux", {})).toContain(
			"/usr/bin/brave-browser",
		);
	});

	it("tells the browser from its executable", () => {
		expect(identifyBrowser("C:\\x\\msedge.exe")).toBe("edge");
		expect(
			identifyBrowser(
				"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			),
		).toBe("brave");
		expect(
			identifyBrowser("C:\\Program Files\\Mozilla Firefox\\firefox.exe"),
		).toBe("firefox");
		expect(identifyBrowser("/usr/bin/google-chrome")).toBe("chrome");
	});

	it("gives Firefox none of Chrome's flags and plain headless", () => {
		const base = {
			executablePath: "ff",
			chromiumArgs: ["--no-sandbox"],
			defaultViewport: { width: 900, height: 600 },
		};
		expect(puppeteerLaunchOptions("firefox", base)).toEqual({
			executablePath: "ff",
			defaultViewport: { width: 900, height: 600 },
			browser: "firefox",
			headless: true,
		});
		expect(puppeteerLaunchOptions("chromium", base)).toMatchObject({
			args: ["--no-sandbox"],
			headless: "shell",
		});
	});
});
