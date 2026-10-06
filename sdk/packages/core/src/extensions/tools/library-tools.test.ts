import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolContext } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Library } from "../../services/retrieval/library";
import {
	DEFAULT_LIBRARY_SETTINGS,
	type LibrarySettings,
} from "../../services/retrieval/library-settings";
import { createLibraryTools, type LibraryToolsConfig } from "./library-tools";

const FIXTURES = join(__dirname, "..", "..", "..", "fixtures", "documents");
const CONTEXT = {} as AgentToolContext;

describe("the Library tools", () => {
	let root: string;
	let workspace: string;
	let library: Library;
	let config: LibraryToolsConfig | undefined;
	let sent: { url: string; body: Record<string, unknown> }[];

	const on = (settings: Partial<LibrarySettings> = {}): LibraryToolsConfig => ({
		settings: { ...DEFAULT_LIBRARY_SETTINGS, enabled: true, ...settings },
	});

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "library-tools-"));
		workspace = join(root, "workspace");
		mkdirSync(workspace);
		sent = [];
		const send = (async (input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? "{}"));
			sent.push({ url: String(input), body });
			return Response.json({
				results: (body.documents as string[]).map((text, index) => ({
					index,
					relevance_score: text.includes("thermostat") ? 0.93 : 0.2,
				})),
			});
		}) as typeof fetch;
		library = new Library({
			directory: join(root, "library"),
			runtimeDirectory: join(root, "no-runtime"),
			fetch: send,
		});
		config = on();
	});
	afterEach(async () => {
		await library.close();
		rmSync(root, { recursive: true, force: true });
	});

	const tools = () =>
		Object.fromEntries(
			createLibraryTools({
				cwd: workspace,
				getConfig: () => config,
				library,
			}).map((tool) => [tool.name, tool]),
		);
	const call = async (name: string, input: unknown) =>
		String(await tools()[name].execute(input, CONTEXT));
	const write = (name: string, text: string) => {
		mkdirSync(join(workspace, name, ".."), { recursive: true });
		writeFileSync(join(workspace, name), text);
	};

	it("offers nothing while the Library is off", () => {
		config = undefined;
		expect(tools()).toEqual({});
		config = on({ enabled: false });
		expect(tools()).toEqual({});
	});

	it("offers the three tools when it is on", () => {
		expect(Object.keys(tools())).toEqual([
			"search_library",
			"add_to_library",
			"list_library",
		]);
	});

	it("stops answering when the Library is turned off mid-session", async () => {
		const search = tools().search_library;
		config = on({ enabled: false });
		expect(String(await search.execute({ query: "x" }, CONTEXT))).toMatch(
			/turned off.*Settings > Library/,
		);
	});

	it("adds a text file and finds a passage of it, with its section", async () => {
		write(
			"manual.md",
			"# Cooling\n\nThe coolant pump is held by four bolts.\n\n# Oil\n\nChange the oil and the filter together.\n",
		);
		const added = await call("add_to_library", { paths: ["manual.md"] });
		expect(added).toContain(
			'Library, collection "default": 1 added, 0 replaced, 0 unchanged; 2 new passages, searchable by keyword now.',
		);
		expect(added).toContain("manual.md: added, 2 passages");

		const found = await call("search_library", { query: "coolant pump bolts" });
		expect(found).toMatch(
			/^Library: 1 passage for "coolant pump bolts" \(by keyword\), best first\./,
		);
		expect(found).toContain('manual.md — Cooling (collection "default")');
		expect(found).toContain("The coolant pump is held by four bolts.");
		expect(found).not.toContain("Change the oil");
	});

	it("reads a DOCX and a PDF through the Document Reader", async () => {
		copyFileSync(join(FIXTURES, "probe.docx"), join(workspace, "probe.docx"));
		copyFileSync(join(FIXTURES, "probe.pdf"), join(workspace, "probe.pdf"));
		const added = await call("add_to_library", {
			paths: ["probe.docx", "probe.pdf"],
			collection: "probes",
		});
		expect(added).toMatch(/collection "probes": 2 added/);
		const listed = await call("list_library", { collection: "probes" });
		expect(listed).toMatch(/Collection "probes": 2 documents\./);
		expect(listed).toMatch(/probe\.docx.*passages/);
		expect(listed).toMatch(/probe\.pdf.*passages/);
		// Nothing was written into the workspace for it.
		expect(await call("list_library", {})).toMatch(/"probes": 2 documents/);
	});

	it("adds what a folder holds, and leaves alone what is not a document", async () => {
		write("books/a.md", "Alpha is the first letter.");
		write("books/deep/b.txt", "Beta is the second letter.");
		write("books/code.ts", "export const gamma = 3;");
		write("books/node_modules/x/readme.md", "Not this.");
		write("books/.hidden/c.md", "Nor this.");
		const added = await call("add_to_library", { paths: ["books"] });
		expect(added).toMatch(/2 added/);
		expect(await call("search_library", { query: "gamma" })).toMatch(
			/nothing found/,
		);
		// Named outright, a source file is taken as the text it is.
		expect(await call("add_to_library", { paths: ["books/code.ts"] })).toMatch(
			/1 added/,
		);
		expect(await call("search_library", { query: "gamma" })).toMatch(
			/1 passage/,
		);
	});

	it("leaves an unchanged file alone and replaces a changed one", async () => {
		write("note.md", "The spare key is under the blue pot.");
		await call("add_to_library", { paths: ["note.md"] });
		expect(await call("add_to_library", { paths: ["note.md"] })).toMatch(
			/0 added, 0 replaced, 1 unchanged/,
		);
		write("note.md", "The spare key is with the neighbour.");
		expect(await call("add_to_library", { paths: ["note.md"] })).toMatch(
			/0 added, 1 replaced/,
		);
		const found = await call("search_library", { query: "spare key" });
		expect(found).toContain("neighbour");
		expect(found).not.toContain("blue pot");
	});

	it("says what could not be added without failing the rest", async () => {
		write("good.md", "A good file.");
		writeFileSync(join(workspace, "blob.bin"), Buffer.from([1, 0, 2, 0, 3]));
		write("empty.md", "   \n");
		const added = await call("add_to_library", {
			paths: ["good.md", "blob.bin", "empty.md", "missing.md"],
		});
		expect(added).toMatch(/1 added, 0 replaced, 0 unchanged, 2 not added/);
		expect(added).toContain(
			"blob.bin: not added, it is not a text file or a format the Document Reader reads",
		);
		expect(added).toContain("empty.md: no text in it.");
		expect(added).toContain("missing.md: no such file or folder.");
	});

	it("names the collections there are when asked for one that is not", async () => {
		write("a.md", "Alpha.");
		await call("add_to_library", { paths: ["a.md"], collection: "Letters" });
		expect(
			await call("search_library", { query: "alpha", collections: ["nope"] }),
		).toBe('No collection named "nope". The Library has: "Letters".');
		// Names are matched whatever their case.
		expect(
			await call("search_library", {
				query: "alpha",
				collections: ["letters"],
			}),
		).toMatch(/1 passage/);
		expect(await call("list_library", { collection: "nope" })).toMatch(
			/No collection named "nope"/,
		);
	});

	it("says the Library is empty", async () => {
		expect(await call("list_library", {})).toBe(
			"The Library is empty. add_to_library puts documents in.",
		);
		expect(await call("search_library", { query: "anything" })).toMatch(
			/nothing found.*list_library/,
		);
	});

	it("reranks with the configured model and shows the relevance", async () => {
		write("cooling.md", "When the engine runs hot, look at the thermostat.");
		write("oil.md", "When the engine is due, change the oil.");
		await call("add_to_library", { paths: ["cooling.md", "oil.md"] });
		config = {
			...on(),
			reranker: { baseUrl: "http://rerank.test", model: "rr" },
		};
		const found = await call("search_library", { query: "engine", limit: 1 });
		expect(found).toMatch(/1 passage for "engine" \(by keyword, reranked\)/);
		expect(found).toMatch(
			/cooling\.md \(collection "default", relevance 0\.93\)/,
		);
		expect(sent[0].url).toBe("http://rerank.test/v1/rerank");
	});

	it("says why nothing was embedded when an embedding model is set and LanceDB is not installed", async () => {
		write("a.md", "Alpha.");
		config = {
			...on(),
			embedding: { baseUrl: "http://embed.test", model: "em" },
		};
		const added = await call("add_to_library", { paths: ["a.md"] });
		expect(added).toContain(
			"Not embedded: LanceDB is not installed yet. Search is by keyword until it is.",
		);
		expect(sent).toEqual([]);
	});
});
