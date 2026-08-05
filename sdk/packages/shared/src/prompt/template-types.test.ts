import { describe, expect, it } from "vitest";
import {
	applyPromptTemplateToTools,
	matchesPromptPattern,
	type PromptTemplate,
	renderPromptTemplate,
	resolvePromptTemplate,
	scorePromptTemplate,
	shadowPromptTemplates,
} from "./template-types";

const template = (
	partial: Partial<PromptTemplate> & { name: string },
): PromptTemplate => ({
	source: "global",
	tools: {},
	...partial,
});

describe("matchesPromptPattern", () => {
	it("matches a literal case-insensitively", () => {
		expect(matchesPromptPattern("GEMMA4", "gemma4")).toBe(true);
		expect(matchesPromptPattern("gemma3", "gemma4")).toBe(false);
	});

	it("treats * as the only metacharacter", () => {
		expect(matchesPromptPattern("qwen35moe", "qwen*")).toBe(true);
		expect(matchesPromptPattern("qwen3vl", "qwen*")).toBe(true);
		expect(matchesPromptPattern("gemma4", "qwen*")).toBe(false);
		expect(matchesPromptPattern("v7-coder_tb:Q4_K_M", "*v7-coder*")).toBe(true);
	});

	it("does not let a pattern's punctuation act as a regex", () => {
		// A dot is a literal here; otherwise `qwen3.5` would match `qwen345`.
		expect(matchesPromptPattern("qwen345", "qwen3.5")).toBe(false);
		expect(matchesPromptPattern("qwen3.5", "qwen3.5")).toBe(true);
	});

	it("never matches on an empty pattern", () => {
		expect(matchesPromptPattern("gemma4", "")).toBe(false);
	});
});

describe("scorePromptTemplate", () => {
	const target = {
		providerId: "ollama",
		modelId: "v7-coder_tb:Q4_K_M",
		family: "gemma4",
	};

	it("scores an unconstrained template as the default", () => {
		expect(scorePromptTemplate(template({ name: "default" }), target)).toBe(0);
	});

	it("scores provider, family and model by specificity", () => {
		expect(
			scorePromptTemplate(
				template({ name: "a", match: { provider: ["ollama"] } }),
				target,
			),
		).toBe(1);
		expect(
			scorePromptTemplate(
				template({ name: "b", match: { family: ["gemma*"] } }),
				target,
			),
		).toBe(2);
		expect(
			scorePromptTemplate(
				template({ name: "c", match: { model: ["*v7-coder*"] } }),
				target,
			),
		).toBe(3);
	});

	it("requires every named dimension to match", () => {
		// Right family, wrong provider: the template does not apply at all.
		expect(
			scorePromptTemplate(
				template({
					name: "d",
					match: { provider: ["anthropic"], family: ["gemma4"] },
				}),
				target,
			),
		).toBeUndefined();
	});

	it("does not match a constrained dimension the target cannot report", () => {
		expect(
			scorePromptTemplate(
				template({ name: "e", match: { family: ["gemma4"] } }),
				{
					providerId: "openai",
					modelId: "gpt-5.5",
				},
			),
		).toBeUndefined();
	});

	it("treats an empty match block as the default rather than a mismatch", () => {
		expect(
			scorePromptTemplate(template({ name: "f", match: {} }), target),
		).toBe(0);
	});
});

describe("shadowPromptTemplates", () => {
	it("lets a workspace template replace the global one of the same name", () => {
		const result = shadowPromptTemplates([
			template({ name: "gemma", source: "global", system: "global text" }),
			template({
				name: "gemma",
				source: "workspace",
				system: "workspace text",
			}),
		]);

		expect(result).toHaveLength(1);
		expect(result[0]?.system).toBe("workspace text");
	});

	it("replaces wholesale rather than merging", () => {
		const result = shadowPromptTemplates([
			template({
				name: "gemma",
				source: "global",
				system: "global text",
				tools: { editor: "global editor" },
			}),
			template({ name: "gemma", source: "workspace", tools: { skills: "ws" } }),
		]);

		// The workspace file said nothing about the system prompt, and it does not
		// quietly inherit one it never showed its author.
		expect(result[0]?.system).toBeUndefined();
		expect(result[0]?.tools).toEqual({ skills: "ws" });
	});

	it("matches names case-insensitively and ignores surrounding space", () => {
		const result = shadowPromptTemplates([
			template({ name: "Gemma", source: "global" }),
			template({ name: " gemma ", source: "workspace", system: "ws" }),
		]);

		expect(result).toHaveLength(1);
		expect(result[0]?.system).toBe("ws");
	});
});

describe("resolvePromptTemplate", () => {
	const templates = [
		template({ name: "default", source: "builtin", system: "default" }),
		template({
			name: "ollama",
			match: { provider: ["ollama"] },
			system: "provider",
		}),
		template({ name: "qwen", match: { family: ["qwen*"] }, system: "qwen" }),
		template({ name: "gemma", match: { family: ["gemma*"] }, system: "gemma" }),
	];

	it("prefers the family template over the provider one", () => {
		expect(
			resolvePromptTemplate(templates, {
				providerId: "ollama",
				modelId: "v7-coder_tb:Q4_K_M",
				family: "gemma4",
			})?.system,
		).toBe("gemma");
	});

	it("routes an architecture string to the family that owns it", () => {
		// The whole point of pattern matching: `qwen35moe` is a Qwen, and nothing
		// in the model's name says so.
		expect(
			resolvePromptTemplate(templates, {
				providerId: "ollama",
				modelId: "mannix/qwen3.6-27b-a3b-coder:Q4_K_M",
				family: "qwen35moe",
			})?.system,
		).toBe("qwen");
	});

	it("falls back to the provider template for an unknown family", () => {
		expect(
			resolvePromptTemplate(templates, {
				providerId: "ollama",
				modelId: "gpt-oss:latest",
				family: "gptoss",
			})?.system,
		).toBe("provider");
	});

	it("falls back to the default when nothing else claims the session", () => {
		expect(
			resolvePromptTemplate(templates, {
				providerId: "anthropic",
				modelId: "claude-sonnet-5",
			})?.system,
		).toBe("default");
	});

	it("lets a per-model override beat its own family template", () => {
		const withOverride = [
			...templates,
			template({
				name: "v7",
				match: { model: ["*v7-coder*"] },
				system: "override",
			}),
		];

		expect(
			resolvePromptTemplate(withOverride, {
				providerId: "ollama",
				modelId: "v7-coder_tb:Q4_K_M",
				family: "gemma4",
			})?.system,
		).toBe("override");
	});

	it("breaks a specificity tie in favour of the nearer source", () => {
		const tied = [
			template({
				name: "a",
				source: "global",
				match: { family: ["gemma*"] },
				system: "g",
			}),
			template({
				name: "b",
				source: "workspace",
				match: { family: ["gemma*"] },
				system: "w",
			}),
		];

		expect(
			resolvePromptTemplate(tied, {
				providerId: "ollama",
				modelId: "x",
				family: "gemma4",
			})?.system,
		).toBe("w");
	});

	it("returns undefined when no template applies", () => {
		expect(
			resolvePromptTemplate([templates[2] as PromptTemplate], {
				providerId: "anthropic",
				modelId: "claude-sonnet-5",
			}),
		).toBeUndefined();
	});
});

describe("applyPromptTemplateToTools", () => {
	const tools = [
		{ name: "editor", description: "original editor" },
		{ name: "run_commands", description: "original shell" },
	];

	it("replaces only the tools the template names", () => {
		const result = applyPromptTemplateToTools(
			tools,
			template({ name: "gemma", tools: { editor: "rewritten" } }),
		);

		expect(result[0]?.description).toBe("rewritten");
		expect(result[1]?.description).toBe("original shell");
	});

	it("leaves every other field on the tool alone", () => {
		const withSchema = [
			{ name: "editor", description: "d", inputSchema: { a: 1 } },
		];
		const result = applyPromptTemplateToTools(
			withSchema,
			template({ name: "g", tools: { editor: "rewritten" } }),
		);

		expect(result[0]?.inputSchema).toEqual({ a: 1 });
	});

	it("is a no-op for a template with no tool sections", () => {
		expect(applyPromptTemplateToTools(tools, template({ name: "g" }))).toEqual(
			tools,
		);
		expect(applyPromptTemplateToTools(tools, undefined)).toEqual(tools);
	});

	it("expands {{DEFAULT}} to the description the tool was built with", () => {
		const result = applyPromptTemplateToTools(
			tools,
			template({
				name: "g",
				tools: { run_commands: "Commands only.\n\n{{DEFAULT}}" },
			}),
		);

		expect(result[1]?.description).toBe("Commands only.\n\noriginal shell");
	});

	it("does not re-read a computed description once per marker", () => {
		// `skills` exposes `description` as a getter that walks the installed
		// skills. Copying the tool reads it once; expanding the marker must not
		// turn each occurrence into another walk.
		const countReads = (replacement: string) => {
			let reads = 0;
			const skills = {
				name: "skills",
				get description() {
					reads++;
					return "base.";
				},
			};
			applyPromptTemplateToTools(
				[skills],
				template({ name: "g", tools: { skills: replacement } }),
			);
			return reads;
		};

		expect(countReads("{{DEFAULT}} x5")).toBe(
			countReads("{{DEFAULT}}{{DEFAULT}}{{DEFAULT}}{{DEFAULT}}{{DEFAULT}}"),
		);
	});

	it("keeps a computed description's live text when wrapping it", () => {
		const skills = {
			name: "skills",
			get description() {
				return "base. Available skills: pdf.";
			},
		};

		const result = applyPromptTemplateToTools(
			[skills],
			template({ name: "g", tools: { skills: "{{DEFAULT}} Prefer these." } }),
		);

		expect(result[0]?.description).toBe(
			"base. Available skills: pdf. Prefer these.",
		);
	});

	it("expands every occurrence of the marker", () => {
		const result = applyPromptTemplateToTools(
			[{ name: "editor", description: "X" }],
			template({ name: "g", tools: { editor: "{{DEFAULT}} and {{DEFAULT}}" } }),
		);

		expect(result[0]?.description).toBe("X and X");
	});

	it("ignores a section naming a tool that is not on this request", () => {
		const result = applyPromptTemplateToTools(
			tools,
			template({ name: "g", tools: { apply_patch: "not enabled here" } }),
		);

		expect(result).toEqual(tools);
	});
});

describe("renderPromptTemplate", () => {
	const DEFAULT = template({
		name: "default",
		source: "builtin",
		system: "default system",
		tools: {
			editor: "default editor",
			read_files: "default read",
			run_commands: "{{DEFAULT}}",
		},
	});

	const GEMMA = template({
		name: "gemma",
		source: "builtin",
		match: { family: ["gemma*"] },
		system: "gemma system",
		tools: { editor: "gemma editor" },
	});

	const GEMMA_TARGET = {
		providerId: "ollama",
		modelId: "v7-coder",
		family: "gemma4",
	};

	it("falls back to default.md for every tool the template does not name", () => {
		// The correction that matters: an unnamed tool reads what default.md
		// says, not what the code says, so editing default.md reaches every
		// session rather than only the unmatched ones.
		const rendered = renderPromptTemplate([DEFAULT, GEMMA], GEMMA_TARGET);

		expect(rendered?.tools).toEqual({
			editor: "gemma editor",
			read_files: "default read",
			run_commands: "{{DEFAULT}}",
		});
	});

	it("falls back to default.md for a template with no system section", () => {
		const toolsOnly = template({
			name: "tools-only",
			match: { family: ["gemma*"] },
			tools: { editor: "just this" },
		});

		const rendered = renderPromptTemplate([DEFAULT, toolsOnly], GEMMA_TARGET);

		expect(rendered?.system).toBe("default system");
		expect(rendered?.tools.editor).toBe("just this");
	});

	it("reports which template won, not the default it layered over", () => {
		const rendered = renderPromptTemplate([DEFAULT, GEMMA], GEMMA_TARGET);

		expect(rendered?.name).toBe("gemma");
		expect(rendered?.overlaid).toBe(true);
	});

	it("returns the default alone when nothing else matches", () => {
		const rendered = renderPromptTemplate([DEFAULT, GEMMA], {
			providerId: "anthropic",
			modelId: "claude-opus-5",
		});

		expect(rendered?.name).toBe("default");
		expect(rendered?.overlaid).toBe(false);
		expect(rendered?.tools).toEqual(DEFAULT.tools);
	});

	it("does not expand {{DEFAULT}} — that needs the live tool", () => {
		const rendered = renderPromptTemplate([DEFAULT, GEMMA], GEMMA_TARGET);

		expect(rendered?.tools.run_commands).toBe("{{DEFAULT}}");
	});

	it("lets a user's default.md replace the shipped one as the base", () => {
		const mine = template({
			name: "default",
			source: "global",
			system: "mine",
			tools: { editor: "my editor", read_files: "my read" },
		});

		const rendered = renderPromptTemplate([DEFAULT, mine, GEMMA], GEMMA_TARGET);

		expect(rendered?.tools).toEqual({
			editor: "gemma editor",
			read_files: "my read",
		});
	});

	it("still renders when there is no default at all", () => {
		const rendered = renderPromptTemplate([GEMMA], GEMMA_TARGET);

		expect(rendered?.overlaid).toBe(false);
		expect(rendered?.tools).toEqual({ editor: "gemma editor" });
	});

	it("returns nothing when there are no templates at all", () => {
		// A fresh install with an empty directory keeps whatever the code built.
		expect(renderPromptTemplate([], GEMMA_TARGET)).toBeUndefined();
	});

	it("carries the winning template's path for the settings UI", () => {
		const withPath = template({
			name: "gemma",
			source: "workspace",
			filePath: "/repo/.clinerules/templates/gemma.md",
			match: { family: ["gemma*"] },
			tools: { editor: "x" },
		});

		const rendered = renderPromptTemplate([DEFAULT, withPath], GEMMA_TARGET);

		expect(rendered?.filePath).toBe("/repo/.clinerules/templates/gemma.md");
		expect(rendered?.source).toBe("workspace");
	});
});

/**
 * A template can only ever make a tool's description better or leave it alone.
 *
 * Every other guard in this system runs at generation time, and a template can
 * arrive without ever passing through one: hand-written, hand-edited, or
 * dropped into `.clinerules/templates` by someone who read half the format.
 * This is the last layer, and the only one a session actually depends on.
 */
describe("applyPromptTemplateToTools never blanks a description", () => {
	const tools = [{ name: "team_finalize_outcome", description: "Finalize one outcome. Output: {outcomeId, status}." }]

	it("keeps the built-in text when a section is empty", () => {
		const [applied] = applyPromptTemplateToTools(tools, { tools: { team_finalize_outcome: "" } })

		expect(applied?.description).toBe(tools[0]?.description)
	})

	it("keeps the built-in text when a section is only whitespace", () => {
		const [applied] = applyPromptTemplateToTools(tools, { tools: { team_finalize_outcome: "  \n\t " } })

		expect(applied?.description).toBe(tools[0]?.description)
	})

	it("keeps the built-in text when a section is only the marker", () => {
		const [applied] = applyPromptTemplateToTools(tools, { tools: { team_finalize_outcome: "{{DEFAULT}}" } })

		expect(applied?.description).toBe(tools[0]?.description)
	})

	it("still lets a real replacement replace", () => {
		const [applied] = applyPromptTemplateToTools(tools, { tools: { team_finalize_outcome: "Close it out." } })

		expect(applied?.description).toBe("Close it out.")
	})
})
