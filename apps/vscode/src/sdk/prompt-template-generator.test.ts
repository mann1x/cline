import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	createMessage: vi.fn(),
	buildApiHandler: vi.fn(),
}))

vi.mock("./sdk-api-handler", () => ({
	buildApiHandler: mocks.buildApiHandler,
}))
vi.mock("@shared/services/Logger", () => ({
	Logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { DEFAULT_REQUIRED_REWRITES, getBuiltinPromptTemplates } from "@cline/core"
import { generatedTemplateName, generateTemplateForModel } from "./prompt-template-generator"

const roots: string[] = []

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "cline-generated-templates-"))
	roots.push(root)
	return root
}

/** One reply, streamed the way the API handler streams. */
function replyWith(...replies: string[]) {
	let call = 0
	mocks.createMessage.mockImplementation(async function* () {
		const text = replies[Math.min(call++, replies.length - 1)]
		yield { type: "text", text }
	})
	mocks.buildApiHandler.mockReturnValue({ createMessage: mocks.createMessage })
}

/**
 * A section for every tool, because a proposal that skips one is rejected.
 *
 * The audit requires full coverage: a tool with no section keeps its built-in
 * description, and relying on that silently is the failure the requirement
 * exists to catch. A bare `{{DEFAULT}}` body is a complete section, which is
 * what makes covering thirty-one tools cheap here and cheap for a model.
 */
/**
 * A section for one of the eight tools that must be written rather than
 * inherited, in the cheapest shape that is actually acceptable.
 *
 * Not the built-in text itself: the audit rejects a verbatim copy, because a
 * copy says the same thing today and stops tracking the built-in tomorrow. A
 * sentence of the author's own, followed by the built-in text, is the shape the
 * instructions bless — it cannot have dropped an enum, an argument or an output
 * claim, and it is not a snapshot.
 *
 * `run_commands` and `skills` are composed per machine, so `default.md` holds
 * the marker for them rather than one host's answer. Their sections have to
 * keep the marker as well as carry their own words.
 */
function written(builtin: string): string {
	return builtin.trim() === "{{DEFAULT}}"
		? [
				"Run it, and only for work no other tool covers: `read_files` reads, `editor` writes, `search_codebase` searches.",
				"Output: one object per command, `{query, result, success, error?}`, with the command in `query`.",
				"",
				"{{DEFAULT}}",
			].join("\n")
		: `Read this one carefully; it is a tool models in this family misuse.\n\n${builtin}`
}

function coverEveryTool(): string {
	const required = new Set<string>(DEFAULT_REQUIRED_REWRITES)
	const tools = getBuiltinPromptTemplates().find((template) => template.name === "default")?.tools ?? {}
	return Object.entries(tools)
		.map(([tool, builtin]) =>
			// The eight behaviour-critical tools have to be written rather than
			// inherited, and reproducing the built-in text is the cheapest thing
			// that satisfies that — it cannot have dropped anything.
			required.has(tool) ? `# tool: ${tool}\n${written(builtin)}\n` : `# tool: ${tool}\n{{DEFAULT}}\n`,
		)
		.join("\n")
}

const GOOD = [
	"---",
	"name: whatever",
	"match:",
	"  provider: [anthropic]",
	"---",
	"",
	"# system",
	"You are Cline on {{PLATFORM_NAME}}, {{CURRENT_DATE}}, in {{IDE_NAME}}. Directory {{CWD}}.",
	"Use check_file and code_intel.",
	"{{CLINE_RULES}}",
	"{{CLINE_METADATA}}",
	"",
	coverEveryTool(),
].join("\n")

/**
 * The same proposal with a placeholder dropped, which the audit reports.
 *
 * Any real defect would do; this one is chosen because it is the failure that
 * loses the workspace rules at runtime without breaking anything visible.
 */
const FLAWED = GOOD.replace("{{CLINE_RULES}}\n", "")

beforeEach(() => {
	mocks.createMessage.mockReset()
	mocks.buildApiHandler.mockReset()
})

afterEach(() => {
	while (roots.length > 0) {
		rmSync(roots.pop() as string, { recursive: true, force: true })
	}
	vi.clearAllMocks()
})

describe("generatedTemplateName", () => {
	it("is derived from the provider and model, not from the template it copied", () => {
		// Naming it "gemma" would shadow the builtin, which is a surprising
		// thing to do to someone who pressed Generate.
		expect(generatedTemplateName("ollama", "v7-coder_tb:Q4_K_M")).toBe("ollama-v7-coder-tb-q4-k-m")
	})

	it("survives a model id with nothing usable in it", () => {
		expect(generatedTemplateName("", "///")).toBe("generated")
	})
})

describe("generateTemplateForModel", () => {
	it("writes a template for a provider that reports no family at all", async () => {
		// The generic path: everything except Ollama.
		replyWith(GOOD)
		const directory = makeRoot()

		const result = await generateTemplateForModel({
			providerId: "anthropic",
			modelId: "claude-opus-5",
			mode: "act",
			apiConfiguration: {} as never,
			targetDirectory: directory,
		})

		expect(result.problems).toEqual([])
		expect(result.attempts).toBe(1)
		expect(readFileSync(result.filePath, "utf8")).toContain("name: anthropic-claude-opus-5")
	})

	it("repairs a proposal the model got wrong the first time", async () => {
		// First reply drops a placeholder; the second one is clean.
		replyWith(FLAWED, GOOD)
		const directory = makeRoot()

		const result = await generateTemplateForModel({
			providerId: "anthropic",
			modelId: "claude-opus-5",
			mode: "act",
			apiConfiguration: {} as never,
			targetDirectory: directory,
		})

		expect(result.attempts).toBe(2)
		expect(result.problems).toEqual([])
	})

	it("keeps the best attempt rather than the last when none is clean", async () => {
		replyWith(FLAWED)
		const directory = makeRoot()

		const result = await generateTemplateForModel({
			providerId: "anthropic",
			modelId: "claude-opus-5",
			mode: "act",
			apiConfiguration: {} as never,
			targetDirectory: directory,
		})

		// It still writes something: a flawed proposal the user can edit beats
		// nothing at all, as long as the problems are reported with it.
		expect(result.problems.length).toBeGreaterThan(0)
		expect(readFileSync(result.filePath, "utf8")).toContain("# system")
	})

	it("never overwrites a template that is already there", async () => {
		replyWith(GOOD)
		const directory = makeRoot()

		const first = await generateTemplateForModel({
			providerId: "anthropic",
			modelId: "claude-opus-5",
			mode: "act",
			apiConfiguration: {} as never,
			targetDirectory: directory,
		})
		const second = await generateTemplateForModel({
			providerId: "anthropic",
			modelId: "claude-opus-5",
			mode: "act",
			apiConfiguration: {} as never,
			targetDirectory: directory,
		})

		expect(second.filePath).not.toBe(first.filePath)
		expect(second.filePath).toContain("-2.md")
	})

	it("reports a provider error instead of writing an empty template", async () => {
		mocks.createMessage.mockImplementation(async function* () {
			yield { type: "done", success: false, error: "401 unauthorized" }
		})
		mocks.buildApiHandler.mockReturnValue({ createMessage: mocks.createMessage })

		await expect(
			generateTemplateForModel({
				providerId: "anthropic",
				modelId: "claude-opus-5",
				mode: "act",
				apiConfiguration: {} as never,
				targetDirectory: makeRoot(),
			}),
		).rejects.toThrow("401 unauthorized")
	})
})
