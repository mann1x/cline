import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getBuiltinPromptTemplates } from "./builtin-templates";
import { BUILTIN_PROMPT_TEMPLATE_FILES } from "./builtin-templates.generated";
import { buildBuiltinTemplatesModule } from "./builtin-templates-codegen";

const TEMPLATE_DIR = join(
	__dirname,
	"..",
	"..",
	"..",
	"assets",
	"prompt-templates",
);
const GENERATED = join(__dirname, "builtin-templates.generated.ts");

describe("builtin prompt templates", () => {
	it("keeps the generated module in step with the markdown", () => {
		// Editing a template and forgetting to regenerate would ship the old
		// prompt with no other symptom. Rerun:
		//   bun scripts/generate-builtin-templates.mts
		expect(buildBuiltinTemplatesModule(TEMPLATE_DIR)).toBe(
			readFileSync(GENERATED, "utf8"),
		);
	});

	it("inlines every shipped template", () => {
		expect(BUILTIN_PROMPT_TEMPLATE_FILES.map((file) => file.fileName)).toEqual([
			"claude.md",
			"deepseek.md",
			"default.md",
			"gemma.md",
			"glm.md",
			"kimi.md",
			"qwen.md",
		]);
	});

	it("parses all of them", () => {
		// A builtin that does not parse is a build error, and it is dropped
		// silently at runtime, so this is where it has to be caught.
		expect(getBuiltinPromptTemplates()).toHaveLength(
			BUILTIN_PROMPT_TEMPLATE_FILES.length,
		);
	});

	it("carries the base layer every other template falls back to", () => {
		const templates = getBuiltinPromptTemplates();
		const base = templates.find((template) => template.name === "default");

		expect(base?.system).toBeDefined();
		expect(Object.keys(base?.tools ?? {}).length).toBeGreaterThan(0);
	});

	it("does not claim a file path for a template that has no file", () => {
		// Inlined templates are not on disk; the settings UI decides what to do
		// about editing one, and a made-up path would be worse than none.
		for (const template of getBuiltinPromptTemplates()) {
			expect(template.filePath).toBeUndefined();
		}
	});
});
