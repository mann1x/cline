import { type AgentToolContext, createEditorExecutor, createReadReceipts, type EditFileInput } from "@cline/core"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { computeNewEditorContent } from "./sdk-diff-edit-coordinator"

/**
 * The diff preview recomputes the proposed content itself instead of asking the
 * executor, because it has to show the change *before* the write. That makes
 * `computeNewEditorContent` a second implementation of the executor's semantics,
 * and a second implementation drifts.
 *
 * It did. The preview knew `insert_line`, create and `old_text` while the executor
 * had grown line ranges, column ranges and column inserts, so in a measured
 * 58-minute session 29 of 30 `editor` calls threw inside the preview and every
 * edit landed with no diff shown. Nothing failed loudly — the preview is
 * best-effort by design, so the drift was invisible from the outside.
 *
 * These tests run both implementations over the same file and the same input and
 * compare the bytes. Anything the executor learns that the preview does not fails
 * here rather than silently costing the preview.
 */
describe("editor preview mirrors the SDK executor", () => {
	let dir: string
	let filePath: string

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "editor-mirror-"))
		filePath = path.join(dir, "subject.txt")
	})

	afterEach(async () => {
		await fs.rm(dir, { recursive: true, force: true })
	})

	/**
	 * Applies `input` for real and returns what the executor wrote, alongside what
	 * the preview predicted from the same starting content.
	 */
	async function bothWays(
		original: string,
		input: Omit<EditFileInput, "path">,
	): Promise<{ executor: string; preview: string }> {
		await fs.writeFile(filePath, original, "utf-8")
		const receipts = createReadReceipts()
		// Satisfy the read-before-edit guard: the preview has no such guard, so a
		// refusal here would be about the receipt, not about the edit's semantics.
		// The span has to cover the lines the input names, including an end_line
		// past EOF — the guard checks the requested range, not the clamped one.
		const lineCount = original.split(/\r\n|\n/).length
		const named = [input.start_line, input.end_line, input.insert_line, lineCount].filter(
			(n): n is number => typeof n === "number",
		)
		receipts.noteRead(filePath, 1, Math.max(...named))
		const executor = createEditorExecutor({ receipts })
		const context: AgentToolContext = { agentId: "agent", iteration: 1, toolCallId: "call" }
		const full = { ...input, path: filePath } as EditFileInput

		const preview = computeNewEditorContent(original, full, filePath, "modify")
		await executor(full, dir, context)
		return { executor: await fs.readFile(filePath, "utf-8"), preview }
	}

	const LINES = ["alpha", "beta", "gamma", "delta", "epsilon"].join("\n")

	it("agrees on a single-line range replacement", async () => {
		const { executor, preview } = await bothWays(LINES, { start_line: 2, new_text: "BETA" })
		expect(preview).toBe(executor)
		expect(executor).toContain("BETA")
	})

	it("agrees on a multi-line range replacement", async () => {
		const { executor, preview } = await bothWays(LINES, {
			start_line: 2,
			end_line: 4,
			new_text: "two\nthree\nfour",
		})
		expect(preview).toBe(executor)
	})

	it("agrees when end_line runs past EOF, which means to the end of the file", async () => {
		const { executor, preview } = await bothWays(LINES, { start_line: 3, end_line: 9999, new_text: "tail" })
		expect(preview).toBe(executor)
		expect(executor).toBe(["alpha", "beta", "tail"].join("\n"))
	})

	it("agrees that an empty new_text deletes the range", async () => {
		const { executor, preview } = await bothWays(LINES, { start_line: 2, end_line: 3, new_text: "" })
		expect(preview).toBe(executor)
		expect(executor).toBe(["alpha", "delta", "epsilon"].join("\n"))
	})

	it("ignores old_text when start_line is present, as the executor does", async () => {
		// A range edit carrying an old_text that matches nothing must still apply:
		// the executor never looks at old_text once start_line is set. Before the
		// fix this fell through to the match path and threw "text not found".
		const { executor, preview } = await bothWays(LINES, {
			start_line: 2,
			new_text: "BETA",
			old_text: "  2 | beta",
		})
		expect(preview).toBe(executor)
	})

	it("agrees on a column range on one line", async () => {
		const { executor, preview } = await bothWays(LINES, {
			start_line: 3,
			start_column: 1,
			end_column: 5,
			new_text: "GAMMA",
		})
		expect(preview).toBe(executor)
	})

	it("agrees on a column insert, the one-missing-bracket case", async () => {
		const { executor, preview } = await bothWays(LINES, {
			insert_line: 2,
			insert_column: 5,
			new_text: ")",
		})
		expect(preview).toBe(executor)
		expect(executor).toContain("beta)")
	})

	it("agrees on a line insert", async () => {
		const { executor, preview } = await bothWays(LINES, { insert_line: 3, new_text: "inserted" })
		expect(preview).toBe(executor)
	})

	it("agrees on an old_text replacement", async () => {
		const { executor, preview } = await bothWays(LINES, { old_text: "gamma", new_text: "GAMMA" })
		expect(preview).toBe(executor)
	})

	it("agrees on replace_all", async () => {
		const { executor, preview } = await bothWays("x\nx\nx", { old_text: "x", new_text: "y", replace_all: true })
		expect(preview).toBe(executor)
		expect(executor).toBe("y\ny\ny")
	})

	it("agrees on a chosen occurrence", async () => {
		const { executor, preview } = await bothWays("x\nx\nx", { old_text: "x", new_text: "y", occurrence: 2 })
		expect(preview).toBe(executor)
		expect(executor).toBe("x\ny\nx")
	})

	it("agrees on stripping a line-number gutter the model pasted back", async () => {
		const { executor, preview } = await bothWays(LINES, {
			old_text: "  3 | gamma",
			new_text: "  3 | GAMMA",
		})
		expect(preview).toBe(executor)
		expect(executor).toContain("GAMMA")
		expect(executor).not.toContain("3 | ")
	})

	it("keeps CRLF line endings on a CRLF file", async () => {
		// The preview split on "\n" and rejoined on "\n", which on a CRLF file
		// rewrites every line and shows the whole file as changed.
		const crlf = ["alpha", "beta", "gamma"].join("\r\n")
		const { executor, preview } = await bothWays(crlf, { start_line: 2, new_text: "BETA" })
		expect(preview).toBe(executor)
		expect(executor).toBe(["alpha", "BETA", "gamma"].join("\r\n"))
	})

	it("matches LF old_text against a CRLF file, as the executor does", async () => {
		const crlf = ["alpha", "beta", "gamma"].join("\r\n")
		const { executor, preview } = await bothWays(crlf, { old_text: "beta\ngamma", new_text: "B\nG" })
		expect(preview).toBe(executor)
		expect(executor).toBe(["alpha", "B", "G"].join("\r\n"))
	})

	it("refuses an unanchored range that is a whole-file rewrite in disguise", async () => {
		// 80 of 100 lines, claiming to be a partial edit. This is the case the
		// guard exists for.
		const big = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")
		await fs.writeFile(filePath, big, "utf-8")
		expect(() =>
			computeNewEditorContent(
				big,
				{ path: filePath, start_line: 10, end_line: 89, new_text: "x" } as EditFileInput,
				filePath,
				"modify",
			),
		).toThrow(/No replacement performed/)
	})

	it("agrees on a stated whole-file rewrite, lines 1 to the line count", async () => {
		const big = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n")
		const { executor, preview } = await bothWays(big, { start_line: 1, end_line: 100, new_text: "rewritten" })
		expect(preview).toBe(executor)
		expect(executor).toBe("rewritten")
	})
})
