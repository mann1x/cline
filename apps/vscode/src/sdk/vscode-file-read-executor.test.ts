import { type AgentToolContext, createEditorExecutor, createReadReceipts } from "@cline/core"
import * as fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createWorkspaceFileReadExecutor } from "./vscode-file-read-executor"

const context: AgentToolContext = { agentId: "agent", iteration: 1 }

describe("createWorkspaceFileReadExecutor", () => {
	let workspaceRoot: string
	const readFile = createWorkspaceFileReadExecutor(async () => workspaceRoot)

	beforeEach(async () => {
		workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "read-executor-test-"))
		await fs.mkdir(path.join(workspaceRoot, "src"))
		await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), "line one\nline two\n")
	})

	afterEach(async () => {
		await fs.rm(workspaceRoot, { recursive: true, force: true })
	})

	it("resolves relative paths against the workspace root, not process.cwd()", async () => {
		// The extension host's process.cwd() is not the workspace; a relative read
		// must still land on the workspace file.
		expect(process.cwd()).not.toBe(workspaceRoot)
		const content = await readFile({ path: "src/app.ts" }, context)
		expect(content).toContain("line one")
	})

	it("passes absolute paths through unchanged", async () => {
		const content = await readFile({ path: path.join(workspaceRoot, "src", "app.ts") }, context)
		expect(content).toContain("line two")
	})

	it("preserves line-range options on resolved relative reads", async () => {
		const content = await readFile({ path: "src/app.ts", start_line: 2, end_line: 2 }, context)
		expect(content).toContain("line two")
		expect(content).not.toContain("line one")
	})

	it("reports the resolved workspace path for missing relative files", async () => {
		await expect(readFile({ path: "src/missing.ts" }, context)).rejects.toThrow(path.join(workspaceRoot, "src", "missing.ts"))
	})
})

describe("sharing one read registry between the reader and the editor", () => {
	// The wiring trap this pins: the VS Code host replaces both executors the
	// SDK had already paired up — `read_files` with the workspace-relative
	// reader, `editor` with the diff coordinator's. If each ends up with its
	// own registry, reads are recorded in one and checked against the other,
	// and every edit is refused while each half looks correct on its own.
	it("lets an edit through when both sides share a registry", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-receipts-"))
		try {
			const filePath = path.join(dir, "app.ts")
			await fs.writeFile(filePath, "a\nb\nc\nd", "utf8")
			const receipts = createReadReceipts()
			const readFile = createWorkspaceFileReadExecutor(async () => dir, receipts)
			const editor = createEditorExecutor({ receipts })

			await readFile({ path: "app.ts" }, context)
			const result = await editor({ path: filePath, new_text: "B", start_line: 2 }, dir, context)

			expect(result).toContain("Replaced line 2")
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})

	it("refuses every edit when the two sides hold different registries", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cline-receipts-"))
		try {
			const filePath = path.join(dir, "app.ts")
			await fs.writeFile(filePath, "a\nb\nc\nd", "utf8")
			const readFile = createWorkspaceFileReadExecutor(async () => dir, createReadReceipts())
			const editor = createEditorExecutor({ receipts: createReadReceipts() })

			await readFile({ path: "app.ts" }, context)

			await expect(editor({ path: filePath, new_text: "B", start_line: 2 }, dir, context)).rejects.toThrow(
				"Read before editing",
			)
		} finally {
			await fs.rm(dir, { recursive: true, force: true })
		}
	})
})
