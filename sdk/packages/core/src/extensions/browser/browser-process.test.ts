import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
	parseDevToolsActivePort,
	startBrowserProcess,
} from "./browser-process";

function fakeBrowser() {
	return { close: vi.fn(async () => {}) };
}

describe("startBrowserProcess", () => {
	it("reads DevToolsActivePort", () => {
		expect(parseDevToolsActivePort("54321\n/devtools/browser/abc\n")).toEqual({
			port: 54321,
			path: "/devtools/browser/abc",
		});
		expect(parseDevToolsActivePort("")).toBeUndefined();
	});

	it("gives a Chromium launch its own profile and removes it on close", async () => {
		const browser = fakeBrowser();
		let profile = "";
		const puppeteer = {
			launch: vi.fn(async (options: Record<string, unknown>) => {
				profile = String(options.userDataDir);
				return browser;
			}),
			connect: vi.fn(),
		};
		const started = await startBrowserProcess(puppeteer, {
			executablePath: "chrome",
		});
		expect(started.adopted).toBe(false);
		expect(existsSync(profile)).toBe(true);
		await started.browser.close();
		expect(existsSync(profile)).toBe(false);
	});

	it("attaches to the browser that took over when the spawn exits", async () => {
		// The pandorum case: the spawned msedge.exe hands over to a new
		// process with the same profile and exits; that one writes its port.
		const adopted = fakeBrowser();
		const puppeteer = {
			launch: vi.fn(async (options: Record<string, unknown>) => {
				const profile = String(options.userDataDir);
				setTimeout(() => {
					void mkdir(profile, { recursive: true }).then(() =>
						writeFile(
							`${profile}/DevToolsActivePort`,
							"40123\n/devtools/browser/xyz",
						),
					);
				}, 100);
				throw new Error("Failed to launch the browser process!");
			}),
			connect: vi.fn(async () => adopted),
		};
		const started = await startBrowserProcess(puppeteer, {
			executablePath: "msedge",
			defaultViewport: { width: 900, height: 600 },
		});
		expect(started.adopted).toBe(true);
		expect(puppeteer.connect).toHaveBeenCalledWith({
			browserWSEndpoint: "ws://127.0.0.1:40123/devtools/browser/xyz",
			defaultViewport: { width: 900, height: 600 },
		});
	});

	it("passes the failure on when nothing took over", async () => {
		const puppeteer = {
			launch: vi.fn(async () => {
				throw new Error("spawn ENOENT");
			}),
			connect: vi.fn(),
		};
		await expect(
			startBrowserProcess(
				puppeteer,
				{ executablePath: "nope" },
				{ adoptTimeoutMs: 300 },
			),
		).rejects.toThrow("spawn ENOENT");
		expect(puppeteer.connect).not.toHaveBeenCalled();
	});

	it("launches Firefox as given", async () => {
		const puppeteer = {
			launch: vi.fn(async () => fakeBrowser()),
			connect: vi.fn(),
		};
		await startBrowserProcess(puppeteer, {
			executablePath: "firefox",
			browser: "firefox",
		});
		expect(puppeteer.launch).toHaveBeenCalledWith({
			executablePath: "firefox",
			browser: "firefox",
		});
	});
});
