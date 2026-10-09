import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_LIBRARY_SETTINGS, type LibrarySettings } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodeIndex } from "../../services/retrieval/code-index";
import {
	type CodeSearchConfig,
	codeSearchAvailable,
	createCodeSearch,
	semanticSearchForAgent,
} from "./code-search";
import { createSearchTool } from "./definitions";

const context = { agentId: "agent-1", conversationId: "conv-1", iteration: 1 };
const embedding = { baseUrl: "http://embedder.invalid", model: "embed-test" };

describe("code search", () => {
	let directory: string;
	let workspace: string;
	let index: CodeIndex;
	let settings: LibrarySettings;
	let config: CodeSearchConfig;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), "code-search-"));
		workspace = await mkdtemp(join(tmpdir(), "code-search-ws-"));
		const target = join(workspace, "src/billing/invoice.ts");
		await mkdir(dirname(target), { recursive: true });
		await writeFile(
			target,
			[
				"// Totals for an invoice.",
				"export function invoiceTotal(lines: Line[]): number {",
				"\treturn lines.reduce((sum, line) => sum + line.amount, 0);",
				"}",
			].join("\n"),
		);
		// No embedder answers in a unit test: the index falls back to keywords,
		// which is the path a search takes before the first vectors exist.
		index = new CodeIndex({
			directory,
			fetch: (async () => {
				throw new Error("no embedder in this test");
			}) as unknown as typeof fetch,
		});
		settings = {
			...DEFAULT_LIBRARY_SETTINGS,
			codeIndexWorkspaces: [workspace],
		};
		config = { settings, embedding };
	});

	afterEach(async () => {
		await index.close();
		await rm(directory, { recursive: true, force: true });
		await rm(workspace, { recursive: true, force: true });
	});

	it("is offered only for a folder that is opted in and has an embedding model", () => {
		expect(codeSearchAvailable(config, workspace)).toBe(true);
		expect(codeSearchAvailable(config, `${workspace}/`)).toBe(true);
		expect(codeSearchAvailable({ settings }, workspace)).toBe(false);
		expect(codeSearchAvailable(config, join(workspace, "src"))).toBe(false);
		expect(
			codeSearchAvailable(
				{ settings: DEFAULT_LIBRARY_SETTINGS, embedding },
				workspace,
			),
		).toBe(false);
	});

	it("answers with the file and lines of each passage", async () => {
		await index.sync(workspace);
		const search = createCodeSearch({ getConfig: () => config, index });

		const result = await search.search(
			"invoiceTotal amount",
			workspace,
			context,
		);

		expect(result).toContain("src/billing/invoice.ts:1-4");
		expect(result).toContain("export function invoiceTotal");
	});

	it("reads the folder on refresh and reports why embedding stopped", async () => {
		const log = vi.fn();
		const search = createCodeSearch({ getConfig: () => config, index, log });

		// Two calls at once are one run.
		await Promise.all([search.refresh(workspace), search.refresh(workspace)]);

		expect(index.status(workspace)).toMatchObject({ indexed: true, files: 1 });
		expect(
			log.mock.calls.filter(([line]) => /1 files/.test(line)),
		).toHaveLength(1);
		const state = search.state(workspace);
		expect(state.running).toBe(false);
		expect(state.problem).toBeTruthy();
		const result = await search.search("invoiceTotal", workspace, context);
		expect(result).toContain("The index is not up to date");
	});

	it("does nothing on refresh for a folder that is not opted in", async () => {
		const search = createCodeSearch({
			getConfig: () => ({ settings: DEFAULT_LIBRARY_SETTINGS, embedding }),
			index,
		});

		await search.refresh(workspace);

		expect(index.status(workspace).indexed).toBe(false);
	});

	it("refuses a search once the folder's index is turned off", async () => {
		let current = config;
		const search = createCodeSearch({ getConfig: () => current, index });
		current = { settings: DEFAULT_LIBRARY_SETTINGS, embedding };

		await expect(search.search("x", workspace, context)).rejects.toThrow(
			/turned off/,
		);
	});
});

describe("a delegated agent's code search", () => {
	const lead = {
		available: (cwd: string) => cwd === "/ws",
		search: vi.fn(async (..._args: unknown[]) => "hits"),
	};

	it("is absent when the lead has none, and the lead's own without an overlay", () => {
		expect(semanticSearchForAgent(undefined, undefined)).toBeUndefined();
		expect(semanticSearchForAgent(lead, undefined)).toBe(lead);
	});

	it("answers for the same folders and reads lines through the agent's copy", async () => {
		const overlay = {
			read: vi.fn(async (path: string) => Buffer.from(`agent copy of ${path}`)),
		};
		const agent = semanticSearchForAgent(lead, overlay);

		expect(agent?.available("/ws")).toBe(true);
		expect(agent?.available("/elsewhere")).toBe(false);
		await agent?.search("q", "/ws", context);

		const options = lead.search.mock.calls[0]?.[3] as {
			readFile: (path: string) => Promise<string | undefined>;
		};
		expect(await options.readFile("/ws/a.ts")).toBe("agent copy of /ws/a.ts");
		expect(overlay.read).toHaveBeenCalledWith("/ws/a.ts");
	});

	it("gives a passage the lines it is on in the agent's edited copy", async () => {
		const directory = await mkdtemp(join(tmpdir(), "code-search-agent-"));
		const workspace = await mkdtemp(join(tmpdir(), "code-search-agent-ws-"));
		const index = new CodeIndex({ directory });
		try {
			const passage =
				"export function invoiceTotal(lines: number[]) {\n\treturn 0;\n}";
			await writeFile(join(workspace, "invoice.ts"), passage);
			await index.sync(workspace);
			const settings = {
				...DEFAULT_LIBRARY_SETTINGS,
				codeIndexWorkspaces: [workspace],
			};
			const search = createCodeSearch({
				getConfig: () => ({ settings, embedding }),
				index,
			});
			// The agent put three lines above it; the lead's file has not moved.
			const agent = semanticSearchForAgent(search, {
				read: async () => Buffer.from(`// a\n// b\n// c\n${passage}`),
			});

			expect(await search.search("invoiceTotal", workspace, context)).toContain(
				"invoice.ts:1-3",
			);
			expect(await agent?.search("invoiceTotal", workspace, context)).toContain(
				"invoice.ts:4-6",
			);
		} finally {
			await index.close();
			await rm(directory, { recursive: true, force: true });
			await rm(workspace, { recursive: true, force: true });
		}
	});
});

describe("search_codebase semantic mode", () => {
	const regex = vi.fn(async (_query: string) => "regex result");
	const semantic = vi.fn(async (_query: string) => "semantic result");

	beforeEach(() => {
		regex.mockClear();
		semantic.mockClear();
	});

	it("is not in the schema or the description without an index", () => {
		const tool = createSearchTool(regex);

		expect(JSON.stringify(tool.inputSchema)).not.toContain("semantic");
		expect(tool.description).not.toContain("semantic");
	});

	it("adds the mode when the workspace is indexed", () => {
		const tool = createSearchTool(regex, {}, semantic);
		const schema = tool.inputSchema as {
			properties: Record<string, { enum?: string[] }>;
		};

		expect(schema.properties.mode?.enum).toEqual(["regex", "semantic"]);
		expect(schema.properties.queries).toBeDefined();
		expect(tool.description).toContain('mode: "semantic"');
	});

	it("routes semantic queries to the index and everything else to the regex search", async () => {
		const tool = createSearchTool(regex, {}, semantic);

		const bySense = await tool.execute(
			{ queries: ["where is the total computed"], mode: "semantic" } as never,
			context,
		);
		const byPattern = await tool.execute(
			{ queries: ["invoiceTotal"], mode: "regex" } as never,
			context,
		);
		await tool.execute({ queries: ["invoiceTotal"] }, context);

		expect(bySense).toEqual([
			{
				query: "where is the total computed",
				result: "semantic result",
				success: true,
			},
		]);
		expect(byPattern[0]?.result).toBe("regex result");
		expect(semantic).toHaveBeenCalledTimes(1);
		expect(regex).toHaveBeenCalledTimes(2);
	});

	it("takes the singular query in semantic mode too", async () => {
		const tool = createSearchTool(regex, {}, semantic);

		await tool.execute(
			{ query: "how are totals rounded", mode: "semantic" } as never,
			context,
		);

		expect(semantic.mock.calls[0]?.[0]).toBe("how are totals rounded");
	});

	it("ignores the mode where there is no index, and searches by pattern", async () => {
		const tool = createSearchTool(regex);

		await tool.execute({ queries: ["x"], mode: "semantic" } as never, context);

		expect(regex).toHaveBeenCalledTimes(1);
	});

	it("says to fall back to a regex when the index fails", async () => {
		const tool = createSearchTool(regex, {}, async () => {
			throw new Error("embedder is down");
		});

		const result = await tool.execute(
			{ queries: ["x"], mode: "semantic" } as never,
			context,
		);

		expect(result[0]).toMatchObject({ success: false });
		expect(result[0]?.error).toMatch(/embedder is down.*regex/);
	});
});
