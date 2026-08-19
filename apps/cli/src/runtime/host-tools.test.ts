import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findChrome, MissingChromeError } from "./browser-support";
import { createCliHostTools } from "./host-tools";

/**
 * The two tools this host brings itself.
 *
 * The extension has had both since they were written; the CLI offered 28 tools
 * to its 30, and the prompt template told the model to use `code_intel` for a
 * symbol query on a host where it did not exist. These cases guard the wiring —
 * that both are built, named the same, and that neither starts anything until
 * it is called.
 */

const originalChromePath = process.env.CHROME_PATH;

afterEach(() => {
	if (originalChromePath === undefined) {
		delete process.env.CHROME_PATH;
	} else {
		process.env.CHROME_PATH = originalChromePath;
	}
});

describe("createCliHostTools", () => {
	it("offers the two tools the extension has and this host did not", () => {
		const names = createCliHostTools({ cwd: "/repo" }).map((tool) => tool.name);
		expect(names).toEqual(["browser", "code_intel"]);
	});

	// Building the tools must not launch Chrome or spawn a language server:
	// every session builds them, and almost no session uses them.
	it("starts nothing when the tools are merely built", () => {
		const before = process.env.CHROME_PATH;
		process.env.CHROME_PATH = "/definitely/not/a/browser";
		expect(() => createCliHostTools({ cwd: "/repo" })).not.toThrow();
		process.env.CHROME_PATH = before;
	});

	it("describes each tool, so a template has something to override", () => {
		for (const tool of createCliHostTools({ cwd: "/repo" })) {
			expect(tool.description.length).toBeGreaterThan(0);
		}
	});
});

describe("findChrome", () => {
	it("takes CHROME_PATH when it points at something real", () => {
		const dir = mkdtempSync(join(tmpdir(), "cli-chrome-"));
		const fake = join(dir, "chrome");
		writeFileSync(fake, "");
		process.env.CHROME_PATH = fake;
		expect(findChrome()).toBe(fake);
	});

	it("ignores a CHROME_PATH that points at nothing", () => {
		process.env.CHROME_PATH = "/no/such/chrome";
		// Falls through to the system locations, which is either a real browser
		// on this machine or nothing at all — both are correct answers here.
		expect(findChrome()).not.toBe("/no/such/chrome");
	});
});

describe("MissingChromeError", () => {
	// The failure a user has to act on, so it says what to do about it.
	it("names the paths it looked in", () => {
		const message = new MissingChromeError().message;
		expect(message).toContain("CHROME_PATH");
		expect(message).toContain("/usr/bin/google-chrome");
	});
});
