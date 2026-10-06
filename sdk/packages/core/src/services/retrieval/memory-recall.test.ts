import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_MEMORY_SETTINGS,
	type MemorySettings,
	stripModeNotices,
} from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Memory } from "./memory";
import {
	clampRecallQuery,
	contentWords,
	createMemoryRecaller,
	fuseRecalls,
	isAboutTheSearch,
	type MemoryQueryExpander,
} from "./memory-recall";

describe("automatic recall", () => {
	let root: string;
	let memory: Memory;
	let settings: MemorySettings;
	const project = "/work/tally";

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "memory-recall-"));
		memory = new Memory({ directory: root });
		settings = { ...DEFAULT_MEMORY_SETTINGS, enabled: true };
		await memory.remember({
			text: "Tests are run with node --test, never with jest: jest broke the ESM build twice.",
			scope: "project",
			project,
			tags: ["testing"],
		});
		await memory.remember({
			text: "The user wants two-space indentation in every project.",
			scope: "global",
			tags: ["style"],
		});
	});
	afterEach(async () => {
		await memory.close();
		rmSync(root, { recursive: true, force: true });
	});

	const recaller = (expander?: MemoryQueryExpander) =>
		createMemoryRecaller({
			memory,
			getConfig: () => ({ settings }),
			getExpander: () => expander,
		});

	it("finds the notes a message is about and wraps them for the model only", async () => {
		const result = await recaller()({
			prompt: "How do I run the tests of this project?",
			cwd: project,
		});
		expect(result?.ids).toEqual(["m1"]);
		expect(result?.expanded).toBe(false);
		expect(result?.context).toContain("node --test");
		expect(result?.context).toMatch(
			/^<recalled_memory>[\s\S]*<\/recalled_memory>$/,
		);
		expect(result?.summary).toBe("Recalled 1 note from Memory (m1).");
		// Where the message is shown, the notes are not part of it.
		expect(stripModeNotices(`Which runner?\n\n${result?.context}`)).toBe(
			"Which runner?",
		);
	});

	it("does nothing while Memory or automatic recall is off, or for a message too short to search with", async () => {
		const ask = { prompt: "How are the tests run here?", cwd: project };
		settings = { ...settings, autoRecall: false };
		expect(await recaller()(ask)).toBeUndefined();
		settings = { ...settings, autoRecall: true, enabled: false };
		expect(await recaller()(ask)).toBeUndefined();
		settings = { ...settings, enabled: true };
		expect(
			await recaller()({ prompt: "continue", cwd: project }),
		).toBeUndefined();
		expect(await recaller()(ask)).toBeDefined();
	});

	it("gives a session each note once", async () => {
		const recall = recaller();
		const ask = {
			prompt: "How are the tests run here?",
			cwd: project,
			sessionId: "s1",
		};
		expect((await recall(ask))?.ids).toEqual(["m1"]);
		expect(await recall(ask)).toBeUndefined();
		expect((await recall({ ...ask, sessionId: "s2" }))?.ids).toEqual(["m1"]);
	});

	it("keeps another project's notes out", async () => {
		const result = await recaller()({
			prompt: "How are the tests run here, with jest?",
			cwd: "/work/other",
		});
		expect(result).toBeUndefined();
	});

	it("does not expand unless it is on, and not when Memory holds nothing", async () => {
		const expander = vi.fn(async () => "indentation");
		await recaller(expander)({
			prompt: "How are the tests run here?",
			cwd: project,
		});
		expect(expander).not.toHaveBeenCalled();
		settings = { ...settings, hyde: true };
		const empty = new Memory({ directory: join(root, "empty") });
		await createMemoryRecaller({
			memory: empty,
			getConfig: () => ({ settings }),
			getExpander: () => expander,
		})({ prompt: "How are the tests run here?", cwd: project });
		await empty.close();
		expect(expander).not.toHaveBeenCalled();
	});

	it("searches again with the note a second model wrote, grounded on what was found", async () => {
		settings = { ...settings, hyde: true };
		const expander = vi.fn<MemoryQueryExpander>(
			async () => "Code style: two-space indentation is the preference.",
		);
		const recall = recaller(expander);
		const result = await recall({
			prompt: "How are the tests run here?",
			cwd: project,
		});
		expect(expander).toHaveBeenCalledTimes(1);
		const sent = expander.mock.calls[0][0];
		expect(sent.system).toContain("ONLY facts consistent with those notes");
		expect(sent.prompt).toContain("1. Tests are run with node --test");
		expect(sent.prompt).toContain("Message: How are the tests run here?");
		// The note only the expansion reaches is there, after the one the
		// user's own words found.
		expect(result?.ids).toEqual(["m1", "m2"]);
		expect(result?.expanded).toBe(true);
		expect(result?.summary).toContain("searched with an expanded question");
		// The same question is not paid for twice.
		await recall({ prompt: "How are the tests run here?", cwd: project });
		expect(expander).toHaveBeenCalledTimes(1);
	});

	it("finds by the expansion a note the message's own words miss", async () => {
		settings = { ...settings, hyde: true };
		const ask = {
			prompt: "How do I check my changes before I commit them?",
			cwd: project,
		};
		// By its own words the message is about neither note.
		settings = { ...settings, hyde: false };
		expect(await recaller()(ask)).toBeUndefined();
		settings = { ...settings, hyde: true };
		const expander = vi.fn<MemoryQueryExpander>(
			async () => "Changes are checked by running the tests with node --test.",
		);
		const result = await recaller(expander)(ask);
		// No word in common with any note: grounded on the newest ones.
		expect(expander.mock.calls[0][0].prompt).toContain("Related notes:\n1. ");
		expect(result?.ids).toEqual(["m1"]);
		expect(result?.expanded).toBe(true);
	});

	it("falls back to the first search when the expander fails, is empty, or is too slow", async () => {
		settings = { ...settings, hyde: true };
		const ask = { prompt: "How are the tests run here?", cwd: project };
		const failing = await recaller(async () => {
			throw new Error("503");
		})(ask);
		expect(failing?.ids).toEqual(["m1"]);
		expect(failing?.expanded).toBe(false);
		expect((await recaller(async () => "  ")(ask))?.expanded).toBe(false);
		const slow = createMemoryRecaller({
			memory,
			getConfig: () => ({ settings }),
			hydeTimeoutMs: 20,
			getExpander:
				() =>
				({ signal }) =>
					new Promise((_resolve, reject) => {
						signal.addEventListener("abort", () =>
							reject(new Error("aborted")),
						);
					}),
		});
		expect((await slow(ask))?.ids).toEqual(["m1"]);
	});

	it("never throws: a search that fails sends the message without notes", async () => {
		await memory.close();
		const broken = { recall: async () => Promise.reject(new Error("db")) };
		const recall = createMemoryRecaller({
			memory: broken as unknown as Memory,
			getConfig: () => ({ settings }),
		});
		expect(
			await recall({ prompt: "How are the tests run here?", cwd: project }),
		).toBeUndefined();
		memory = new Memory({ directory: root });
	});
});

describe("the pieces of automatic recall", () => {
	it("keeps both ends of an overlong message", () => {
		const text = `START ${"x".repeat(5000)} END`;
		const clamped = clampRecallQuery(text, 200);
		expect(clamped.length).toBeLessThanOrEqual(200);
		expect(clamped.startsWith("START")).toBe(true);
		expect(clamped.endsWith("END")).toBe(true);
		expect(clampRecallQuery("short")).toBe("short");
	});

	it("attaches a note only when something says it is about the search", () => {
		const note = (text: string, extra: object = {}) => ({
			id: "m1",
			text,
			scope: "project" as const,
			tags: [],
			createdAt: "2026-10-06T00:00:00.000Z",
			...extra,
		});
		expect([...contentWords("How are the tests run here?")]).toEqual([
			"test",
			"run",
		]);
		const tests = note("Tests are run with node --test.");
		expect(isAboutTheSearch("How are the tests run here?", tests)).toBe(true);
		// One word in common: the best of a poor lot.
		expect(
			isAboutTheSearch(
				"Where is the indentation of the build output configured?",
				note("Two-space indentation in every project."),
			),
		).toBe(false);
		// Words every note has are not counted at all.
		expect(
			isAboutTheSearch(
				"What is this project for?",
				note("Two-space indentation in every project."),
			),
		).toBe(false);
		// A one-word search is satisfied by its word.
		expect(isAboutTheSearch("jest?", note("Never jest."))).toBe(true);
		// Found by meaning with no word in common: close enough, or not.
		const french = "Les essais passent par le lanceur de node.";
		expect(isAboutTheSearch("tests", note(french, { similarity: 0.71 }))).toBe(
			true,
		);
		expect(isAboutTheSearch("tests", note(french, { similarity: 0.2 }))).toBe(
			false,
		);
		// The reranker's verdict stands.
		expect(isAboutTheSearch("tests", note(french, { relevance: 0.1 }))).toBe(
			true,
		);
	});

	it("fuses two rankings, a note in both ahead of a note in one", () => {
		const note = (id: string) => ({
			id,
			text: id,
			scope: "project" as const,
			tags: [],
			createdAt: "2026-10-06T00:00:00.000Z",
		});
		const fused = fuseRecalls(
			[note("m1"), note("m2")],
			[note("m3"), note("m2")],
			2,
		);
		expect(fused.map((item) => item.id)).toEqual(["m2", "m1"]);
	});
});
