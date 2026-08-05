import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	type CodeIntelLocation,
	type CodeIntelProvider,
	type CodeIntelSymbol,
	createCodeIntelTool,
	parseCodeIntelRequest,
} from "./code-intel-tool"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const CWD = "/repo"

function location(filePath: string, line: number, character = 0): CodeIntelLocation {
	return { filePath, line, character }
}

function symbol(name: string, kind: string, filePath: string, line: number, containerName?: string): CodeIntelSymbol {
	return { name, kind, containerName, location: location(filePath, line) }
}

function stubProvider(overrides: Partial<CodeIntelProvider> = {}): CodeIntelProvider {
	return {
		findSymbolPosition: async () => location("/repo/src/app.ts", 10, 6),
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
	}
}

function run(provider: CodeIntelProvider, input: unknown): Promise<string> {
	return createCodeIntelTool({ cwd: CWD, provider }).execute(input, {} as never) as Promise<string>
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("parseCodeIntelRequest", () => {
	it("rejects an operation it does not have", () => {
		expect(parseCodeIntelRequest({ operation: "rename" })).toContain("`operation` must be one of")
	})

	it("names what is missing rather than failing silently", () => {
		expect(parseCodeIntelRequest({ operation: "definition" })).toContain("needs a `path`")
		expect(parseCodeIntelRequest({ operation: "definition", path: "a.ts" })).toContain("needs a `symbol`")
	})

	it("converts the 1-based position the description asks for", () => {
		// A model copies line numbers out of error messages, which are 1-based.
		expect(parseCodeIntelRequest({ operation: "hover", path: "a.ts", line: 12, character: 5 })).toMatchObject({
			line: 11,
			character: 4,
		})
	})

	it("takes a workspace search from either field, since models put it in both", () => {
		expect(parseCodeIntelRequest({ operation: "workspace_symbols", symbol: "Foo" })).toMatchObject({ symbol: "Foo" })
		expect(parseCodeIntelRequest({ operation: "workspace_symbols", path: "Foo" })).toMatchObject({ symbol: "Foo" })
	})
})

describe("code_intel", () => {
	it("finds a symbol's position from its name, which is all a model has", async () => {
		const findSymbolPosition = vi.fn(async () => location("/repo/src/app.ts", 10, 6))
		const definitions = vi.fn(async () => [location("/repo/src/model.ts", 3, 13)])

		await run(stubProvider({ findSymbolPosition, definitions }), {
			operation: "definition",
			path: "src/app.ts",
			symbol: "Widget",
		})

		expect(findSymbolPosition).toHaveBeenCalledWith("/repo/src/app.ts", "Widget")
		expect(definitions).toHaveBeenCalledWith({ filePath: "/repo/src/app.ts", line: 10, character: 6 })
	})

	it("uses an explicit position instead of searching, when given one", async () => {
		const findSymbolPosition = vi.fn(async () => undefined)
		const definitions = vi.fn(async () => [])

		await run(stubProvider({ findSymbolPosition, definitions }), {
			operation: "definition",
			path: "src/app.ts",
			line: 41,
			character: 9,
		})

		expect(findSymbolPosition).not.toHaveBeenCalled()
		expect(definitions).toHaveBeenCalledWith({ filePath: "/repo/src/app.ts", line: 40, character: 8 })
	})

	it("renders a result as file:line:column with the source line", async () => {
		const output = await run(
			stubProvider({
				definitions: async () => [location("/repo/src/model.ts", 3, 13)],
				readLine: async () => "  export class Widget {",
			}),
			{ operation: "definition", path: "src/app.ts", symbol: "Widget" },
		)

		// Relative, so it is short, and positions are 1-based to match the editor.
		expect(output).toBe("src/model.ts:4:14  export class Widget {")
	})

	it("keeps an absolute path when the result is outside the workspace", async () => {
		const output = await run(
			stubProvider({ definitions: async () => [location("/usr/lib/node_modules/x/index.d.ts", 0, 0)] }),
			{ operation: "definition", path: "src/app.ts", symbol: "Widget" },
		)

		expect(output).toBe("/usr/lib/node_modules/x/index.d.ts:1:1")
	})

	it("distinguishes a symbol it could not find from an answer of none", async () => {
		const notFound = await run(stubProvider({ findSymbolPosition: async () => undefined }), {
			operation: "references",
			path: "src/app.ts",
			symbol: "Nope",
		})
		const noAnswer = await run(stubProvider({ references: async () => [] }), {
			operation: "references",
			path: "src/app.ts",
			symbol: "Widget",
		})

		expect(notFound).toContain("Could not find `Nope`")
		expect(noAnswer).toBe("No references found.")
	})

	it("caps a long answer and says how much it left out", async () => {
		const many = Array.from({ length: 47 }, (_, index) => location("/repo/src/app.ts", index))

		const output = await run(stubProvider({ references: async () => many }), {
			operation: "references",
			path: "src/app.ts",
			symbol: "Widget",
		})

		expect(output).toContain("…and 7 more")
	})

	it("outlines a file without needing a symbol", async () => {
		const output = await run(
			stubProvider({
				documentSymbols: async () => [
					symbol("Widget", "class", "/repo/src/app.ts", 9),
					symbol("render", "method", "/repo/src/app.ts", 14, "Widget"),
				],
			}),
			{ operation: "document_symbols", path: "src/app.ts" },
		)

		expect(output).toBe("class Widget — src/app.ts:10\nmethod Widget.render — src/app.ts:15")
	})

	it("searches the whole workspace when the file is unknown", async () => {
		const workspaceSymbols = vi.fn(async () => [symbol("Widget", "class", "/repo/src/model.ts", 3)])

		const output = await run(stubProvider({ workspaceSymbols }), { operation: "workspace_symbols", symbol: "Widget" })

		expect(workspaceSymbols).toHaveBeenCalledWith("Widget")
		expect(output).toContain("class Widget — src/model.ts:4")
	})

	it("reports the hover text the IDE would show", async () => {
		const output = await run(stubProvider({ hover: async () => "(method) Widget.render(): void" }), {
			operation: "hover",
			path: "src/app.ts",
			symbol: "render",
		})

		expect(output).toBe("(method) Widget.render(): void")
	})

	it("says so when the language server has nothing, rather than returning empty", async () => {
		const output = await run(stubProvider({ hover: async () => "   " }), {
			operation: "hover",
			path: "src/app.ts",
			symbol: "render",
		})

		expect(output).toContain("nothing to say")
	})

	it("answers who calls a function", async () => {
		const output = await run(stubProvider({ callers: async () => [symbol("main", "function", "/repo/src/index.ts", 20)] }), {
			operation: "callers",
			path: "src/app.ts",
			symbol: "render",
		})

		expect(output).toContain("function main — src/index.ts:21")
	})

	it("reports a failing language server instead of throwing at the model", async () => {
		const output = await run(
			stubProvider({
				references: async () => {
					throw new Error("server crashed")
				},
			}),
			{ operation: "references", path: "src/app.ts", symbol: "Widget" },
		)

		expect(output).toContain("server crashed")
	})
})
