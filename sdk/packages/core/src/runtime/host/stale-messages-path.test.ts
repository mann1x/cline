import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMessagesPath } from "./runtime-host-support";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.allSettled(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function makeSession(root: string, sessionId: string) {
	const dir = join(root, sessionId);
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${sessionId}.messages.json`);
	await writeFile(
		path,
		JSON.stringify([{ role: "user", content: "hi" }]),
		"utf8",
	);
	return path;
}

// A session records the absolute location of its own messages file. Move the
// data directory -- which the Cerebriline migration does, ~/.cline to
// ~/.cerebriline -- and every one of those rows points at a directory that no
// longer exists. The history list is built from the rows, so sessions LIST and
// then open EMPTY, because the reader returns [] for a missing file without
// saying anything.
describe("resolveMessagesPath", () => {
	it("uses the stored path when it is still there", async () => {
		const root = await mkdtemp(join(tmpdir(), "stale-messages-"));
		tempDirs.push(root);
		const sessions = join(root, "sessions");
		const stored = await makeSession(sessions, "abc");

		expect(resolveMessagesPath(stored, "abc", sessions)).toBe(stored);
	});

	it("falls back to the derived path when the stored one has moved", async () => {
		const root = await mkdtemp(join(tmpdir(), "stale-messages-"));
		tempDirs.push(root);
		const sessions = join(root, "sessions");
		const real = await makeSession(sessions, "abc");
		const stale = join(
			root,
			"old-data-dir",
			"sessions",
			"abc",
			"abc.messages.json",
		);

		expect(resolveMessagesPath(stale, "abc", sessions)).toBe(real);
	});

	// The fallback must not invent a path. A session whose file is genuinely
	// gone has to stay reported as gone, or a real data-loss bug is masked as
	// an empty conversation.
	it("keeps the stored path when neither location has the file", () => {
		const stale = join(tmpdir(), "nowhere", "abc", "abc.messages.json");
		const sessions = join(tmpdir(), "also-nowhere");

		expect(resolveMessagesPath(stale, "abc", sessions)).toBe(stale);
	});

	it("derives a path when nothing was stored at all", async () => {
		const root = await mkdtemp(join(tmpdir(), "stale-messages-"));
		tempDirs.push(root);
		const sessions = join(root, "sessions");
		const real = await makeSession(sessions, "abc");

		expect(resolveMessagesPath(undefined, "abc", sessions)).toBe(real);
	});

	it("returns undefined when there is no sessions dir to derive from", () => {
		expect(resolveMessagesPath(undefined, "abc", undefined)).toBeUndefined();
	});
});
