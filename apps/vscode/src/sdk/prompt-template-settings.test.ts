import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

import { readPromptTemplateSettings, resolvePromptTemplateEditPath } from "./prompt-template-settings"

const roots: string[] = []

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "cline-template-settings-"))
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

describe("readPromptTemplateSettings", () => {
	it("lists every shipped template, not only the one that won", async () => {
		const settings = await readPromptTemplateSettings({ providerId: "openai", modelId: "gpt-5.5" })

		expect(settings.templates.map((template) => template.name).sort()).toEqual(["claude", "default", "gemma", "qwen"])
		expect(settings.templates.every((template) => template.source === "builtin")).toBe(true)
	})

	it("marks the one the current provider and model resolve to", async () => {
		mocks.resolveOllamaModelFamily.mockResolvedValue("gemma4")

		const settings = await readPromptTemplateSettings({
			providerId: "ollama",
			modelId: "v7-coder_tb:Q4_K_M",
			baseUrl: "http://localhost:11434",
		})

		expect(settings.family).toBe("gemma4")
		expect(settings.activeName).toBe("gemma")
		expect(settings.overlaid).toBe(true)
		expect(settings.templates.filter((template) => template.active).map((t) => t.name)).toEqual(["gemma"])
	})

	it("says which rules a template would match on", async () => {
		const settings = await readPromptTemplateSettings({ providerId: "openai", modelId: "gpt-5.5" })
		const gemma = settings.templates.find((template) => template.name === "gemma")

		expect(gemma?.match).toEqual(["family: gemma*"])
		// default.md claims nothing, which is what makes it the base layer.
		expect(settings.templates.find((template) => template.name === "default")?.match).toEqual(["any model"])
	})

	it("flags a builtin that a user's file of the same name has replaced", async () => {
		writeTemplate(
			join(mocks.dataDir, "templates"),
			"gemma.md",
			"---\nmatch:\n  family: [gemma*]\n---\n\n# system\nMine. {{CWD}}\n{{CLINE_RULES}}\n",
		)
		mocks.resolveOllamaModelFamily.mockResolvedValue("gemma4")

		const settings = await readPromptTemplateSettings({
			providerId: "ollama",
			modelId: "v7-coder",
			baseUrl: "http://localhost:11434",
		})

		const gemmas = settings.templates.filter((template) => template.name === "gemma")
		expect(gemmas).toHaveLength(2)
		expect(gemmas.find((template) => template.source === "builtin")?.shadowed).toBe(true)
		expect(gemmas.find((template) => template.source === "global")?.active).toBe(true)
	})

	it("lists a file that failed to parse, with the reason", async () => {
		writeTemplate(join(mocks.dataDir, "templates"), "broken.md", "---\nmatch: [\n---\n\n# system\nX\n")

		const settings = await readPromptTemplateSettings({ providerId: "openai", modelId: "gpt-5.5" })
		const broken = settings.templates.find((template) => template.fileName === "broken.md")

		// It has to be listed: a template the user just wrote, silently absent,
		// looks exactly like one that was never read.
		expect(broken?.error).toBeDefined()
		expect(broken?.active).toBe(false)
	})

	it("carries a warning through to the file it came from", async () => {
		writeTemplate(
			join(mocks.dataDir, "templates"),
			"mine.md",
			"---\nmatch:\n  provider: [openai]\n---\n\n# system\nIn {{cwd}}.\n{{CLINE_RULES}}\n",
		)

		const settings = await readPromptTemplateSettings({ providerId: "openai", modelId: "gpt-5.5" })
		const mine = settings.templates.find((template) => template.name === "mine")

		expect(mine?.warnings.some((warning) => warning.includes("{{CWD}}"))).toBe(true)
	})

	it("only asks Ollama about Ollama models", async () => {
		await readPromptTemplateSettings({
			providerId: "anthropic",
			modelId: "claude-opus-5",
			baseUrl: "http://localhost:11434",
		})

		expect(mocks.resolveOllamaModelFamily).not.toHaveBeenCalled()
	})

	it("survives an Ollama that is not answering", async () => {
		mocks.resolveOllamaModelFamily.mockRejectedValue(new Error("down"))

		const settings = await readPromptTemplateSettings({
			providerId: "ollama",
			modelId: "v7-coder",
			baseUrl: "http://localhost:11434",
		})

		expect(settings.family).toBeUndefined()
		expect(settings.activeName).toBe("default")
	})
})

describe("resolvePromptTemplateEditPath", () => {
	it("opens a template that is already on disk where it is", async () => {
		const directory = join(mocks.dataDir, "templates")
		writeTemplate(directory, "mine.md", "---\n---\n\n# system\nX {{CWD}}\n{{CLINE_RULES}}\n")
		const filePath = join(directory, "mine.md")

		await expect(resolvePromptTemplateEditPath("mine.md", filePath)).resolves.toBe(filePath)
	})

	it("copies a builtin into the global directory before opening it", async () => {
		// A builtin lives in the bundle. Editing one means making it a user
		// template, which is also how it gets overridden.
		const target = await resolvePromptTemplateEditPath("gemma.md")

		expect(target).toBe(join(mocks.dataDir, "templates", "gemma.md"))
		expect(readFileSync(target, "utf8")).toContain("name: gemma")
	})

	it("never overwrites a copy the user has already edited", async () => {
		const directory = join(mocks.dataDir, "templates")
		writeTemplate(directory, "gemma.md", "mine, edited\n")

		await resolvePromptTemplateEditPath("gemma.md")

		expect(readFileSync(join(directory, "gemma.md"), "utf8")).toBe("mine, edited\n")
	})

	it("refuses a name that is not a template", async () => {
		await expect(resolvePromptTemplateEditPath("nope.md")).rejects.toThrow("nope.md")
		expect(existsSync(join(mocks.dataDir, "templates", "nope.md"))).toBe(false)
	})
})
