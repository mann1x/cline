import { beforeEach, describe, expect, it, vi } from "vitest"
import type { FileDiagnostics } from "@/shared/proto/index.cline"
import { DiagnosticSeverity } from "@/shared/proto/index.cline"
import { buildLintCommand, createCheckFileTool, LINT_COMMAND_FILE_PLACEHOLDER, readRequestedPaths } from "./check-file-tool"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock("@/hosts/host-provider", () => ({
	HostProvider: { workspace: { getDiagnostics: async () => ({ fileDiagnostics: [] }) } },
}))

// Only `getCwd` is faked: importing the real module also installs
// `String.prototype.toPosix`, which the diagnostics formatter relies on.
vi.mock("@/utils/path", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/utils/path")>()),
	getCwd: async () => "/repo",
}))

const CWD = "/repo"

function diagnostic(message: string, severity = DiagnosticSeverity.DIAGNOSTIC_ERROR) {
	return {
		message,
		severity,
		range: { start: { line: 3, character: 4 }, end: { line: 3, character: 9 } },
		source: "ts",
	}
}

function fileDiagnostics(filePath: string, ...diagnostics: ReturnType<typeof diagnostic>[]): FileDiagnostics {
	return { filePath, diagnostics } as unknown as FileDiagnostics
}

/** No real timer: the settle loop would otherwise cost its whole budget. */
const noDelay = async () => {}

function run(tool: ReturnType<typeof createCheckFileTool>, input: unknown): Promise<string> {
	return tool.execute(input, {} as never) as Promise<string>
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("readRequestedPaths", () => {
	it("accepts the documented array", () => {
		expect(readRequestedPaths({ paths: ["a.ts", "b.ts"] })).toEqual(["a.ts", "b.ts"])
	})

	it("accepts a bare string, which models send anyway", () => {
		expect(readRequestedPaths({ paths: "a.ts" })).toEqual(["a.ts"])
	})

	it("drops blanks and non-strings rather than failing the call", () => {
		expect(readRequestedPaths({ paths: ["a.ts", "  ", 7, null, " b.ts "] as never })).toEqual(["a.ts", "b.ts"])
	})

	it("is empty for nothing at all", () => {
		expect(readRequestedPaths(undefined)).toEqual([])
		expect(readRequestedPaths({})).toEqual([])
	})
})

describe("buildLintCommand", () => {
	it("substitutes every placeholder", () => {
		expect(
			buildLintCommand(
				`ruff check ${LINT_COMMAND_FILE_PLACEHOLDER} --stdin ${LINT_COMMAND_FILE_PLACEHOLDER}`,
				"/repo/a.py",
			),
		).toBe("ruff check /repo/a.py --stdin /repo/a.py")
	})

	it("appends the path when the template names no placeholder", () => {
		// "eslint" is what a user will actually type.
		expect(buildLintCommand("eslint", "/repo/a.ts")).toBe("eslint /repo/a.ts")
	})

	it("quotes a path with a space in it", () => {
		expect(buildLintCommand("eslint", "/repo/my file.ts")).toBe('eslint "/repo/my file.ts"')
	})
})

describe("check_file", () => {
	it("reports what the editor already knows", async () => {
		const tool = createCheckFileTool({
			cwd: CWD,
			delay: noDelay,
			readDiagnostics: async () => [fileDiagnostics("/repo/src/app.ts", diagnostic("Unexpected token"))],
		})

		const output = await run(tool, { paths: ["src/app.ts"] })

		expect(output).toContain("Unexpected token")
	})

	it("resolves a relative path against the working directory", async () => {
		const read = vi.fn(async () => [fileDiagnostics("/repo/src/app.ts", diagnostic("boom"))])
		const tool = createCheckFileTool({ cwd: CWD, delay: noDelay, readDiagnostics: read })

		expect(await run(tool, { paths: ["src/app.ts"] })).toContain("boom")
	})

	it("says a file is clean rather than saying nothing", async () => {
		// Silence would read as a failed call, and the model would shell out.
		const tool = createCheckFileTool({ cwd: CWD, delay: noDelay, readDiagnostics: async () => [] })

		const output = await run(tool, { paths: ["src/app.ts"] })
		expect(output).toContain("src/app.ts: no problems reported by the editor.")
		// And says what a clean result does not prove: a language the IDE has no
		// server for reports nothing whether or not the file is broken.
		expect(output).toContain("not the same as clean")
	})

	it("drops hint-level noise the way the post-edit report does", async () => {
		// Same filter, from the same module: two answers to "what is wrong with
		// this file" would be worse than either.
		const tool = createCheckFileTool({
			cwd: CWD,
			delay: noDelay,
			readDiagnostics: async () => [
				fileDiagnostics(
					"/repo/src/app.ts",
					diagnostic("convert to template literal", DiagnosticSeverity.DIAGNOSTIC_HINT),
				),
			],
		})

		expect(await run(tool, { paths: ["src/app.ts"] })).toContain("no problems")
	})

	it("loads the document first, so an unopened file is checked and not assumed clean", async () => {
		const loadDocument = vi.fn(async () => {})
		const tool = createCheckFileTool({ cwd: CWD, delay: noDelay, readDiagnostics: async () => [], loadDocument })

		await run(tool, { paths: ["src/app.ts", "src/other.ts"] })

		expect(loadDocument).toHaveBeenCalledWith("/repo/src/app.ts")
		expect(loadDocument).toHaveBeenCalledWith("/repo/src/other.ts")
	})

	it("still reports when a document cannot be loaded", async () => {
		const tool = createCheckFileTool({
			cwd: CWD,
			delay: noDelay,
			readDiagnostics: async () => [fileDiagnostics("/repo/src/app.ts", diagnostic("boom"))],
			loadDocument: async () => {
				throw new Error("no such file")
			},
		})

		expect(await run(tool, { paths: ["src/app.ts"] })).toContain("boom")
	})

	it("checks every file in one call", async () => {
		const tool = createCheckFileTool({
			cwd: CWD,
			delay: noDelay,
			readDiagnostics: async () => [
				fileDiagnostics("/repo/a.ts", diagnostic("first")),
				fileDiagnostics("/repo/b.ts", diagnostic("second")),
			],
		})

		const output = await run(tool, { paths: ["a.ts", "b.ts"] })

		expect(output).toContain("first")
		expect(output).toContain("second")
	})

	it("caps the files it will check and says how many it skipped", async () => {
		const tool = createCheckFileTool({ cwd: CWD, delay: noDelay, readDiagnostics: async () => [] })

		const output = await run(tool, { paths: Array.from({ length: 23 }, (_, index) => `f${index}.ts`) })

		expect(output).toContain("(3 more file(s) were not checked")
	})

	it("asks for paths instead of failing when given none", async () => {
		const tool = createCheckFileTool({ cwd: CWD, delay: noDelay, readDiagnostics: async () => [] })

		expect(await run(tool, {})).toContain("No files were named")
	})

	it("reports a broken diagnostics read rather than claiming the file is clean", async () => {
		const tool = createCheckFileTool({
			cwd: CWD,
			delay: noDelay,
			readDiagnostics: async () => {
				throw new Error("host is gone")
			},
		})

		expect(await run(tool, { paths: ["a.ts"] })).toContain("host is gone")
	})

	describe("the configured fallback", () => {
		it("runs only when the editor had nothing to say", async () => {
			const runLintCommand = vi.fn(async () => ({ exitCode: 0, output: "" }))
			const tool = createCheckFileTool({
				cwd: CWD,
				delay: noDelay,
				readDiagnostics: async () => [fileDiagnostics("/repo/a.ts", diagnostic("boom"))],
				resolveLintCommand: () => `ruff check ${LINT_COMMAND_FILE_PLACEHOLDER}`,
				runLintCommand,
			})

			await run(tool, { paths: ["a.ts"] })

			// The editor answered, so there is nothing to fall back to.
			expect(runLintCommand).not.toHaveBeenCalled()
		})

		it("reports what the command found", async () => {
			const tool = createCheckFileTool({
				cwd: CWD,
				delay: noDelay,
				readDiagnostics: async () => [],
				resolveLintCommand: () => `ruff check ${LINT_COMMAND_FILE_PLACEHOLDER}`,
				runLintCommand: async () => ({ exitCode: 1, output: "a.py:3:1: F401 unused import" }),
			})

			const output = await run(tool, { paths: ["a.py"] })

			expect(output).toContain("F401 unused import")
			expect(output).toContain("ruff check /repo/a.py")
		})

		it("says both sources agree when the command passes", async () => {
			const tool = createCheckFileTool({
				cwd: CWD,
				delay: noDelay,
				readDiagnostics: async () => [],
				resolveLintCommand: () => `ruff check ${LINT_COMMAND_FILE_PLACEHOLDER}`,
				runLintCommand: async () => ({ exitCode: 0, output: "" }),
			})

			expect(await run(tool, { paths: ["a.py"] })).toContain("no problems")
		})

		it("reports a command that could not run, without pretending the file is clean", async () => {
			const tool = createCheckFileTool({
				cwd: CWD,
				delay: noDelay,
				readDiagnostics: async () => [],
				resolveLintCommand: () => "ruff",
				runLintCommand: async () => {
					throw new Error("command not found")
				},
			})

			expect(await run(tool, { paths: ["a.py"] })).toContain("command not found")
		})

		it("is skipped entirely when nothing is configured", async () => {
			const runLintCommand = vi.fn(async () => ({ exitCode: 0, output: "" }))
			const tool = createCheckFileTool({
				cwd: CWD,
				delay: noDelay,
				readDiagnostics: async () => [],
				resolveLintCommand: () => undefined,
				runLintCommand,
			})

			await run(tool, { paths: ["a.py"] })

			expect(runLintCommand).not.toHaveBeenCalled()
		})
	})
})
