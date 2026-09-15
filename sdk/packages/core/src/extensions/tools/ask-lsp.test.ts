import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CodeIntelLocation,
	type CodeIntelProvider,
	type CodeIntelSymbol,
	createAskLspTool,
	parseAskLspRequest,
} from "./ask-lsp";

/**
 * The workspace, and the two ways a path appears in these tests.
 *
 * `at()` builds the absolute paths the provider hands back; `shown()` builds
 * the relative path the tool prints, which carries the platform's separator.
 * A "src/app.ts" literal in an expectation is a claim that the runner is
 * POSIX: on Windows the tool prints `src\\app.ts` and the provider is called
 * with `D:\\repo\\src\\app.ts`, and seven tests fail on the slash alone.
 */
const CWD = resolve("/repo");
const at = (relativePath: string) => join(CWD, relativePath);
const shown = (relativePath: string) => join(relativePath);

function location(
	filePath: string,
	line: number,
	character = 0,
): CodeIntelLocation {
	return { filePath, line, character };
}

function symbol(
	name: string,
	kind: string,
	filePath: string,
	line: number,
	containerName?: string,
): CodeIntelSymbol {
	return { name, kind, containerName, location: location(filePath, line) };
}

function stubProvider(
	overrides: Partial<CodeIntelProvider> = {},
): CodeIntelProvider {
	return {
		findSymbolPosition: async () => location(at("src/app.ts"), 10, 6),
		definitions: async () => [],
		typeDefinitions: async () => [],
		implementations: async () => [],
		references: async () => [],
		hover: async () => undefined,
		documentSymbols: async () => [],
		workspaceSymbols: async () => [],
		callers: async () => [],
		readLine: async () => undefined,
		...overrides,
	};
}

function run(provider: CodeIntelProvider, input: unknown): Promise<string> {
	return createAskLspTool({ cwd: CWD, provider }).execute(
		input,
		{} as never,
	) as Promise<string>;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("parseAskLspRequest", () => {
	it("rejects an operation it does not have", () => {
		expect(parseAskLspRequest({ operation: "rename" })).toContain(
			"`operation` must be one of",
		);
	});

	it("names what is missing rather than failing silently", () => {
		expect(parseAskLspRequest({ operation: "definition" })).toContain(
			"needs a `path`",
		);
		expect(
			parseAskLspRequest({ operation: "definition", path: "a.ts" }),
		).toContain("needs a `symbol`");
	});

	it("converts the 1-based position the description asks for", () => {
		// A model copies line numbers out of error messages, which are 1-based.
		expect(
			parseAskLspRequest({
				operation: "hover",
				path: "a.ts",
				line: 12,
				character: 5,
			}),
		).toMatchObject({
			line: 11,
			character: 4,
		});
	});

	it("takes a workspace search from either field, since models put it in both", () => {
		expect(
			parseAskLspRequest({ operation: "workspace_symbols", symbol: "Foo" }),
		).toMatchObject({ symbol: "Foo" });
		expect(
			parseAskLspRequest({ operation: "workspace_symbols", path: "Foo" }),
		).toMatchObject({ symbol: "Foo" });
		// `search_codebase` sits beside this tool and takes `queries`, and a
		// model searching for a name here sent `query` -- which was silently
		// ignored, so it was told a `symbol` was missing while its own value
		// sat unread in the call.
		expect(
			parseAskLspRequest({ operation: "workspace_symbols", query: "Foo" }),
		).toMatchObject({ symbol: "Foo" });
		// An explicit `symbol` still wins over the alias.
		expect(
			parseAskLspRequest({
				operation: "workspace_symbols",
				symbol: "Foo",
				query: "Bar",
			}),
		).toMatchObject({ symbol: "Foo" });
	});
});

describe("ask_lsp", () => {
	it("finds a symbol's position from its name, which is all a model has", async () => {
		const findSymbolPosition = vi.fn(async () =>
			location(at("src/app.ts"), 10, 6),
		);
		const definitions = vi.fn(async () => [
			location(at("src/model.ts"), 3, 13),
		]);

		await run(stubProvider({ findSymbolPosition, definitions }), {
			operation: "definition",
			path: "src/app.ts",
			symbol: "Widget",
		});

		expect(findSymbolPosition).toHaveBeenCalledWith(at("src/app.ts"), "Widget");
		expect(definitions).toHaveBeenCalledWith({
			filePath: at("src/app.ts"),
			line: 10,
			character: 6,
		});
	});

	it("uses an explicit position instead of searching, when given one", async () => {
		const findSymbolPosition = vi.fn(async () => undefined);
		const definitions = vi.fn(async () => []);

		await run(stubProvider({ findSymbolPosition, definitions }), {
			operation: "definition",
			path: "src/app.ts",
			line: 41,
			character: 9,
		});

		expect(findSymbolPosition).not.toHaveBeenCalled();
		expect(definitions).toHaveBeenCalledWith({
			filePath: at("src/app.ts"),
			line: 40,
			character: 8,
		});
	});

	it("renders a result as file:line:column with the source line", async () => {
		const output = await run(
			stubProvider({
				definitions: async () => [location(at("src/model.ts"), 3, 13)],
				readLine: async () => "  export class Widget {",
			}),
			{ operation: "definition", path: "src/app.ts", symbol: "Widget" },
		);

		// Relative, so it is short, and positions are 1-based to match the editor.
		expect(output).toBe(`${shown("src/model.ts")}:4:14  export class Widget {`);
	});

	it("keeps an absolute path when the result is outside the workspace", async () => {
		const output = await run(
			stubProvider({
				definitions: async () => [
					location("/usr/lib/node_modules/x/index.d.ts", 0, 0),
				],
			}),
			{ operation: "definition", path: "src/app.ts", symbol: "Widget" },
		);

		expect(output).toBe("/usr/lib/node_modules/x/index.d.ts:1:1");
	});

	it("distinguishes a symbol it could not find from an answer of none", async () => {
		const notFound = await run(
			stubProvider({ findSymbolPosition: async () => undefined }),
			{
				operation: "references",
				path: "src/app.ts",
				symbol: "Nope",
			},
		);
		const noAnswer = await run(stubProvider({ references: async () => [] }), {
			operation: "references",
			path: "src/app.ts",
			symbol: "Widget",
		});

		expect(notFound).toContain("Could not find `Nope`");
		expect(noAnswer).toBe("No references found.");
	});

	it("caps a long answer and says how much it left out", async () => {
		const many = Array.from({ length: 47 }, (_, index) =>
			location(at("src/app.ts"), index),
		);

		const output = await run(stubProvider({ references: async () => many }), {
			operation: "references",
			path: "src/app.ts",
			symbol: "Widget",
		});

		expect(output).toContain("…and 7 more");
	});

	it("outlines a file without needing a symbol", async () => {
		const output = await run(
			stubProvider({
				documentSymbols: async () => [
					symbol("Widget", "class", at("src/app.ts"), 9),
					symbol("render", "method", at("src/app.ts"), 14, "Widget"),
				],
			}),
			{ operation: "document_symbols", path: "src/app.ts" },
		);

		expect(output).toBe(
			`class Widget — ${shown("src/app.ts")}:10\nmethod Widget.render — ${shown("src/app.ts")}:15`,
		);
	});

	it("searches the whole workspace when the file is unknown", async () => {
		const workspaceSymbols = vi.fn(async () => [
			symbol("Widget", "class", at("src/model.ts"), 3),
		]);

		const output = await run(stubProvider({ workspaceSymbols }), {
			operation: "workspace_symbols",
			symbol: "Widget",
		});

		expect(workspaceSymbols).toHaveBeenCalledWith("Widget");
		expect(output).toContain(`class Widget — ${shown("src/model.ts")}:4`);
	});

	it("reports the hover text the IDE would show", async () => {
		const output = await run(
			stubProvider({ hover: async () => "(method) Widget.render(): void" }),
			{
				operation: "hover",
				path: "src/app.ts",
				symbol: "render",
			},
		);

		expect(output).toBe("(method) Widget.render(): void");
	});

	it("says so when the language server has nothing, rather than returning empty", async () => {
		const output = await run(stubProvider({ hover: async () => "   " }), {
			operation: "hover",
			path: "src/app.ts",
			symbol: "render",
		});

		expect(output).toContain("nothing to say");
	});

	it("answers who calls a function", async () => {
		const output = await run(
			stubProvider({
				callers: async () => [
					symbol("main", "function", at("src/index.ts"), 20),
				],
			}),
			{
				operation: "callers",
				path: "src/app.ts",
				symbol: "render",
			},
		);

		expect(output).toContain(`function main — ${shown("src/index.ts")}:21`);
	});

	it("reports a failing language server instead of throwing at the model", async () => {
		const output = await run(
			stubProvider({
				references: async () => {
					throw new Error("server crashed");
				},
			}),
			{ operation: "references", path: "src/app.ts", symbol: "Widget" },
		);

		expect(output).toContain("server crashed");
	});
});

describe("what an empty answer is allowed to claim", () => {
	it("does not let an empty workspace_symbols stand as proof", async () => {
		// The index covers the languages a server is installed for. A class
		// inside an `.html` file is in none of them, and reporting that as
		// "no symbol" sent the model looking for an indexing bug in us.
		const output = await run(stubProvider(), {
			operation: "workspace_symbols",
			symbol: "SoundManager",
		});

		expect(output).toContain("not proof the symbol does not exist");
		expect(output).toContain("`document_symbols`");
		expect(output).toContain("`search_codebase`");
	});

	it("keeps the empty answer definite once the symbol resolved", async () => {
		const output = await run(stubProvider(), {
			operation: "references",
			path: "src/app.ts",
			symbol: "run",
		});

		expect(output).toBe("No references found.");
	});
});

describe("a file that does not parse", () => {
	// `.js`, because the check is a real parse and the parser is the JS one:
	// it covers exactly the extensions `check_file` parses, and is silent
	// where it cannot tell rather than guessing.
	const broken = "function gen() { if (x) { return 1; } } }";

	it("says so in front of the answer, not instead of it", async () => {
		const provider = stubProvider({
			readFile: async () => broken,
			definitions: async () => [location(at("src/app.js"), 4, 2)],
			readLine: async () => "const run = () => {}",
		});

		const output = await run(provider, {
			operation: "definition",
			path: "src/app.js",
			symbol: "run",
		});

		expect(output).toContain("does not parse");
		expect(output).toContain("check_file");
		// The answer still arrives; the warning qualifies it.
		expect(output).toContain(`${shown("src/app.js")}:5:3`);
	});

	it("qualifies document_symbols too", async () => {
		const provider = stubProvider({
			readFile: async () => broken,
			documentSymbols: async () => [
				symbol("gen", "function", at("src/app.js"), 0),
			],
		});

		const output = await run(provider, {
			operation: "document_symbols",
			path: "src/app.js",
		});

		expect(output).toContain("does not parse");
		expect(output).toContain("function gen");
	});

	it("is silent about a language it cannot parse", async () => {
		// TypeScript does not go through `new Function`, so a `.ts` file is
		// never reported as broken here -- a miss, and the safe direction.
		const provider = stubProvider({
			readFile: async () => broken,
			references: async () => [],
		});

		const output = await run(provider, {
			operation: "references",
			path: "src/app.ts",
			symbol: "run",
		});

		expect(output).toBe("No references found.");
	});

	it("says nothing when the file parses", async () => {
		const provider = stubProvider({
			readFile: async () => "const run = () => {};",
			references: async () => [],
		});

		const output = await run(provider, {
			operation: "references",
			path: "src/app.js",
			symbol: "run",
		});

		expect(output).toBe("No references found.");
	});

	it("loses the warning, not the answer, when the host cannot read files", async () => {
		// `readFile` is optional on the provider: a host without it still
		// answers, it just cannot qualify what it answered.
		const output = await run(stubProvider({ references: async () => [] }), {
			operation: "references",
			path: "src/app.ts",
			symbol: "run",
		});

		expect(output).toBe("No references found.");
	});
});
