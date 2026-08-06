import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	applyPromptTemplateToTools,
	DEFAULT_CLINE_SYSTEM_PROMPT,
	type PromptTemplate,
	resolvePromptTemplate,
	validatePromptTemplate,
	YOLO_CLINE_SYSTEM_PROMPT,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	createApplyPatchTool,
	createAskQuestionTool,
	createEditorTool,
	createReadFilesTool,
	createSearchTool,
	createShellTool,
	createSkillsTool,
	createSubmitAndExitTool,
	createWebFetchTool,
} from "../tools/definitions";
import { createSpawnAgentTool } from "../tools/team/spawn-agent-tool";
import { createAgentTeamsTools } from "../tools/team/team-tools";
import { parsePromptTemplate } from "./prompt-template-parser";

/**
 * The prompt templates that ship with Cline.
 *
 * `default.md` reproduces the built-in prompt text verbatim so that there is a
 * file to read and diff when you want to know what a model was actually told.
 * A copy can drift from its original, and a stale copy is worse than no copy —
 * so this suite is what notices.
 */
const TEMPLATE_DIR = join(
	__dirname,
	"..",
	"..",
	"..",
	"assets",
	"prompt-templates",
);

const stubExecutor = (async () => "") as never;
const stubConfig = { cwd: "/workspace", shell: "/bin/bash" } as never;

/**
 * Every tool the SDK can hand a session, built rather than listed.
 *
 * Listing them by hand is what let two tools go missing from `default.md`
 * without a single test noticing: the list and the file were edited together,
 * so they agreed with each other and with nothing else. Constructing the tools
 * means a tool added anywhere in this package fails the coverage test on the
 * commit that adds it.
 */
const LIVE_TOOLS = [
	createReadFilesTool(stubExecutor, stubConfig),
	createSearchTool(stubExecutor, stubConfig),
	createShellTool(stubExecutor, stubConfig),
	createWebFetchTool(stubExecutor, stubConfig),
	createEditorTool(stubExecutor, stubConfig),
	createApplyPatchTool(stubExecutor, stubConfig),
	createSkillsTool(stubExecutor, stubConfig),
	createAskQuestionTool(stubExecutor),
	createSubmitAndExitTool(stubExecutor, stubConfig),
	createSpawnAgentTool({ configProvider: {} as never }),
	...createAgentTeamsTools({
		runtime: {} as never,
		requesterId: "lead",
		teammateConfigProvider: {} as never,
	}),
] as { name: string; description?: string }[];

/**
 * `run_commands` is written against the detected shell and `skills` appends the
 * installed skill list, so the file carries `{{DEFAULT}}` for both rather than
 * one machine's answer.
 */
const COMPUTED_TOOL_NAMES = ["run_commands", "skills"];

/**
 * Contributed by the VS Code host, so nothing here can build one to compare
 * against — their text is guarded by a test in `apps/vscode`, next to the
 * constants it has to match. Listed because a template may override them and
 * the validator must not call such a section "a tool that does not exist".
 */
const HOST_TOOL_NAMES = [
	"check_file",
	"code_intel",
	"switch_to_act_mode",
	"browser",
	"list_files",
];

const SHIPPED_TOOL_NAMES = [
	...LIVE_TOOLS.map((tool) => tool.name),
	...HOST_TOOL_NAMES,
].sort();

function loadShippedTemplates(): PromptTemplate[] {
	return readdirSync(TEMPLATE_DIR)
		.filter((file) => file.endsWith(".md"))
		.map((file) => {
			const result = parsePromptTemplate({
				raw: readFileSync(join(TEMPLATE_DIR, file), "utf8"),
				source: "builtin",
				fileName: file,
				filePath: join(TEMPLATE_DIR, file),
			});
			if (!result.template) {
				throw new Error(`${file}: ${result.error}`);
			}
			return result.template;
		});
}

describe("shipped prompt templates", () => {
	const templates = loadShippedTemplates();
	const byName = new Map(
		templates.map((template) => [template.name, template]),
	);

	it("ships the base layer and one template per model family", () => {
		expect([...byName.keys()].sort()).toEqual([
			"claude",
			"deepseek",
			"default",
			"gemma",
			"glm",
			"kimi",
			"qwen",
		]);
	});

	it("keeps default.md verbatim against the built-in system prompt", () => {
		expect(byName.get("default")?.system).toBe(
			DEFAULT_CLINE_SYSTEM_PROMPT.trim(),
		);
	});

	it("keeps default.md verbatim against every static tool description", () => {
		const shipped = byName.get("default");
		for (const tool of LIVE_TOOLS) {
			if (COMPUTED_TOOL_NAMES.includes(tool.name)) {
				continue;
			}
			expect(
				shipped?.tools[tool.name],
				`default.md is stale or missing for ${tool.name}`,
			).toBe((tool.description ?? "").trim());
		}
	});

	it("defers to the code for the two computed descriptions", () => {
		for (const name of COMPUTED_TOOL_NAMES) {
			expect(byName.get("default")?.tools[name]).toBe("{{DEFAULT}}");
		}

		const [wrapped] = applyPromptTemplateToTools(
			[{ name: "run_commands", description: "shell-specific text" }],
			byName.get("default"),
		);
		expect(wrapped?.description).toBe("shell-specific text");
	});

	it("covers every tool the default template claims to reproduce", () => {
		// A tool added to the code but not to default.md would silently fall
		// through to its built-in description, which is correct behaviour but
		// makes the file a partial record without saying so.
		const shipped = byName.get("default");
		expect(Object.keys(shipped?.tools ?? {}).sort()).toEqual(
			SHIPPED_TOOL_NAMES,
		);
	});

	it("keeps the rules and metadata placeholders in every system prompt", () => {
		// Dropping these silently loses the plan-mode contract and the workspace
		// block, and nothing else in the pipeline would report it.
		for (const template of templates) {
			if (template.system === undefined) {
				continue;
			}
			expect(
				template.system,
				`${template.name} lost {{CLINE_RULES}}`,
			).toContain("{{CLINE_RULES}}");
			expect(
				template.system,
				`${template.name} lost {{CLINE_METADATA}}`,
			).toContain("{{CLINE_METADATA}}");
		}
	});

	it("keeps the environment placeholders the base prompt substitutes", () => {
		for (const template of templates) {
			if (template.system === undefined) {
				continue;
			}
			for (const placeholder of [
				"{{PLATFORM_NAME}}",
				"{{CURRENT_DATE}}",
				"{{IDE_NAME}}",
				"{{CWD}}",
			]) {
				expect(
					template.system,
					`${template.name} lost ${placeholder}`,
				).toContain(placeholder);
			}
		}
	});

	it("does not accidentally reproduce the yolo prompt", () => {
		// Different text, different mode; default.md is about the default prompt.
		expect(byName.get("default")?.system).not.toBe(
			YOLO_CLINE_SYSTEM_PROMPT.trim(),
		);
	});

	describe("resolution against real models", () => {
		const cases: Array<
			[string, { providerId: string; modelId: string; family?: string }, string]
		> = [
			[
				"a Gemma-derived model whose name says nothing about its family",
				{
					providerId: "ollama",
					modelId: "v7-coder_tb:Q4_K_M",
					family: "gemma4",
				},
				"gemma",
			],
			[
				"a Qwen MoE reported as qwen35moe",
				{
					providerId: "ollama",
					modelId: "mannix/qwen3.6-27b-a3b-coder:Q4_K_M",
					family: "qwen35moe",
				},
				"qwen",
			],
			[
				"a Qwen VL variant",
				{ providerId: "ollama", modelId: "qwen3-vl:8b", family: "qwen3vl" },
				"qwen",
			],
			[
				"Gemma 3",
				{
					providerId: "ollama",
					modelId: "gemma3:27b-it-qat",
					family: "gemma3",
				},
				"gemma",
			],
			[
				"Claude on Anthropic",
				{ providerId: "anthropic", modelId: "claude-sonnet-5" },
				"claude",
			],
			[
				"the same Claude through a gateway",
				{ providerId: "openrouter", modelId: "anthropic/claude-opus-4.6" },
				"claude",
			],
			[
				"Fable, whose id keeps the claude prefix",
				{ providerId: "anthropic", modelId: "claude-fable-5" },
				"claude",
			],
			[
				"Fable through a gateway that drops the prefix",
				{ providerId: "openrouter", modelId: "anthropic/fable-5" },
				"claude",
			],
			[
				"Haiku",
				{ providerId: "anthropic", modelId: "claude-haiku-4-5-20251001" },
				"claude",
			],
			[
				"a model no template claims",
				{ providerId: "ollama", modelId: "gpt-oss:latest", family: "gptoss" },
				"default",
			],
			[
				"a provider that reports no family at all",
				{ providerId: "openai", modelId: "gpt-5.5" },
				"default",
			],
		];

		for (const [label, target, expected] of cases) {
			it(`routes ${label} to ${expected}`, () => {
				expect(resolvePromptTemplate(templates, target)?.name).toBe(expected);
			});
		}
	});

	it("points every family template away from the shell and at a tool", () => {
		// Asserted on intent rather than wording: these are regenerated by the
		// models themselves and the phrasing is theirs. What has to survive a
		// regeneration is that `run_commands` names the tool to reach for
		// instead, because "do not use this for file operations" is a rule the
		// reader has to already know the answer to in order to follow.
		for (const name of ["gemma", "qwen", "glm", "kimi", "deepseek"]) {
			const template = byName.get(name);
			expect(template?.tools.run_commands, `${name} run_commands`).toMatch(
				/editor/,
			);
			expect(template?.tools.run_commands, `${name} run_commands`).toMatch(
				/read_files/,
			);
		}
	});

	it("names the shell idiom in the templates written against it", () => {
		// Only gemma and qwen. These two were observed reaching for `sed -i`
		// and `echo >` specifically, so their file tools name the idiom rather
		// than the category — the prohibition has to be recognisable to a model
		// that is halfway through typing it. The other three were not, and
		// inventing the failure for them would be inventing evidence.
		for (const name of ["gemma", "qwen"]) {
			expect(byName.get(name)?.tools.editor, `${name} editor`).toMatch(/sed/);
		}
	});

	it("passes its own sanity check", () => {
		// Whatever the checker tells a user about their template, it has to be
		// true of the ones shipped alongside it first.
		for (const template of templates) {
			expect(
				validatePromptTemplate(template, {
					knownToolNames: SHIPPED_TOOL_NAMES,
				}),
				`${template.name} has warnings`,
			).toEqual([]);
		}
	});

	it("gives every template a section for every tool", () => {
		// A template that covers some of the tools is relying on the fallback
		// rather than using it, and nothing in the file shows which ones were
		// left out. The fallback is for a tool Cline has just gained.
		for (const template of templates) {
			expect(
				Object.keys(template.tools).sort(),
				`${template.name} does not cover every tool`,
			).toEqual([...SHIPPED_TOOL_NAMES].sort());
		}
	});

	it("never replaces a description the code composes at runtime", () => {
		// `run_commands` is written against the detected shell and `skills`
		// appends the installed skills. Replacing either outright ships one
		// machine's answer to every machine, and nothing reports it.
		for (const template of templates) {
			for (const name of COMPUTED_TOOL_NAMES) {
				expect(
					template.tools[name],
					`${template.name} ${name} must keep {{DEFAULT}}`,
				).toContain("{{DEFAULT}}");
			}
		}
	});
});
