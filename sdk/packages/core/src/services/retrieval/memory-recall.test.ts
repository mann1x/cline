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
	fitRecalledMemory,
	fuseRecalls,
	isAboutTheSearch,
	type MemoryQueryExpander,
	recallCharBudget,
	recalledMemoryIds,
} from "./memory-recall";

describe("automatic recall", () => {
	let root: string;
	let memory: Memory;
	let settings: MemorySettings;
	const project = "/work/tally";

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "memory-recall-"));
		memory = new Memory({ directory: root });
		memory.createMemory({ name: "tally", workspace: project });
		settings = {
			...DEFAULT_MEMORY_SETTINGS,
			enabled: true,
			selections: { [project]: { store: "tally", recall: ["tally", "main"] } },
		};
		await memory.remember({
			text: "Tests are run with node --test, never with jest: jest broke the ESM build twice.",
			memory: "tally",
			tags: ["testing"],
		});
		await memory.remember({
			text: "The user wants two-space indentation in every project.",
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

	it("gives a note again once a compaction folded it away, not while it is still there", async () => {
		const recall = recaller();
		const ask = {
			prompt: "How are the tests run here?",
			cwd: project,
			sessionId: "s1",
		};
		const first = await recall({ ...ask, inConversation: [] });
		expect(first?.ids).toEqual(["m1"]);
		// Still in the conversation: not given twice.
		const held = recalledMemoryIds([`How?\n\n${first?.context}`]);
		expect(held).toEqual(["m1"]);
		expect(await recall({ ...ask, inConversation: held })).toBeUndefined();
		// The compaction's digest did not keep it: given again.
		expect((await recall({ ...ask, inConversation: [] }))?.ids).toEqual(["m1"]);
	});

	it("bounds the notes by a share of the window, never by a count", async () => {
		await memory.remember({
			text: `Tests are run in CI too. ${"The suite is long. ".repeat(180)}`,
			memory: "tally",
			tags: ["testing"],
		});
		const ask = { prompt: "How are the tests run here?", cwd: project };
		const wide = await recaller()({ ...ask, contextWindow: 262_144 });
		expect(wide?.ids).toHaveLength(2);
		// 8k: 1146 characters, room for the short note only.
		const narrow = await recaller()({ ...ask, contextWindow: 8192 });
		expect(narrow?.ids).toEqual(["m1"]);
		expect(narrow?.summary).toContain("1 more did not fit the window");
		expect(narrow?.context?.length).toBeLessThan(recallCharBudget(8192) + 400);
	});

	it("says once a session that the search ran by keyword alone", async () => {
		const bare = new Memory({
			directory: join(root, "bare"),
			runtimeDirectory: join(root, "no-runtime"),
		});
		try {
			await bare.remember({ text: "Indentation is two spaces." });
			const recall = createMemoryRecaller({
				memory: bare,
				getConfig: () => ({
					settings: { ...settings, selections: {} },
					embedding: { baseUrl: "http://embed.test", model: "toy" },
				}),
			});
			const ask = {
				prompt: "Which deploy target do we use?",
				cwd: project,
				sessionId: "s1",
			};
			const first = await recall(ask);
			expect(first?.context).toBeUndefined();
			expect(first?.summary).toMatch(
				/^Memory found no note for this message\. Semantic search did not run \(.+\); searched by keyword\.$/,
			);
			expect(await recall(ask)).toBeUndefined();
		} finally {
			await bare.close();
		}
	});

	it("searches only the memories the workspace is allowed", async () => {
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
		const broken = {
			listMemories: () => memory.listMemories(),
			recall: async () => Promise.reject(new Error("db")),
		};
		const recall = createMemoryRecaller({
			memory: broken as unknown as Memory,
			getConfig: () => ({ settings }),
		});
		const failed = await recall({
			prompt: "How are the tests run here?",
			cwd: project,
			sessionId: "s1",
		});
		// No notes, and said so in words that are not "nothing found".
		expect(failed?.context).toBeUndefined();
		expect(failed?.failed).toBe("db");
		expect(failed?.summary).toBe(
			"Memory unreachable, the message went without notes: db",
		);
		// Once a session: the next message is not told again.
		const again = await recall({
			prompt: "And the build, how is it run?",
			cwd: project,
			sessionId: "s1",
		});
		expect(again?.failed).toBe("db");
		expect(again?.summary).toBeUndefined();
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
			memory: "main",
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
		// The reranker passes a note on its own only above its floor: the
		// user's threshold defaults to 0, which would pass every note.
		expect(isAboutTheSearch("tests", note(french, { relevance: 0.8 }))).toBe(
			true,
		);
		expect(isAboutTheSearch("tests", note(french, { relevance: 0.1 }))).toBe(
			false,
		);
		// Below it the other tests still stand.
		expect(
			isAboutTheSearch(
				"tests",
				note(french, { relevance: 0.1, similarity: 0.71 }),
			),
		).toBe(true);
	});

	it("always gives the best note, cut to fit, with the id to read it whole", () => {
		const big = {
			id: "m7",
			text: "x".repeat(5000),
			memory: "main",
			tags: [],
			createdAt: "2026-10-24T00:00:00Z",
		};
		const fitted = fitRecalledMemory([big], 1000);
		expect(fitted.cut).toBe("m7");
		expect(fitted.items[0].text.length).toBeLessThan(1000);
		expect(fitted.items[0].text).toContain("recall m7 for all of it");
		expect(fitRecalledMemory([], 1000)).toEqual({ items: [] });
	});

	it("reads back only the ids of notes recall attached", () => {
		expect(
			recalledMemoryIds([
				"[m3] 2026-01-01, main\nnot in a block",
				"<recalled_memory>\nNotes...\n\n[m4] 2026-01-02, main, tags: a\ntext\n[m5] 2026-01-03, tally\nmore\n</recalled_memory>",
			]),
		).toEqual(["m4", "m5"]);
	});

	it("fuses two rankings, a note in both ahead of a note in one", () => {
		const note = (id: string) => ({
			id,
			text: id,
			memory: "main",
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
