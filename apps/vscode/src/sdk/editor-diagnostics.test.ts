import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { DiagnosticSeverity, type FileDiagnostics } from "@/shared/proto/index.cline"
import {
	appendToOutput,
	createEditorDiagnosticsHooks,
	formatIntroducedDiagnostics,
	isLintableFile,
	readTargetPaths,
	samePath,
} from "./editor-diagnostics"

vi.mock("@/hosts/host-provider", () => ({
	HostProvider: { workspace: { getDiagnostics: async () => ({ fileDiagnostics: [] }) } },
}))

vi.mock("@/shared/services/Logger", () => ({
	Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

// Only `getCwd` is faked: importing the real module also installs
// `String.prototype.toPosix`, which the diagnostics formatter relies on.
vi.mock("@/utils/path", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/utils/path")>()),
	getCwd: async () => "/repo",
}))

function diagnostic(overrides: Partial<FileDiagnostics["diagnostics"][number]> = {}) {
	return {
		message: "Unexpected token",
		range: { start: { line: 41, character: 3 }, end: { line: 41, character: 9 } },
		severity: DiagnosticSeverity.DIAGNOSTIC_ERROR,
		source: "ts",
		...overrides,
	}
}

describe("readTargetPaths", () => {
	it("reads the editor tool's path", () => {
		expect(readTargetPaths("editor", { path: "src/app.ts" })).toEqual(["src/app.ts"])
		expect(readTargetPaths("editor", { path: "   " })).toEqual([])
		expect(readTargetPaths("editor", {})).toEqual([])
	})

	it("reads every file named in an apply_patch body", () => {
		const patch = [
			"*** Begin Patch",
			"*** Update File: src/app.ts",
			"@@",
			"-old",
			"+new",
			"*** Add File: docs/state.md",
			"+# State",
			"*** End Patch",
		].join("\n")
		expect(readTargetPaths("apply_patch", { input: patch })).toEqual(["src/app.ts", "docs/state.md"])
		// The tool accepts a bare string as well as the object form.
		expect(readTargetPaths("apply_patch", patch)).toEqual(["src/app.ts", "docs/state.md"])
	})

	it("ignores tools that do not write files", () => {
		expect(readTargetPaths("read_files", { path: "src/app.ts" })).toEqual([])
	})
})

describe("isLintableFile", () => {
	it("accepts source and prose, including files with no extension", () => {
		// The markdown case is the point: a state summary with broken formatting
		// is a real diagnostic the model never saw.
		expect(isLintableFile("docs/state.md")).toBe(true)
		expect(isLintableFile("src/app.ts")).toBe(true)
		expect(isLintableFile("Dockerfile")).toBe(true)
	})

	it("rejects files whose bytes are not text", () => {
		// Nothing an editor says about an mp3 is a thing the model can fix.
		expect(isLintableFile("assets/level-start.mp3")).toBe(false)
		expect(isLintableFile("assets/Sprite.PNG")).toBe(false)
	})
})

describe("formatIntroducedDiagnostics", () => {
	it("reports only what the edit introduced", async () => {
		const before: FileDiagnostics[] = [
			{ filePath: "/repo/src/app.ts", diagnostics: [diagnostic({ message: "pre-existing" })] },
		]
		const after: FileDiagnostics[] = [
			{
				filePath: "/repo/src/app.ts",
				diagnostics: [diagnostic({ message: "pre-existing" }), diagnostic({ message: "Unterminated string literal" })],
			},
		]

		const block = await formatIntroducedDiagnostics(before, after)
		expect(block).toContain("Unterminated string literal")
		expect(block).not.toContain("pre-existing")
		expect(block).toContain("src/app.ts")
		expect(block).toContain("Line 42")
	})

	it("says nothing about a clean edit", async () => {
		const same: FileDiagnostics[] = [{ filePath: "/repo/src/app.ts", diagnostics: [diagnostic()] }]
		expect(await formatIntroducedDiagnostics(same, same)).toBe("")
	})

	it("drops hints and information", async () => {
		const after: FileDiagnostics[] = [
			{
				filePath: "/repo/src/app.ts",
				diagnostics: [
					diagnostic({ message: "Convert to template literal", severity: DiagnosticSeverity.DIAGNOSTIC_HINT }),
					diagnostic({ message: "Import can be type-only", severity: DiagnosticSeverity.DIAGNOSTIC_INFORMATION }),
				],
			},
		]
		expect(await formatIntroducedDiagnostics([], after)).toBe("")
	})

	it("truncates a flood and says how much it kept back", async () => {
		const after: FileDiagnostics[] = [
			{
				filePath: "/repo/src/app.ts",
				diagnostics: Array.from({ length: 25 }, (_, index) =>
					diagnostic({
						message: `problem ${index}`,
						range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
					}),
				),
			},
		]
		const block = await formatIntroducedDiagnostics([], after)
		expect(block).toContain("problem 19")
		expect(block).not.toContain("problem 20")
		expect(block).toContain("...and 5 more")
	})
})

describe("appendToOutput", () => {
	it("appends to the field the model reads on a tool operation result", () => {
		const output = appendToOutput({ query: "edit:src/app.ts", result: "edited", success: true }, "BLOCK")
		expect(output).toMatchObject({ query: "edit:src/app.ts", success: true, result: "edited\n\nBLOCK" })
	})

	it("appends to a plain string result", () => {
		expect(appendToOutput("done", "BLOCK")).toBe("done\n\nBLOCK")
		expect(appendToOutput("", "BLOCK")).toBe("BLOCK")
	})

	it("leaves an output it cannot append to alone", () => {
		expect(appendToOutput(42, "BLOCK")).toBe(42)
	})
})

describe("createEditorDiagnosticsHooks", () => {
	const noDelay = async () => {}

	function hooks(readDiagnostics: () => Promise<FileDiagnostics[]>) {
		return createEditorDiagnosticsHooks({ cwd: "/repo", readDiagnostics, delay: noDelay })
	}

	function toolContext(overrides: Record<string, unknown> = {}) {
		return {
			snapshot: {} as never,
			tool: { name: "editor" } as never,
			toolCall: { type: "tool-call", toolCallId: "call-1", toolName: "editor", input: {} },
			input: { path: "src/app.ts" },
			result: { output: { query: "edit:src/app.ts", result: "edited", success: true } },
			startedAt: new Date(),
			endedAt: new Date(),
			durationMs: 5,
			...overrides,
		} as never
	}

	it("appends the diagnostics an edit introduced", async () => {
		const states: FileDiagnostics[][] = [
			[],
			[{ filePath: "/repo/src/app.ts", diagnostics: [diagnostic({ message: "Unterminated string literal" })] }],
		]
		let call = 0
		const bag = hooks(async () => states[Math.min(call++, states.length - 1)])

		await bag.beforeTool?.(toolContext())
		const after = await bag.afterTool?.(toolContext())

		expect(String((after as { result: { output: { result: string } } }).result.output.result)).toContain(
			"Unterminated string literal",
		)
	})

	it("says nothing when the edit introduced nothing", async () => {
		const bag = hooks(async () => [])
		await bag.beforeTool?.(toolContext())
		expect(await bag.afterTool?.(toolContext())).toBeUndefined()
	})

	it("says nothing about an edit that failed", async () => {
		// The file is as it was, so every diagnostic on it predates the call.
		const bag = hooks(async () => [{ filePath: "/repo/src/app.ts", diagnostics: [diagnostic()] }])
		await bag.beforeTool?.(toolContext())
		expect(await bag.afterTool?.(toolContext({ result: { output: "", isError: true } }))).toBeUndefined()
	})

	it("does not poll the editor for tools that write no files", async () => {
		const read = vi.fn(async () => [])
		const bag = hooks(read)
		const context = toolContext({
			toolCall: { type: "tool-call", toolCallId: "call-2", toolName: "read_files", input: {} },
			input: { file_paths: ["src/app.ts"] },
		})

		await bag.beforeTool?.(context)
		await bag.afterTool?.(context)
		expect(read).not.toHaveBeenCalled()
	})

	it("does not poll the editor for a file it cannot lint", async () => {
		const read = vi.fn(async () => [])
		const bag = hooks(read)
		const context = toolContext({ input: { path: "assets/level-start.mp3" } })

		await bag.beforeTool?.(context)
		await bag.afterTool?.(context)
		expect(read).not.toHaveBeenCalled()
	})

	it("marks a regressing edit so the loop tracker can see it", async () => {
		// Measured: eight consecutive `editor` calls all returned success: true
		// while the file's diagnostics went 2 -> 20. Read as eight productive
		// calls, the barren-repeat counter reset on every one and the loop stop
		// could never fire.
		const states: FileDiagnostics[][] = [
			[],
			[{ filePath: "/repo/src/app.ts", diagnostics: [diagnostic({ message: "Unterminated string literal" })] }],
		]
		let call = 0
		const bag = hooks(async () => states[Math.min(call++, states.length - 1)])

		await bag.beforeTool?.(toolContext())
		const after = await bag.afterTool?.(toolContext())

		expect((after as { result: { output: { regressed?: boolean } } }).result.output.regressed).toBe(true)
	})

	it("leaves a clean edit unmarked", async () => {
		const bag = hooks(async () => [])
		await bag.beforeTool?.(toolContext())
		expect(await bag.afterTool?.(toolContext())).toBeUndefined()
	})

	it("attaches the delimiter verdict for the file it just broke", async () => {
		// `check_file` already computes exactly the sentence a stuck model needs,
		// and in the measured session it was never called: across 111,790
		// characters of reasoning the model named two of its twenty-five tools.
		// So the verdict rides along with the edit that caused the trouble
		// instead of waiting to be asked for.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-diag-"))
		try {
			const filePath = path.join(dir, "app.ts")
			await fs.writeFile(filePath, "const f = () => {\n\tgo();\n}}\n", "utf8")
			const states: FileDiagnostics[][] = [
				[],
				[{ filePath, diagnostics: [diagnostic({ message: "Declaration or statement expected." })] }],
			]
			let call = 0
			const bag = createEditorDiagnosticsHooks({
				cwd: dir,
				readDiagnostics: async () => states[Math.min(call++, states.length - 1)],
				delay: noDelay,
			})
			const context = toolContext({ input: { path: "app.ts" } })

			await bag.beforeTool?.(context)
			const after = await bag.afterTool?.(context)

			const text = String((after as { result: { output: { result: string } } }).result.output.result)
			expect(text).toContain("Declaration or statement expected.")
			expect(text).toContain("more `}` than `{`")
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("keeps a failure to read diagnostics away from the tool result", async () => {
		const bag = hooks(async () => {
			throw new Error("host bridge unavailable")
		})
		await bag.beforeTool?.(toolContext())
		expect(await bag.afterTool?.(toolContext())).toBeUndefined()
	})
})

describe("samePath", () => {
	function onPlatform<T>(platform: string, body: () => T): T {
		const original = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor
		Object.defineProperty(process, "platform", { value: platform, configurable: true })
		try {
			return body()
		} finally {
			Object.defineProperty(process, "platform", original)
		}
	}

	it("ignores case on Windows, where the filesystem does", () => {
		// The editor reports the path as the workspace has it; the model types
		// its own. Measured: workspace `c:\\Users\\manni\\...` against the model's
		// `C:\\Users\\manni\\...`. One capital letter, and the lookup missed — which
		// this tool reports as a clean file.
		onPlatform("win32", () => {
			expect(samePath("/Repo/Src/App.ts", "/repo/src/app.ts")).toBe(true)
		})
	})

	it("keeps case elsewhere, where two such files can both exist", () => {
		onPlatform("linux", () => {
			expect(samePath("/repo/App.ts", "/repo/app.ts")).toBe(false)
		})
	})

	it("still normalizes the path itself", () => {
		expect(samePath("/repo/src/../src/app.ts", "/repo/src/app.ts")).toBe(true)
	})
})
