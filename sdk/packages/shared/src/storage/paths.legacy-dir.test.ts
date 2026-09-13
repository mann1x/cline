import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The fork's home directory was renamed `.cline` -> `.cerebriline`. A user who
 * installs the new build before running the migration script must still find
 * every session they have; anything else reads as "my history is gone".
 *
 * Uses a real directory rather than a mocked `existsSync` because the thing
 * under test *is* the filesystem check, and a mock would assert the shape of
 * the call rather than the answer.
 */
describe("home data directory rename", () => {
	let home: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of ["HOME", "USERPROFILE", "CLINE_DIR", "CEREBRILINE_DIR"]) {
			saved[key] = process.env[key];
		}
		home = mkdtempSync(join(tmpdir(), "cerebriline-paths-"));
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		delete process.env.CLINE_DIR;
		delete process.env.CEREBRILINE_DIR;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		rmSync(home, { recursive: true, force: true });
		vi.resetModules();
	});

	it("uses the new name for a fresh install", async () => {
		const { resolveClineDir } = await import("./paths");
		expect(resolveClineDir()).toBe(join(home, ".cerebriline"));
	});

	it("keeps using the old name when that is where the data is", async () => {
		mkdirSync(join(home, ".cline"));

		const { resolveClineDir } = await import("./paths");
		expect(resolveClineDir()).toBe(join(home, ".cline"));
	});

	it("prefers the new name once the migration has run", async () => {
		mkdirSync(join(home, ".cline"));
		mkdirSync(join(home, ".cerebriline"));

		const { resolveClineDir } = await import("./paths");
		expect(resolveClineDir()).toBe(join(home, ".cerebriline"));
	});

	it("lets CEREBRILINE_DIR beat both", async () => {
		mkdirSync(join(home, ".cline"));
		process.env.CEREBRILINE_DIR = join(home, "elsewhere");

		const { resolveClineDir } = await import("./paths");
		expect(resolveClineDir()).toBe(join(home, "elsewhere"));
	});

	it("still honours CLINE_DIR, which people have in their scripts", async () => {
		process.env.CLINE_DIR = join(home, "scripted");

		const { resolveClineDir } = await import("./paths");
		expect(resolveClineDir()).toBe(join(home, "scripted"));
	});
});
