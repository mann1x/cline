import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	resolveOllamaModelFamily: vi.fn(async () => undefined as string | undefined),
	dataDir: "",
}))

vi.mock("./ollama-model-family", () => ({
	resolveOllamaModelFamily: mocks.resolveOllamaModelFamily,
}))
vi.mock("@shared/storage/storage-context", () => ({
	resolveDataDirFromEnv: () => mocks.dataDir,
}))
vi.mock("@shared/services/Logger", () => ({
	Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
	resolveGlobalTemplateDirectory,
	resolveSessionPromptTemplate,
	resolveWorkspaceTemplateDirectory,
} from "./prompt-templates"

const roots: string[] = []

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "cline-session-templates-"))
	roots.push(root)
	return root
}

function writeTemplate(dir: string, name: string, content: string): void {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, name), content, "utf8")
}

beforeEach(() => {
	mocks.dataDir = makeRoot()
	mocks.resolveOllamaModelFamily.mockReset()
	mocks.resolveOllamaModelFamily.mockResolvedValue(undefined)
})

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop() as string, { recursive: true, force: true })
	}
	vi.clearAllMocks()
})

describe("resolveGlobalTemplateDirectory", () => {
	it("sits under the Cline data directory", () => {
		mocks.dataDir = "/home/me/.cline/data"
		expect(resolveGlobalTemplateDirectory()).toBe("/home/me/.cline/data/templates")
	})
})

describe("resolveWorkspaceTemplateDirectory", () => {
	it("sits under .clinerules so it is committed with the project", () => {
		expect(resolveWorkspaceTemplateDirectory("/repo")).toBe("/repo/.clinerules/templates")
	})

	it("is absent without a workspace", () => {
		expect(resolveWorkspaceTemplateDirectory("")).toBeUndefined()
	})
})

describe("resolveSessionPromptTemplate", () => {
	it("routes a local Gemma to the gemma template on family alone", async () => {
		// The whole reason the family lookup exists: nothing in this model's
		// name says Gemma.
		mocks.resolveOllamaModelFamily.mockResolvedValue("gemma4")

		const result = await resolveSessionPromptTemplate({
			providerId: "ollama",
			modelId: "v7-coder_tb:Q4_K_M",
			baseUrl: "http://localhost:11434",
		})

		expect(result.family).toBe("gemma4")
		expect(result.rendered?.name).toBe("gemma")
		expect(result.rendered?.overlaid).toBe(true)
	})

	it("falls back to default.md for a tool the family template never mentions", async () => {
		mocks.resolveOllamaModelFamily.mockResolvedValue("gemma4")

		const result = await resolveSessionPromptTemplate({
			providerId: "ollama",
			modelId: "v7-coder",
			baseUrl: "http://localhost:11434",
		})

		// gemma.md rewrites these four and says nothing about the rest.
		expect(result.rendered?.tools.editor).toContain("sed -i")
		expect(result.rendered?.tools.apply_patch).toBeDefined()
		expect(result.rendered?.tools.ask_question).toBeDefined()
	})

	it("routes Claude on its model name, with no family to go on", async () => {
		const result = await resolveSessionPromptTemplate({
			providerId: "anthropic",
			modelId: "claude-fable-5",
		})

		expect(result.family).toBeUndefined()
		expect(result.rendered?.name).toBe("claude")
	})

	it("only asks Ollama about Ollama models", async () => {
		await resolveSessionPromptTemplate({
			providerId: "anthropic",
			modelId: "claude-opus-5",
			baseUrl: "http://localhost:11434",
		})

		expect(mocks.resolveOllamaModelFamily).not.toHaveBeenCalled()
	})

	it("still asks Ollama when no base url is configured", async () => {
		// Blank is the normal state for a local install, and it means Ollama's
		// default endpoint — which is where this session's own requests go.
		// Skipping the lookup here is how a local Qwen lands on default.md.
		mocks.resolveOllamaModelFamily.mockResolvedValue("qwen35moe")

		const result = await resolveSessionPromptTemplate({
			providerId: "ollama",
			modelId: "a3b-coder_tb:vision-Q3_K_M",
		})

		expect(mocks.resolveOllamaModelFamily).toHaveBeenCalledWith(undefined, "a3b-coder_tb:vision-Q3_K_M")
		expect(result.family).toBe("qwen35moe")
		expect(result.rendered?.name).toBe("qwen")
	})

	it("lands on default.md when nothing claims the model", async () => {
		const result = await resolveSessionPromptTemplate({
			providerId: "openai",
			modelId: "gpt-5.5",
		})

		expect(result.rendered?.name).toBe("default")
		expect(result.rendered?.overlaid).toBe(false)
	})

	it("lets a global template shadow the shipped one of the same name", async () => {
		writeTemplate(
			join(mocks.dataDir, "templates"),
			"gemma.md",
			"---\nmatch:\n  family: [gemma*]\n---\n\n# system\nMine. {{CWD}}\n{{CLINE_RULES}}\n",
		)
		mocks.resolveOllamaModelFamily.mockResolvedValue("gemma4")

		const result = await resolveSessionPromptTemplate({
			providerId: "ollama",
			modelId: "v7-coder",
			baseUrl: "http://localhost:11434",
		})

		expect(result.rendered?.system).toContain("Mine.")
		expect(result.rendered?.source).toBe("global")
		// Shadowing replaces the shipped gemma.md, but default.md still supplies
		// every tool it did not mention.
		expect(result.rendered?.tools.editor).toBeDefined()
	})

	it("lets a workspace template beat a global one", async () => {
		const workspace = makeRoot()
		writeTemplate(
			join(mocks.dataDir, "templates"),
			"house.md",
			"---\nmatch:\n  provider: [ollama]\n---\n\n# system\nGlobal. {{CWD}}\n{{CLINE_RULES}}\n",
		)
		writeTemplate(
			join(workspace, ".clinerules", "templates"),
			"house.md",
			"---\nmatch:\n  provider: [ollama]\n---\n\n# system\nWorkspace. {{CWD}}\n{{CLINE_RULES}}\n",
		)

		const result = await resolveSessionPromptTemplate({
			providerId: "ollama",
			modelId: "some-model",
			workspaceRoot: workspace,
			baseUrl: "http://localhost:11434",
		})

		expect(result.rendered?.system).toContain("Workspace.")
		expect(result.rendered?.source).toBe("workspace")
	})

	it("reports a broken template and still resolves one", async () => {
		writeTemplate(join(mocks.dataDir, "templates"), "broken.md", "---\nmatch: [\n---\n\n# system\nX\n")

		const result = await resolveSessionPromptTemplate({
			providerId: "openai",
			modelId: "gpt-5.5",
		})

		expect(result.errors).toHaveLength(1)
		expect(result.errors[0]?.fileName).toBe("broken.md")
		expect(result.rendered?.name).toBe("default")
	})

	it("reports a warning without refusing the template", async () => {
		writeTemplate(
			join(mocks.dataDir, "templates"),
			"mine.md",
			"---\nmatch:\n  provider: [openai]\n---\n\n# system\nIn {{cwd}}.\n{{CLINE_RULES}}\n",
		)

		const result = await resolveSessionPromptTemplate({
			providerId: "openai",
			modelId: "gpt-5.5",
		})

		expect(result.rendered?.name).toBe("mine")
		expect(result.warnings[0]?.warnings.some((warning) => warning.message.includes("{{CWD}}"))).toBe(true)
	})

	it("still resolves a template when the family lookup throws", async () => {
		// Not knowing the family costs a family template. It must not cost the
		// whole stack, including default.md.
		mocks.resolveOllamaModelFamily.mockRejectedValue(new Error("down"))

		const result = await resolveSessionPromptTemplate({
			providerId: "ollama",
			modelId: "v7-coder",
			baseUrl: "http://localhost:11434",
		})

		expect(result.family).toBeUndefined()
		expect(result.rendered?.name).toBe("default")
		expect(Object.keys(result.rendered?.tools ?? {}).length).toBeGreaterThan(0)
	})
})
