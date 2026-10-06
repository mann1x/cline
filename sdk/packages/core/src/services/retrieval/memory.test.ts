import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentToolContext,
	DEFAULT_MEMORY_SETTINGS,
	type MemorySettings,
	resolveMemorySettings,
} from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createMemoryTools,
	type MemoryToolsConfig,
} from "../../extensions/tools/memory-tools";
import { MEMORY_MAX_CHARS, Memory } from "./memory";

describe("resolveMemorySettings", () => {
	it("gives the defaults for nothing stored, and keeps values in range", () => {
		expect(resolveMemorySettings(undefined)).toEqual(DEFAULT_MEMORY_SETTINGS);
		expect(DEFAULT_MEMORY_SETTINGS).toMatchObject({
			enabled: false,
			recallCount: 5,
			defaultScope: "project",
		});
		expect(
			resolveMemorySettings({
				recallCount: 900,
				relevanceThreshold: -2,
				defaultScope: "everywhere",
			}),
		).toMatchObject({
			recallCount: 50,
			relevanceThreshold: 0,
			defaultScope: "project",
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

	it("keeps a note and finds it again", async () => {
		const kept = await memory.remember({
			text: "Tests run with `bun run test:unit`; vitest, not bun test.",
			scope: "project",
			project: "/work/app",
			tags: ["testing", " testing ", "build"],
		});
		expect(kept.outcome).toBe("added");
		expect(kept.item).toMatchObject({
			id: "m1",
			scope: "project",
			project: "/work/app",
			tags: ["testing", "build"],
		});
		const found = await memory.recall("how do I run the tests", {
			project: "/work/app",
		});
		expect(found.items).toHaveLength(1);
		expect(found.items[0].text).toBe(
			"Tests run with `bun run test:unit`; vitest, not bun test.",
		);
		expect(found.items[0].id).toBe("m1");
	});

	it("keeps the same note once", async () => {
		const input = { text: "The user prefers tabs.", scope: "global" as const };
		await memory.remember(input);
		const again = await memory.remember({
			...input,
			text: "  The user prefers tabs.  ",
		});
		expect(again.outcome).toBe("unchanged");
		expect(memory.list()).toHaveLength(1);
	});

	it("shows a project its own notes and the global ones, and no other project's", async () => {
		await memory.remember({
			text: "Deploys go through the staging script.",
			scope: "project",
			project: "/work/app",
		});
		await memory.remember({
			text: "Deploys here are manual, by scp.",
			scope: "project",
			project: "/work/other",
		});
		await memory.remember({
			text: "The user wants deploys confirmed first.",
			scope: "global",
		});

		const inApp = await memory.recall("deploys", { project: "/work/app" });
		expect(inApp.items.map((item) => item.text).sort()).toEqual([
			"Deploys go through the staging script.",
			"The user wants deploys confirmed first.",
		]);
		expect(
			(
				await memory.recall("deploys", {
					project: "/work/app",
					scope: "project",
				})
			).items,
		).toHaveLength(1);
		expect(
			(
				await memory.recall("deploys", {
					project: "/work/app",
					scope: "global",
				})
			).items[0].scope,
		).toBe("global");
		// With no project there are only the global notes.
		expect(
			(await memory.recall("deploys")).items.map((item) => item.scope),
		).toEqual(["global"]);
		expect(memory.list({ project: "/work/other" })).toHaveLength(2);
	});

	it("forgets a note, and only one within reach", async () => {
		const mine = await memory.remember({
			text: "Port 8080 is taken by the proxy.",
			scope: "project",
			project: "/work/app",
		});
		const theirs = await memory.remember({
			text: "Port 9090 is the metrics port.",
			scope: "project",
			project: "/work/other",
		});
		expect(await memory.forget(theirs.item.id, { project: "/work/app" })).toBe(
			false,
		);
		expect(await memory.forget("m999", { project: "/work/app" })).toBe(false);
		expect(await memory.forget("nonsense", { project: "/work/app" })).toBe(
			false,
		);
		expect(
			await memory.forget(mine.item.id.toUpperCase(), { project: "/work/app" }),
		).toBe(true);
		expect(
			(await memory.recall("port", { project: "/work/app" })).items,
		).toEqual([]);
		expect(
			(await memory.recall("port", { project: "/work/other" })).items,
		).toHaveLength(1);
	});

	it("refuses an empty note, an overlong one, and a project note with no project", async () => {
		await expect(
			memory.remember({ text: "  ", scope: "global" }),
		).rejects.toThrow(/empty/);
		await expect(
			memory.remember({
				text: "x".repeat(MEMORY_MAX_CHARS + 1),
				scope: "global",
			}),
		).rejects.toThrow(/at most 4000.*Library/);
		await expect(
			memory.remember({ text: "a fact", scope: "project" }),
		).rejects.toThrow(/needs the project/);
	});

	it("returns a long note whole, once", async () => {
		const text =
			`Release steps: ${"tag, build, upload, announce; ".repeat(100)}`.trim();
		await memory.remember({ text, scope: "global" });
		const found = await memory.recall("release upload");
		expect(found.items).toHaveLength(1);
		expect(found.items[0].text).toBe(text);
	});

	it("returns no more than asked", async () => {
		for (const n of [1, 2, 3, 4]) {
			await memory.remember({
				text: `Build note number ${n}.`,
				scope: "global",
			});
		}
		expect(
			(await memory.recall("build note", { limit: 2 })).items,
		).toHaveLength(2);
		expect(
			(
				await memory.recall("build note", {
					settings: { ...DEFAULT_MEMORY_SETTINGS, recallCount: 3 },
				})
			).items,
		).toHaveLength(3);
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
		expect(tools()).toEqual({});
		config = on();
		expect(Object.keys(tools())).toEqual(["remember", "recall", "forget"]);
	});

	it("stops answering when Memory is turned off mid-session", async () => {
		const recall = tools().recall;
		config = on({ enabled: false });
		expect(String(await recall.execute({ query: "x" }, CONTEXT))).toMatch(
			/turned off.*Settings > Memory/,
		);
	});

	it("remembers in the project by default, and recalls with the id, date and tags", async () => {
		expect(
			await call("remember", {
				text: "The API client is generated; edit the spec, not the code.",
				tags: "api, codegen",
			}),
		).toBe("Remembered as m1 (this project).");
		const found = await call("recall", { query: "API client" });
		expect(found).toMatch(
			/^Memory: 1 note about "API client", best first\. Noted in earlier tasks; check they still hold\./,
		);
		expect(found).toMatch(
			/\[m1\] \d{4}-\d{2}-\d{2}, project, tags: api, codegen\nThe API client is generated/,
		);
		// Another project does not see it.
		expect(
			await call("recall", { query: "API client" }, "/work/other"),
		).toMatch(/nothing about "API client"/);
	});

	it("keeps a global note for every project, by the user's default or when asked", async () => {
		expect(
			await call("remember", {
				text: "The user wants commits confirmed.",
				scope: "global",
			}),
		).toBe("Remembered as m1 (global: every project).");
		config = on({ defaultScope: "global" });
		expect(
			await call("remember", { text: "The user writes British English." }),
		).toMatch(/global: every project/);
		expect(await call("recall", { query: "user" }, "/elsewhere")).toMatch(
			/2 notes about "user"/,
		);
		expect(
			await call("remember", {
				text: "The user wants commits confirmed.",
				scope: "global",
			}),
		).toBe("Already remembered as m1 (global); nothing was added.");
	});

	it("lists the newest notes when asked with no query", async () => {
		expect(await call("recall", {})).toBe(
			"Memory holds nothing for this project yet. remember keeps a note.",
		);
		await call("remember", { text: "First fact." });
		await call("remember", { text: "Second fact." });
		const listed = await call("recall", { limit: 1 });
		expect(listed).toMatch(/^Memory: the 1 newest of 2 notes\./);
	});

	it("forgets by id and says so when there is no such note", async () => {
		await call("remember", { text: "A wrong fact." });
		expect(await call("forget", { id: "m7" })).toBe(
			"There is no note m7 for this project. recall shows the ids.",
		);
		expect(await call("forget", {})).toMatch(/needs the `id`/);
		expect(await call("forget", { id: "m1" })).toBe("Forgot m1.");
		expect(await call("recall", { query: "wrong fact" })).toMatch(
			/nothing about/,
		);
	});

	it("says why a note was not kept", async () => {
		expect(await call("remember", { text: "" })).toBe(
			"Not remembered: There is nothing to remember: the text is empty.",
		);
		expect(await call("remember", { text: "y".repeat(5000) })).toMatch(
			/^Not remembered: That is 5000 characters/,
		);
	});
});
