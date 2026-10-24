import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Memory, noteSimilarity, placeScore } from "./memory";
import { describeNote, useWeight } from "./memory-note";
import { createMemoryRecaller } from "./memory-recall";

let root: string;
let memory: Memory;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "memory-lifecycle-"));
	memory = new Memory({
		directory: join(root, "memory"),
		runtimeDirectory: join(root, "no-runtime"),
	});
});
afterEach(async () => {
	await memory.close();
	rmSync(root, { recursive: true, force: true });
});

describe("what a note is", () => {
	it("needs a reason for a decision, and tells the reader not to reopen it", async () => {
		await expect(
			memory.remember({
				text: "Releases come from full-build-release.",
				kind: "decision",
			}),
		).rejects.toThrow(/needs its reason/);
		const kept = await memory.remember({
			text: "Releases come from full-build-release.",
			kind: "decision",
			reason: "main carries work in progress",
		});
		expect(kept.item).toMatchObject({ kind: "decision", status: "noted" });
		expect(describeNote(kept.item)).toContain(
			"A decision, because main carries work in progress. Do not reopen it unless something now contradicts that reason.",
		);
		// The head line stays the shape recall's ids are read back by.
		expect(describeNote(kept.item)).toMatch(
			/^\[m1\] \d{4}-\d{2}-\d{2}, main, decision/,
		);
	});

	it("is settled by the user only, and an outdated note is left out of automatic recall", async () => {
		const kept = await memory.remember({ text: "The tests run under jest." });
		const confirmed = memory.settle(kept.item.id, { status: "confirmed" });
		expect(confirmed.status).toBe("confirmed");
		expect(describeNote(confirmed)).toContain("Confirmed by the user");
		const outdated = memory.settle(kept.item.id, {
			status: "outdated",
			reason: "moved to vitest",
		});
		expect(describeNote(outdated)).toContain(
			"The user marked it outdated: moved to vitest. Do not rely on it.",
		);
		expect(
			(await memory.recall("how do the tests run", { skipOutdated: true }))
				.items,
		).toEqual([]);
		// Asked for, it is still there, saying what it is.
		expect((await memory.recall("how do the tests run")).items).toHaveLength(1);
		expect(memory.settle(kept.item.id, { status: "noted" }).status).toBe(
			"noted",
		);
	});

	it("is revised in place: the same id, what it said before kept, the user's verdict cleared", async () => {
		const kept = await memory.remember({ text: "Build with Bun 1.3." });
		memory.settle(kept.item.id, { status: "confirmed" });
		const revised = await memory.remember({
			text: "Build with Bun 1.4.2.",
			replaces: kept.item.id,
		});
		expect(revised.outcome).toBe("revised");
		expect(revised.item).toMatchObject({
			id: kept.item.id,
			text: "Build with Bun 1.4.2.",
			status: "noted",
		});
		expect(revised.item.history?.map((entry) => entry.text)).toEqual([
			"Build with Bun 1.3.",
		]);
		expect(memory.list()).toHaveLength(1);
		expect((await memory.recall("bun")).items[0]?.text).toBe(
			"Build with Bun 1.4.2.",
		);
	});

	it("collects evidence, once each, and the places it is about", async () => {
		const kept = await memory.remember({
			text: "The retry window is in deciseconds.",
			places: ["src/net/backoff.ts:148"],
			evidence: "grep RETRY_WINDOW",
		});
		const again = await memory.remember({
			text: "The retry window is in deciseconds.",
			evidence: "grep RETRY_WINDOW",
		});
		expect(again.outcome).toBe("unchanged");
		const more = await memory.remember({
			text: "The retry window is in deciseconds.",
			evidence: "test backoff.spec passes with 10",
		});
		expect(more.outcome).toBe("updated");
		expect(more.item.evidence?.map((entry) => entry.text)).toEqual([
			"grep RETRY_WINDOW",
			"test backoff.spec passes with 10",
		]);
		expect(kept.item.places).toEqual([
			{ path: "src/net/backoff.ts", line: 148 },
		]);
	});

	it("never gives a forgotten note's id to another", async () => {
		await memory.remember({ text: "First note about builds." });
		const second = await memory.remember({ text: "Second note about tests." });
		await memory.forget(second.item.id);
		const third = await memory.remember({ text: "Third note about releases." });
		expect(third.item.id).toBe("m3");
	});
});

describe("near-duplicates", () => {
	it("are not kept twice: the answer names the note that says it", async () => {
		await memory.remember({
			text: "Run the tests with vitest before every commit.",
		});
		const near = await memory.remember({
			text: "Run the tests with vitest before each commit.",
		});
		expect(near.outcome).toBe("similar");
		expect(near.item.id).toBe("m1");
		expect(near.similarity).toBeGreaterThanOrEqual(0.85);
		expect(memory.list()).toHaveLength(1);
		expect(noteSimilarity("abc def", "xyz uvw")).toBeLessThan(0.3);
	});

	it("are merged by consolidation, which deletes what it merged and keeps their ids reachable", async () => {
		await memory.remember({
			text: "Run the tests with vitest before every commit.",
			tags: ["testing"],
		});
		await memory.remember({
			text: "Run the tests with vitest before each commit.",
			tags: ["ci"],
			allowSimilar: true,
		});
		await memory.remember({ text: "Indentation is two spaces." });
		const result = await memory.consolidate();
		expect(result).toEqual({ merged: 1, into: ["m1"] });
		const notes = memory.list();
		expect(notes).toHaveLength(2);
		expect(memory.get("m2")).toMatchObject({
			id: "m1",
			tags: ["testing", "ci"],
			merged: ["m2"],
		});
	});
});

describe("use", () => {
	it("moves a note by how lately and how often it was given", () => {
		const now = Date.parse("2026-10-24T00:00:00Z");
		expect(useWeight(undefined, now)).toBe(1);
		expect(
			useWeight({ count: 1, last: "2026-10-24T00:00:00Z" }, now),
		).toBeCloseTo(1.1);
		// Recalled at every turn: it comes up whatever is asked.
		expect(
			useWeight({ count: 9, last: "2026-10-24T00:00:00Z" }, now),
		).toBeCloseTo(0.6);
		// Two half-lives on, halfway to a half.
		expect(
			useWeight({ count: 1, last: "2026-09-26T00:00:00Z" }, now),
		).toBeCloseTo(1.1 * 0.625);
	});

	it("is counted when a note is given", async () => {
		const kept = await memory.remember({ text: "Two-space indentation." });
		memory.noteRecalled([kept.item.id], ["main"]);
		memory.noteRecalled([kept.item.id], ["main"]);
		expect(memory.get(kept.item.id)?.recalled?.count).toBe(2);
	});
});

describe("places", () => {
	it("find the notes about the files in play by a file in common, never by words alone", async () => {
		await memory.remember({
			text: "The retry window is in deciseconds.",
			places: ["src/net/backoff.ts:148"],
		});
		await memory.remember({
			text: "The parser in lib/parse.py keeps a cache.",
		});
		await memory.remember({ text: "Words about backoff and retry windows." });
		expect(
			memory.recallAtPlaces(["net/backoff.ts"]).map((item) => item.id),
		).toEqual(["m1"]);
		expect(
			memory.recallAtPlaces(["/work/lib/parse.py"]).map((item) => item.id),
		).toEqual(["m2"]);
		expect(memory.recallAtPlaces(["backoff"])).toEqual([]);
		expect(
			placeScore([{ path: "a/b.ts", line: 10 }], [{ path: "b.ts", line: 200 }]),
		).toBe(0.5);
	});

	it("are checked against the code: moved, changed, gone, or more than one file", async () => {
		const work = join(root, "work");
		mkdirSync(join(work, "src", "net"), { recursive: true });
		const file = join(work, "src", "net", "backoff.ts");
		writeFileSync(file, "a\nconst RETRY_WINDOW = 10;\nb\n");
		const kept = await memory.remember({
			text: "The retry window is in deciseconds.",
			places: ["src/net/backoff.ts:2"],
			cwd: work,
		});
		expect(kept.item.places).toEqual([
			{ path: "src/net/backoff.ts", line: 2, text: "const RETRY_WINDOW = 10;" },
		]);
		expect(memory.checkPlaces(kept.item, work)).toEqual([
			{ place: kept.item.places?.[0], state: "ok" },
		]);
		writeFileSync(file, "a\n// moved\nconst RETRY_WINDOW = 10;\nb\n");
		expect(memory.checkPlaces(kept.item, work)[0]).toMatchObject({
			state: "moved",
			line: 3,
		});
		writeFileSync(file, "a\nconst RETRY_WINDOW = 20;\n");
		expect(memory.checkPlaces(kept.item, work)[0].state).toBe("changed");
		const short = { places: [{ path: "net/backoff.ts" }] };
		expect(
			memory.checkPlaces(short, work, () => ["src/net/backoff.ts"])[0].state,
		).toBe("ok");
		expect(
			memory.checkPlaces({ places: [{ path: "backoff.ts" }] }, work, () => [
				"src/net/backoff.ts",
				"old/backoff.ts",
			])[0].state,
		).toBe("ambiguous");
		expect(
			memory.checkPlaces({ places: [{ path: "gone.ts" }] }, work, () => [])[0]
				.state,
		).toBe("missing");
		expect(
			describeNote(kept.item, { checks: memory.checkPlaces(kept.item, work) }),
		).toContain("(Since it was noted: src/net/backoff.ts:2 changed.)");
	});
});

describe("expiry", () => {
	it("distils the expired facts into one note, and removes them only once it is written", async () => {
		const now = Date.now();
		await memory.remember({ text: "Session one tried the cache.", ttlDays: 1 });
		await memory.remember({
			text: "Session two saw the cache miss.",
			ttlDays: 1,
		});
		await memory.remember({
			text: "Keep the cache.",
			kind: "decision",
			reason: "it halves the cold start",
			ttlDays: 1,
		});
		await memory.remember({ text: "A note with no expiry." });
		const failed = await memory.expire({
			nowMs: now + 2 * 86_400_000,
			distill: async () => {
				throw new Error("no model");
			},
		});
		expect(failed[0]).toMatchObject({ removed: 0 });
		expect(memory.list()).toHaveLength(4);

		const seen: string[] = [];
		const done = await memory.expire({
			nowMs: now + 2 * 86_400_000,
			distill: async (notes) => {
				seen.push(...notes.map((note) => note.text));
				return "The cache was tried and missed.";
			},
		});
		expect(seen.sort()).toEqual([
			"Session one tried the cache.",
			"Session two saw the cache miss.",
		]);
		expect(done[0]).toMatchObject({ memory: "main", removed: 2 });
		const left = memory
			.list()
			.map((note) => note.text)
			.sort();
		expect(left).toEqual([
			"A note with no expiry.",
			"Keep the cache.",
			"The cache was tried and missed.",
		]);
	});
});

describe("out and back in", () => {
	it("carries what a note is and where it stands", async () => {
		await memory.remember({
			text: "Releases come from full-build-release.",
			kind: "decision",
			reason: "main carries work in progress",
			places: ["docs/RELEASE.md"],
		});
		memory.settle("m1", { status: "confirmed" });
		const file = memory.exportMemory("main");
		const other = new Memory({
			directory: join(root, "other"),
			runtimeDirectory: join(root, "no-runtime"),
		});
		try {
			await other.importMemory(file, { into: "main" });
			expect(other.list()[0]).toMatchObject({
				kind: "decision",
				status: "confirmed",
				reason: "main carries work in progress",
				places: [{ path: "docs/RELEASE.md" }],
				origin: { by: "import" },
			});
		} finally {
			await other.close();
		}
	});
});

describe("automatic recall by place", () => {
	const settings: MemorySettings = {
		...DEFAULT_MEMORY_SETTINGS,
		enabled: true,
	};

	it("adds the notes at the files in play after the message's own, and none it marked outdated", async () => {
		await memory.remember({ text: "Tests are run with vitest, never jest." });
		await memory.remember({
			text: "The retry window is in deciseconds.",
			places: ["src/net/backoff.ts:148"],
		});
		await memory.remember({
			text: "The backoff doubles each time.",
			places: ["src/net/backoff.ts:20"],
		});
		memory.settle("m3", { status: "outdated", reason: "it is linear now" });
		const recall = createMemoryRecaller({
			memory,
			getConfig: () => ({ settings }),
		});
		const result = await recall({
			prompt: "How are the tests run here, with jest?",
			cwd: root,
			places: ["src/net/backoff.ts"],
		});
		expect(result?.ids).toEqual(["m1", "m2"]);
		expect(result?.context).toContain("about src/net/backoff.ts in this task");
		expect(result?.context).not.toContain("doubles");
	});
});
