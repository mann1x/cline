import type { PromptTemplate } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	auditExampleCalls,
	auditPromptTemplateProposal,
	auditToolSectionContent,
	buildPromptTemplateRepairPrompt,
	buildPromptTemplateReviewPrompt,
	extractTemplateFromReply,
	renderToolCallSignatures,
	summarizeToolCallSignatures,
} from "./prompt-template-review";

/**
 * The base layer a proposal is judged against, kept minimal so a test says what
 * it is about rather than inheriting whatever `default.md` happens to contain.
 */
const BASE: PromptTemplate[] = [
	{
		name: "default",
		fileName: "default.md",
		source: "builtin",
		system: "base {{CWD}} {{CLINE_RULES}}",
		tools: { editor: "base editor" },
	},
];

const KNOWN_TOOLS = ["editor", "read_files", "run_commands", "check_file"];

function audit(raw: string, overrides: Record<string, unknown> = {}) {
	return auditPromptTemplateProposal({
		raw,
		fileName: "gemma.md",
		providerId: "ollama",
		modelId: "gemma4:31b-cloud",
		family: "gemma4",
		knownToolNames: KNOWN_TOOLS,
		expectedName: "gemma",
		baseTemplates: BASE,
		...overrides,
	});
}

const GOOD = [
	"---",
	"name: gemma",
	"match:",
	"  family: [gemma*]",
	"---",
	"",
	"# system",
	// Every placeholder the base prompt substitutes: the audit reports a
	// missing optional one too, and a fixture without them tests nothing but
	// its own omissions.
	"You are Cline on {{PLATFORM_NAME}}, {{CURRENT_DATE}}, in {{IDE_NAME}}.",
	"Working directory: {{CWD}}",
	"{{CLINE_RULES}}",
	"{{CLINE_METADATA}}",
	"",
	"# tool: editor",
	"Use this to write files.",
	"",
].join("\n");

describe("auditPromptTemplateProposal", () => {
	it("accepts a proposal that is actually usable", () => {
		const result = audit(GOOD);

		expect(result.problems).toEqual([]);
		expect(result.template?.name).toBe("gemma");
	});

	it("rejects a file that does not parse", () => {
		const result = audit("---\nmatch: [\n---\n\n# system\nX\n");

		expect(result.template).toBeUndefined();
		expect(result.problems[0]).toContain("does not parse");
	});

	it("catches the duplicated section, which is otherwise silent", () => {
		// The failure observed from a real model: it emitted the same tool
		// section twice, the last copy won, and the file looked fine.
		const result = audit(
			GOOD.replace(
				"# tool: editor\nUse this to write files.",
				"# tool: editor\nfirst\n\n# tool: editor\nsecond",
			),
		);

		expect(
			result.problems.some((problem) => problem.includes("more than once")),
		).toBe(true);
	});

	it("catches a match block that no longer routes to this model", () => {
		// The worst failure of the three: the file loads, resolves, and is
		// simply never applied to anything.
		const result = audit(GOOD.replace("family: [gemma*]", "family: [qwen*]"));

		expect(
			result.problems.some((problem) =>
				problem.includes("no longer selects this model"),
			),
		).toBe(true);
	});

	it("catches a rename, which orphans the file just as effectively", () => {
		const result = audit(GOOD.replace("name: gemma", "name: gemma-v2"));

		expect(
			result.problems.some((problem) => problem.includes("must stay 'gemma'")),
		).toBe(true);
	});

	it("catches a tool the model invented", () => {
		const result = audit(
			GOOD.replace("# tool: editor", "# tool: edit_file_contents"),
		);

		expect(
			result.problems.some((problem) => problem.includes("no tool called")),
		).toBe(true);
	});

	it("catches a dropped placeholder", () => {
		const result = audit(GOOD.replace("{{CLINE_RULES}}", ""));

		expect(
			result.problems.some((problem) => problem.includes("{{CLINE_RULES}}")),
		).toBe(true);
	});

	it("allows a new template to name itself when there is nothing to keep", () => {
		// A model with no family template writes one, so there is no prior name
		// for it to preserve.
		const result = audit(GOOD.replace("name: gemma", "name: brand-new"), {
			expectedName: undefined,
		});

		expect(result.problems).toEqual([]);
	});

	it("catches a rewrite that quietly forgot a tool it was asked to address", () => {
		// Omitting a tool section is legal, so nothing structural notices. This
		// is what stops a run from silently regressing on the point of the
		// exercise.
		const result = audit(GOOD, { requiredMentions: ["check_file"] });

		expect(
			result.problems.some((problem) =>
				problem.includes("never mentions 'check_file'"),
			),
		).toBe(true);
	});

	it("requires a section for every tool, not a mention", () => {
		// The fallback is legal and silent, which is why it has to be checked
		// here: a template covering one of four tools loads, resolves and
		// applies, and nothing anywhere reports the other three.
		const result = audit(GOOD, { requiredSections: KNOWN_TOOLS });

		const reported = result.problems.find((problem) =>
			problem.includes("have no '# tool:' section"),
		);
		expect(reported).toContain("read_files");
		expect(reported).toContain("run_commands");
		expect(reported).toContain("check_file");
		// `editor` has a section, so it must not be listed as missing.
		expect(reported).not.toContain(", editor");
	});

	it("counts a bare {{DEFAULT}} section as covered", () => {
		// This is the cheap way to cover a tool a model has nothing to add to,
		// and the instructions tell it so. If the audit rejected it, the only
		// way to pass would be to invent filler for thirty-one tools.
		const covered = KNOWN_TOOLS.map(
			(tool) => `\n# tool: ${tool}\n{{DEFAULT}}\n`,
		).join("");
		const result = audit(
			GOOD.replace("# tool: editor\nUse this to write files.\n", "") + covered,
			// No required rewrites here: this test is about coverage, which a
			// bare marker satisfies. Rewrite depth is a separate rule with its
			// own tests.
			{ requiredSections: KNOWN_TOOLS, requiredRewrites: [] },
		);

		expect(result.problems).toEqual([]);
	});

	it("is satisfied by a mention anywhere, not only a tool section", () => {
		const result = audit(
			GOOD.replace(
				"You are Cline on",
				"Use check_file to validate. You are Cline on",
			),
			{ requiredMentions: ["check_file"] },
		);

		expect(result.problems).toEqual([]);
	});

	it("judges routing against whatever provider is asked for, not just Ollama", () => {
		// Only Ollama reports a model family. Every other provider matches on the
		// provider id or the model name, and the audit has to understand that or
		// it would reject every non-Ollama template as unroutable.
		const anthropic = GOOD.replace(
			"match:\n  family: [gemma*]",
			"match:\n  provider: [anthropic]",
		).replace("name: gemma", "name: claude");

		expect(
			auditPromptTemplateProposal({
				raw: anthropic,
				fileName: "claude.md",
				providerId: "anthropic",
				modelId: "claude-opus-5",
				family: undefined,
				knownToolNames: KNOWN_TOOLS,
				expectedName: "claude",
				baseTemplates: BASE,
			}).problems,
		).toEqual([]);

		// And the same file is correctly rejected for a provider it does not claim.
		expect(
			auditPromptTemplateProposal({
				raw: anthropic,
				fileName: "claude.md",
				providerId: "openai",
				modelId: "gpt-5.5",
				family: undefined,
				knownToolNames: KNOWN_TOOLS,
				expectedName: "claude",
				baseTemplates: BASE,
			}).problems.some((problem) =>
				problem.includes("no longer selects this model"),
			),
		).toBe(true);
	});

	it("reports every problem at once, not the first", () => {
		// A repair round is a whole model call. Spending one per problem would
		// exhaust the attempts on a file with three of them.
		const result = audit(
			GOOD.replace("family: [gemma*]", "family: [qwen*]").replace(
				"name: gemma",
				"name: gemma-v2",
			),
		);

		expect(result.problems.length).toBeGreaterThanOrEqual(2);
	});
});

describe("buildPromptTemplateRepairPrompt", () => {
	it("numbers the problems and includes the file to fix", () => {
		const prompt = buildPromptTemplateRepairPrompt("the file", [
			"first problem",
			"second problem",
		]);

		expect(prompt).toContain("1. first problem");
		expect(prompt).toContain("2. second problem");
		expect(prompt).toContain("the file");
	});
});

describe("extractTemplateFromReply", () => {
	it("takes a bare reply as-is", () => {
		expect(extractTemplateFromReply("  ---\nname: x\n---  ")).toBe(
			"---\nname: x\n---",
		);
	});

	it("unwraps a code fence, which models add despite being told not to", () => {
		expect(
			extractTemplateFromReply("here you go:\n```markdown\n# system\nX\n```\n"),
		).toBe("# system\nX");
	});

	it("unwraps an unlabelled fence too", () => {
		expect(extractTemplateFromReply("```\n# system\nX\n```")).toBe(
			"# system\nX",
		);
	});
});

describe("buildPromptTemplateReviewPrompt", () => {
	it("shows a model writing a new template the exact match block to use", () => {
		// Both models that wrote a template from scratch invented a match shape
		// that either failed to parse or routed to nothing. Handing them the
		// block, filled in with their own family, is the fix.
		const prompt = buildPromptTemplateReviewPrompt(
			"default body",
			undefined,
			undefined,
			{
				providerId: "ollama",
				modelId: "glm-5.2:cloud",
				family: "glm5.2",
			},
		);

		// glm5* rather than glm*: it claims the 5.x line without over-claiming
		// every GLM that ever shipped.
		expect(prompt).toContain("match:\n  family: [glm5*]");
		expect(prompt).toContain("'glm5.2'");
	});

	it("falls back to the model name when the provider reports no family", () => {
		const prompt = buildPromptTemplateReviewPrompt(
			"default body",
			undefined,
			undefined,
			{
				providerId: "anthropic",
				modelId: "claude-opus-5",
			},
		);

		expect(prompt).toContain('model: ["*claude-opus-5*"]');
	});

	it("says nothing about writing a new one when there is a template to rewrite", () => {
		const prompt = buildPromptTemplateReviewPrompt(
			"default body",
			"gemma body",
			"gemma.md",
			{
				providerId: "ollama",
				modelId: "v7-coder",
				family: "gemma4",
			},
		);

		expect(prompt).toContain("Rewrite gemma.md.");
		expect(prompt).not.toContain("No template claims you today");
	});
});

describe("summarizeToolCallSignatures", () => {
	it("renders the wrapper the description leaves out", () => {
		// The exact gap that made a qwen3.6 session fail four times: the
		// description named the inner object, the schema wanted an array of them.
		const [fetch] = summarizeToolCallSignatures([
			{
				name: "fetch_web_content",
				inputSchema: {
					type: "object",
					required: ["requests"],
					properties: {
						requests: {
							type: "array",
							items: {
								type: "object",
								required: ["url", "prompt"],
								properties: {
									url: { type: "string" },
									prompt: { type: "string" },
								},
							},
						},
					},
				},
			},
		]);

		expect(fetch.signature).toBe(
			"fetch_web_content(requests: [{url, prompt}])",
		);
		expect(fetch.required).toEqual(["requests"]);
	});

	it("marks optional arguments and unwraps nullable ones", () => {
		const [editor] = summarizeToolCallSignatures([
			{
				name: "editor",
				inputSchema: {
					type: "object",
					required: ["path", "new_text"],
					properties: {
						path: { type: "string" },
						new_text: { type: "string" },
						old_text: { anyOf: [{ type: "string" }, { type: "null" }] },
					},
				},
			},
		]);

		expect(editor.signature).toBe(
			"editor(path: string, new_text: string, old_text?: string)",
		);
	});

	it("tells the model the wrappers are the point", () => {
		const block = renderToolCallSignatures(
			summarizeToolCallSignatures([
				{ name: "x", inputSchema: { properties: { a: { type: "string" } } } },
			]),
		);

		expect(block).toContain("x(a?: string)");
		expect(block).toContain("Note the wrappers");
	});
});

describe("auditExampleCalls", () => {
	const signatures = summarizeToolCallSignatures([
		{
			name: "read_files",
			inputSchema: {
				type: "object",
				required: ["files"],
				properties: {
					files: {
						type: "array",
						items: {
							type: "object",
							required: ["path"],
							properties: { path: { type: "string" } },
						},
					},
				},
			},
		},
		{
			name: "search_codebase",
			inputSchema: {
				type: "object",
				required: ["queries"],
				properties: { queries: { type: "array", items: { type: "string" } } },
			},
		},
	]);

	it("catches the exact invalid example the shipped qwen template contained", () => {
		const problems = auditExampleCalls(
			'Right: `read_files(["src/app.ts"])`',
			signatures,
		);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("positionally");
		expect(problems[0]).toContain("read_files(files: [{path}])");
	});

	it("catches an argument name the tool does not have", () => {
		const problems = auditExampleCalls(
			'search_codebase(pattern="function foo")',
			signatures,
		);

		expect(problems[0]).toContain("'pattern'");
		expect(problems[0]).toContain("search_codebase(queries: [string])");
	});

	it("accepts a correctly shaped example", () => {
		expect(
			auditExampleCalls('read_files(files=[{path: "a.ts"}])', signatures),
		).toEqual([]);
	});

	it("accepts a nested key alongside the real argument", () => {
		// `files: [{path: ...}]` names `path`, which is not a top-level argument;
		// that must not be reported.
		expect(
			auditExampleCalls('read_files(files: [{path: "a.ts"}])', signatures),
		).toEqual([]);
	});

	it("says nothing about a bare mention with no call", () => {
		expect(
			auditExampleCalls("Use read_files to read files.", signatures),
		).toEqual([]);
	});

	it("reports each distinct example once", () => {
		const problems = auditExampleCalls(
			'`read_files(["a.ts"])` ... later again `read_files(["a.ts"])`',
			signatures,
		);

		expect(problems).toHaveLength(1);
	});
});

/**
 * A rewritten section replaces the built-in text entirely, so it has to carry
 * what that text was carrying. A section that keeps the marker does not — it
 * is layered on top of a complete description, and holding it to the same bar
 * would mean the only way to add one sentence of emphasis is to restate the
 * whole tool.
 */
describe("auditToolSectionContent", () => {
	const CODE_INTEL = summarizeToolCallSignatures([
		{
			name: "code_intel",
			inputSchema: {
				type: "object",
				properties: {
					operation: {
						type: "string",
						enum: ["definition", "references", "hover"],
					},
					path: { type: "string" },
					symbol: { type: "string" },
				},
				required: ["operation"],
			},
		},
	]);

	/** What the built-in description says; nothing beyond it is required. */
	const BUILTIN = {
		code_intel: [
			"Ask the language server about a symbol.",
			"Operations: definition, references, hover.",
			"Address by path plus symbol.",
			"Output: one result per line as file:line:column.",
		].join("\n"),
	};

	it("passes a replacement that names the operations, the arguments and the output", () => {
		const body = [
			"Ask the language server about a symbol.",
			"Operations: definition, references, hover.",
			"Address it by path plus symbol, or by operation alone.",
			"Output: one result per line as file:line:column with the source line.",
		].join("\n");

		expect(
			auditToolSectionContent({ code_intel: body }, CODE_INTEL, BUILTIN),
		).toEqual([]);
	});

	it("catches a replacement that hides half of a closed set", () => {
		const body = [
			"Use this for definition lookups.",
			"Address it by path plus symbol, with operation set.",
			"Output: one result per line as file:line:column with the source line.",
		].join("\n");

		const [problem] = auditToolSectionContent(
			{ code_intel: body },
			CODE_INTEL,
			BUILTIN,
		);
		expect(problem).toContain("references");
		expect(problem).toContain("hover");
	});

	it("catches a replacement that never says how to address the tool", () => {
		const body = [
			"Use this for symbols.",
			"Operations: definition, references, hover.",
			"Output: one result per line as file:line:column with the source line.",
		].join("\n");

		expect(
			auditToolSectionContent({ code_intel: body }, CODE_INTEL, BUILTIN).some(
				(problem) => problem.includes("drops the argument(s) it named"),
			),
		).toBe(true);
	});

	it("catches a replacement that never says what comes back", () => {
		const body = [
			"Operations: definition, references, hover.",
			"Address it by path plus symbol.",
		].join("\n");

		expect(
			auditToolSectionContent({ code_intel: body }, CODE_INTEL, BUILTIN).some(
				(problem) =>
					problem.includes("drops what it said about the tool's output"),
			),
		).toBe(true);
	});

	it("exempts a section that keeps the marker", () => {
		// Two lines of emphasis over the full built-in description. Requiring
		// the whole contract here would make adding emphasis impossible.
		const body = "Use this instead of grep for symbols.\n{{DEFAULT}}";

		expect(
			auditToolSectionContent({ code_intel: body }, CODE_INTEL, BUILTIN),
		).toEqual([]);
	});

	it("requires nothing the built-in description did not itself provide", () => {
		// The built-in `team_send_message` text names neither `subject` nor
		// `body`. Demanding them would ask a model to add what it was never
		// shown — measured, it fails four attempts without converging, because
		// there is nothing in front of it to converge on.
		const signatures = summarizeToolCallSignatures([
			{
				name: "team_send_message",
				inputSchema: {
					type: "object",
					properties: {
						toAgentId: { type: "string" },
						subject: { type: "string" },
						body: { type: "string" },
					},
					required: ["toAgentId", "subject", "body"],
				},
			},
		]);

		expect(
			auditToolSectionContent(
				{
					team_send_message:
						"Send one teammate a message. Output: {id, toAgentId}.",
				},
				signatures,
				{
					team_send_message:
						"Send a mailbox message to a specific teammate. Output: {id, toAgentId}.",
				},
			),
		).toEqual([]);
	});

	it("rejects an Output label with nothing behind it", () => {
		// Observed shape: `Output: .` — the label survived a rewrite and the
		// description did not. It reads as "this tool returns nothing".
		const [problem] = auditToolSectionContent(
			{ team_cleanup: "Clean up the team runtime. Output: ." },
			[],
		);
		expect(problem).toContain("says 'Output:' and then nothing");
	});

	it("accepts a shape as an output description however short", () => {
		// `{agentId, status}` is the entire answer for half the team tools. A
		// length rule that rejected it would be asking for padding.
		expect(
			auditToolSectionContent(
				{ team_cleanup: "Clean up the team runtime. Output: {status}." },
				[],
			),
		).toEqual([]);
	});

	it("rejects an Output claim too short to be one", () => {
		const [problem] = auditToolSectionContent(
			{ team_cleanup: "Clean up the team runtime. Output: text." },
			[],
		);
		expect(problem).toContain("does not say what a caller will receive");
	});
});

describe("auditExampleCalls and counter-examples", () => {
	const SIGNATURES = summarizeToolCallSignatures([
		{
			name: "read_files",
			inputSchema: {
				type: "object",
				properties: { files: { type: "array", items: { type: "object" } } },
				required: ["files"],
			},
		},
	]);

	it("ignores a malformed call that is labelled as the wrong way", () => {
		// Showing both shapes is better prompt writing than showing one, and an
		// audit that punished it would train the repair loop to delete the
		// warning rather than fix anything.
		const raw = [
			'- **Correct**: `read_files(files: [{path: "a.ts"}])`',
			'- **Wrong**: `read_files([{path: "a.ts"}])` (missing the `files:` key)',
		].join("\n");

		expect(auditExampleCalls(raw, SIGNATURES)).toEqual([]);
	});

	it("still catches the same call when nothing marks it as wrong", () => {
		const raw = 'Read a file with `read_files([{path: "a.ts"}])`.';

		expect(auditExampleCalls(raw, SIGNATURES).length).toBeGreaterThan(0);
	});
});

describe("required rewrites", () => {
	const SIGNATURES = summarizeToolCallSignatures([
		{
			name: "code_intel",
			inputSchema: {
				type: "object",
				properties: {
					operation: { type: "string", enum: ["definition", "references"] },
					path: { type: "string" },
				},
				required: ["operation"],
			},
		},
	]);
	const BUILTIN = {
		code_intel:
			"Operations: definition, references. Address by path. Output: file:line:column lines.",
	};

	it("rejects a bare marker for a tool that has to be rewritten", () => {
		// Measured: a 31B model handed the cheap option took it twenty-four
		// times out of thirty-one. For the tools it actually misuses, the cheap
		// option produces the default with a preamble.
		const [problem] = auditToolSectionContent(
			{ code_intel: "{{DEFAULT}}" },
			SIGNATURES,
			BUILTIN,
			["code_intel"],
		);

		expect(problem).toContain("is nothing but '{{DEFAULT}}'");
	});

	it("judges a required rewrite on its own words, not the inherited ones", () => {
		// Two lines plus the marker reads as a rewrite and is not one: the
		// contract arrives from the built-in text, so the model was never made
		// to think about it.
		const problems = auditToolSectionContent(
			{ code_intel: "Use this instead of grep for symbols.\n{{DEFAULT}}" },
			SIGNATURES,
			BUILTIN,
			["code_intel"],
		);

		expect(problems.length).toBeGreaterThan(0);
	});

	it("accepts a required rewrite that carries the contract itself", () => {
		const body = [
			"Ask the language server about a symbol instead of grepping for it.",
			"Operations: definition, references.",
			"Address it with path plus the symbol name.",
			"Output: one result per line as file:line:column with the source line.",
			"{{DEFAULT}}",
		].join("\n");

		expect(
			auditToolSectionContent({ code_intel: body }, SIGNATURES, BUILTIN, [
				"code_intel",
			]),
		).toEqual([]);
	});

	it("still lets an unlisted tool inherit everything", () => {
		expect(
			auditToolSectionContent(
				{ code_intel: "{{DEFAULT}}" },
				SIGNATURES,
				BUILTIN,
				[],
			),
		).toEqual([]);
	});
});
