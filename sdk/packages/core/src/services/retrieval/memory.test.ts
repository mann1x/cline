import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentToolContext,
	DEFAULT_LIBRARY_SETTINGS,
	DEFAULT_MEMORY_SETTINGS,
	MAIN_MEMORY,
	type MemorySettings,
	memorySelectionFor,
	memoryWorkspaceKey,
	resolveMemorySettings,
} from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createMemoryTools,
	type MemoryToolsConfig,
} from "../../extensions/tools/memory-tools";
import { Library } from "./library";
import { MEMORY_MAX_CHARS, Memory } from "./memory";

describe("resolveMemorySettings", () => {
	it("gives the defaults for nothing stored, and keeps values in range", () => {
		expect(resolveMemorySettings(undefined)).toEqual(DEFAULT_MEMORY_SETTINGS);
		expect(
			resolveMemorySettings({
				enabled: true,
				recallCount: 500,
				relevanceThreshold: -3,
			}),
		).toMatchObject({ enabled: true, recallCount: 50, relevanceThreshold: 0 });
	});

	it("starts every workspace on the main memory, for storing and for recall", () => {
		expect(memorySelectionFor(DEFAULT_MEMORY_SETTINGS, "/work/app")).toEqual({
			store: MAIN_MEMORY,
			recall: [MAIN_MEMORY],
		});
	});

	it("files a workspace's choice under one key, however the path is written", () => {
		expect(memoryWorkspaceKey("C:\\Dev\\App\\")).toBe("c:/dev/app");
		expect(memoryWorkspaceKey("/work/App/")).toBe("/work/App");
		const settings = resolveMemorySettings({
			selections: {
				"C:\\Dev\\App": { store: "app", recall: ["app", " main ", "app"] },
				"/bad": "nonsense",
				"/half": { recall: "x" },
			},
		});
		expect(memorySelectionFor(settings, "c:/dev/app/")).toEqual({
			store: "app",
			recall: ["app", "main"],
		});
		expect(settings.selections["/bad"]).toBeUndefined();
		// A broken entry reads as the default, not as "recall nothing".
		expect(settings.selections["/half"]).toEqual({
			store: MAIN_MEMORY,
			recall: [MAIN_MEMORY],
		});
	});
});

describe("Memory", () => {
	let root: string;
	let memory: Memory;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "memory-"));
		memory = new Memory({
			directory: join(root, "memory"),
			runtimeDirectory: join(root, "no-runtime"),
		});
	});
	afterEach(async () => {
		await memory.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("has a main memory from the start, which cannot be deleted", async () => {
		expect(memory.listMemories()).toMatchObject([
			{ name: "main", main: true, notes: 0 },
		]);
		await expect(memory.deleteMemory("main")).rejects.toThrow(
			"cannot be deleted",
		);
	});

	it("makes memories, lists them main first with their notes, and refuses a name twice", async () => {
		memory.createMemory({ name: "  tally   app ", workspace: "/work/tally/" });
		memory.createMemory({ name: "acme" });
		await memory.remember({
			text: "Deploys go out on Fridays.",
			memory: "acme",
		});
		expect(memory.listMemories()).toMatchObject([
			{ name: "main", main: true, notes: 0 },
			{ name: "acme", main: false, notes: 1 },
			{ name: "tally app", main: false, notes: 0, workspace: "/work/tally" },
		]);
		expect(() => memory.createMemory({ name: "acme" })).toThrow(
			'already a memory named "acme"',
		);
		expect(() => memory.createMemory({ name: "   " })).toThrow("needs a name");
	});

	it("deletes a memory with its notes", async () => {
		memory.createMemory({ name: "acme", workspace: "/work/acme" });
		await memory.remember({
			text: "Deploys go out on Fridays.",
			memory: "acme",
		});
		expect(await memory.deleteMemory("acme")).toBe(1);
		expect(memory.listMemories().map((entry) => entry.name)).toEqual(["main"]);
		// The name is free again, and comes back without the old workspace.
		expect(memory.createMemory({ name: "acme" }).workspace).toBeUndefined();
		await expect(memory.deleteMemory("nope")).rejects.toThrow("no memory");
	});

	it("keeps a note and finds it again", async () => {
		const kept = await memory.remember({
			text: "Tests are run with node --test, never with jest.",
			tags: ["testing", " build ", "testing"],
		});
		expect(kept.outcome).toBe("added");
		expect(kept.item).toMatchObject({
			id: "m1",
			memory: "main",
			tags: ["testing", "build"],
		});
		const found = await memory.recall("how are the tests run");
		expect(found.items.map((item) => item.id)).toEqual(["m1"]);
		expect(found.items[0].text).toContain("node --test");
	});

	it("keeps the same note once in a memory, and again in another", async () => {
		memory.createMemory({ name: "acme" });
		const text = "Two-space indentation.";
		await memory.remember({ text });
		expect((await memory.remember({ text })).outcome).toBe("unchanged");
		expect((await memory.remember({ text, memory: "acme" })).outcome).toBe(
			"added",
		);
	});

	it("searches only the memories it is given", async () => {
		memory.createMemory({ name: "acme" });
		memory.createMemory({ name: "tally" });
		await memory.remember({ text: "Main: tests run on every push." });
		await memory.remember({
			text: "Acme: tests need the VPN.",
			memory: "acme",
		});
		await memory.remember({
			text: "Tally: tests use node --test.",
			memory: "tally",
		});
		const ids = async (memories?: string[]) =>
			(await memory.recall("tests", { memories })).items
				.map((item) => item.memory)
				.sort();
		expect(await ids()).toEqual(["main"]);
		expect(await ids(["acme", "tally"])).toEqual(["acme", "tally"]);
		expect(await ids(["gone"])).toEqual([]);
		expect(memory.list({ memories: ["acme"] }).map((i) => i.memory)).toEqual([
			"acme",
		]);
	});

	it("forgets a note only in the memories it is given", async () => {
		memory.createMemory({ name: "acme" });
		await memory.remember({
			text: "Acme: tests need the VPN.",
			memory: "acme",
		});
		expect(await memory.forget("m1")).toBe(false);
		expect(await memory.forget("nonsense", { memories: ["acme"] })).toBe(false);
		expect(await memory.forget("M1", { memories: ["acme"] })).toBe(true);
		expect(memory.list({ memories: ["acme"] })).toEqual([]);
	});

	it("refuses an empty note, an overlong one, and a memory that is not there", async () => {
		await expect(memory.remember({ text: "  " })).rejects.toThrow("empty");
		await expect(
			memory.remember({ text: "x".repeat(MEMORY_MAX_CHARS + 1) }),
		).rejects.toThrow("at most");
		await expect(
			memory.remember({ text: "A fact.", memory: "gone" }),
		).rejects.toThrow('no memory named "gone"');
	});

	it("returns a long note whole, once, and no more than asked", async () => {
		const long = `Deploy steps. ${"Step: run the deploy script and wait. ".repeat(60)}`;
		await memory.remember({ text: long });
		for (const n of [1, 2, 3]) {
			await memory.remember({ text: `Deploy fact number ${n}.` });
		}
		const found = await memory.recall("deploy", { limit: 2 });
		expect(found.items).toHaveLength(2);
		const all = await memory.recall("deploy script", { limit: 10 });
		expect(all.items.filter((item) => item.id === "m1")).toHaveLength(1);
		expect(all.items.find((item) => item.id === "m1")?.text).toBe(long.trim());
	});

	it("writes a memory out and reads it back in, dates and tags kept, twice without doubling", async () => {
		memory.createMemory({ name: "acme", workspace: "/work/acme" });
		await memory.remember({
			text: "Deploys go out on Fridays.",
			memory: "acme",
			tags: ["deploy"],
			createdAt: "2026-01-05T10:00:00.000Z",
		});
		await memory.remember({
			text: "The VPN is needed for tests.",
			memory: "acme",
		});
		const file = JSON.parse(JSON.stringify(memory.exportMemory("acme")));
		expect(file).toMatchObject({
			format: "cerebriline-memory",
			version: 1,
			name: "acme",
			workspace: "/work/acme",
		});
		expect(file.notes).toHaveLength(2);
		expect(file.notes[0]).toEqual({
			text: "Deploys go out on Fridays.",
			tags: ["deploy"],
			createdAt: "2026-01-05T10:00:00.000Z",
		});

		const other = new Memory({
			directory: join(root, "other"),
			runtimeDirectory: join(root, "no-runtime"),
		});
		try {
			expect(await other.importMemory(file)).toEqual({
				memory: "acme",
				created: true,
				added: 2,
				unchanged: 0,
				skipped: 0,
			});
			expect(await other.importMemory(file)).toMatchObject({
				created: false,
				added: 0,
				unchanged: 2,
			});
			const notes = other.list({ memories: ["acme"] });
			expect(notes).toHaveLength(2);
			expect(
				notes.find((note) => note.text.startsWith("Deploys")),
			).toMatchObject({
				tags: ["deploy"],
				createdAt: "2026-01-05T10:00:00.000Z",
			});
			// Into a memory of the user's choosing, and bad notes are counted.
			expect(
				await other.importMemory(
					{ ...file, notes: [...file.notes, { text: "" }, { text: 7 }] },
					{ into: "main" },
				),
			).toEqual({
				memory: "main",
				created: false,
				added: 2,
				unchanged: 0,
				skipped: 2,
			});
		} finally {
			await other.close();
		}
		await expect(memory.importMemory({ notes: [] })).rejects.toThrow(
			"not an exported memory",
		);
		expect(() => memory.exportMemory("gone")).toThrow("no memory");
	});

	it("brings the first build's store to the new names: global is main, a project is a memory of its own", async () => {
		const directory = join(root, "legacy");
		const library = new Library({
			directory,
			runtimeDirectory: join(root, "no-runtime"),
		});
		const settings = { ...DEFAULT_LIBRARY_SETTINGS, enabled: true };
		await library.addDocument(
			"global",
			{ source: "memory:a", text: "Two-space indentation.", metadata: {} },
			settings,
		);
		await library.addDocument(
			"project:/work/tally",
			{ source: "memory:b", text: "Tests use node --test.", metadata: {} },
			settings,
		);
		await library.close();

		const old = new Memory({
			directory,
			runtimeDirectory: join(root, "no-runtime"),
		});
		try {
			expect(old.listMemories()).toMatchObject([
				{ name: "main", main: true, notes: 1 },
				{ name: "tally", notes: 1, workspace: "/work/tally" },
			]);
			expect(
				(await old.recall("tests", { memories: ["tally"] })).items,
			).toHaveLength(1);
			expect(old.list().map((note) => note.text)).toEqual([
				"Two-space indentation.",
			]);
		} finally {
			await old.close();
		}
	});
});

describe("the memory tools", () => {
	let root: string;
	let memory: Memory;
	let config: MemoryToolsConfig | undefined;
	const CONTEXT = {} as AgentToolContext;
	const on = (settings: Partial<MemorySettings> = {}): MemoryToolsConfig => ({
		settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: true, ...settings },
	});
	const tools = (cwd = "/work/app") =>
		Object.fromEntries(
			createMemoryTools({ cwd, getConfig: () => config, memory }).map(
				(tool) => [tool.name, tool],
			),
		);
	const call = async (name: string, input: unknown, cwd?: string) =>
		String(await tools(cwd)[name].execute(input, CONTEXT));

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "memory-tools-"));
		memory = new Memory({
			directory: join(root, "memory"),
			runtimeDirectory: join(root, "no-runtime"),
		});
		config = on();
	});
	afterEach(async () => {
		await memory.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("offers nothing while Memory is off, and three tools when it is on", () => {
		config = undefined;
		expect(createMemoryTools({ cwd: "/w", getConfig: () => config })).toEqual(
			[],
		);
		config = on();
		expect(Object.keys(tools())).toEqual(["remember", "recall", "forget"]);
	});

	it("takes no memory name: the model cannot choose where it reads or writes", () => {
		const { remember, recall } = tools();
		const fields = (tool: { inputSchema: unknown }) =>
			Object.keys(
				(tool.inputSchema as { properties: Record<string, unknown> })
					.properties,
			);
		expect(fields(remember)).toEqual(["text", "tags"]);
		expect(fields(recall)).toEqual(["query", "limit"]);
	});

	it("stops answering when Memory is turned off mid-session", async () => {
		const held = tools();
		config = undefined;
		expect(String(await held.recall.execute({}, CONTEXT))).toContain(
			"turned off",
		);
	});

	it("stores to and recalls from the main memory until the user says otherwise", async () => {
		expect(
			await call("remember", {
				text: "Tests use node --test.",
				tags: "testing",
			}),
		).toBe('Remembered as m1 in the "main" memory.');
		expect(
			await call("remember", { text: "Tests use node --test." }),
		).toContain("Already remembered as m1");
		const found = await call("recall", { query: "tests" });
		expect(found).toContain("[m1] ");
		expect(found).toContain(", main, tags: testing");
		// Another workspace is on the main memory too.
		expect(await call("recall", { query: "tests" }, "/work/other")).toContain(
			"[m1]",
		);
	});

	it("stores to the one memory the workspace is set to, and recalls from the ones it is allowed", async () => {
		memory.createMemory({ name: "app" });
		memory.createMemory({ name: "acme" });
		memory.createMemory({ name: "private" });
		await memory.remember({ text: "Main: tests on every push." });
		await memory.remember({
			text: "Acme: tests need the VPN.",
			memory: "acme",
		});
		await memory.remember({
			text: "Private: tests secret.",
			memory: "private",
		});
		config = on({
			selections: { "/work/app": { store: "app", recall: ["app", "acme"] } },
		});
		expect(
			await call("remember", { text: "App: tests use node --test." }),
		).toBe('Remembered as m4 in the "app" memory.');
		const found = await call("recall", { query: "tests" });
		expect(found).toContain("App: tests");
		expect(found).toContain("Acme: tests");
		expect(found).not.toContain("Main: tests");
		expect(found).not.toContain("Private: tests");
		const listed = await call("recall", {});
		expect(listed).toContain("the 2 newest of 2 notes");
	});

	it("forgets only in the memory the workspace stores to", async () => {
		memory.createMemory({ name: "app" });
		await memory.remember({ text: "Main: tests on every push." });
		config = on({
			selections: { "/work/app": { store: "app", recall: ["app", "main"] } },
		});
		await call("remember", { text: "App: tests use node --test." });
		expect(await call("forget", { id: "m1" })).toContain(
			'no note m1 in the "app" memory',
		);
		expect(await call("forget", { id: "m2" })).toBe("Forgot m2.");
		expect(memory.list()).toHaveLength(1);
		expect(await call("forget", {})).toContain("needs the `id`");
	});

	it("keeps a note in the main memory when the chosen one was deleted, and says so", async () => {
		config = on({
			selections: { "/work/app": { store: "gone", recall: ["gone"] } },
		});
		expect(await call("remember", { text: "A fact worth keeping." })).toBe(
			'Remembered as m1 in the "main" memory. The memory chosen for this workspace, "gone", no longer exists.',
		);
		expect(await call("recall", { query: "fact" })).toContain(
			"No memory is open for reading",
		);
	});

	it("says why a note was not kept", async () => {
		expect(await call("remember", { text: "" })).toContain("Not remembered");
	});
});
