import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getBuiltinPromptTemplates } from "./builtin-templates";
import { BUILTIN_PROMPT_TEMPLATE_FILES } from "./builtin-templates.generated";
import { buildBuiltinTemplatesModule } from "./builtin-templates-codegen";
import { findBatchedEditRules } from "./prompt-template-review";

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
			"kimi-k3.md",
			"kimi.md",
			"minimax.md",
			"nemotron.md",
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

	it("ships no template telling the model to batch its edits", () => {
		// The ban existed and was enforced -- against model proposals only. The
		// rule still reached seven of these ten files, because `default.md` is
		// hand-maintained and every other template is regenerated from it, and
		// nothing ever audited what shipped. This is the gate on the artefact
		// rather than on the proposal: a hand-edit, a promoted proposal and a
		// regeneration all land here.
		//
		// Gathering stays batched. Reads, searches and commands cost nothing if
		// one turns out to be unnecessary; a batch of edits that fails its check
		// leaves several things to undo instead of one, which is the restore loop
		// measured at 13.6 `restore_file` calls per run against 0.23.
		// System *and* tool sections. Scanning only the system section is the
		// mistake that let this ship: nine of the ten carried it in
		// `# tool: editor`, which the model reads in the same request.
		const offenders = getBuiltinPromptTemplates().flatMap((template) => [
			...findBatchedEditRules(template.system ?? "").map(
				(line) => `${template.name} [system]: ${line.trim().slice(0, 110)}`,
			),
			...Object.entries(template.tools ?? {}).flatMap(([tool, body]) =>
				findBatchedEditRules(body ?? "").map(
					(line) =>
						`${template.name} [tool: ${tool}]: ${line.trim().slice(0, 110)}`,
				),
			),
		]);

		expect(offenders).toEqual([]);
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
