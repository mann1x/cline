import { describe, expect, it } from "vitest";
import {
	applyPromptTemplateToTools,
	matchesPromptPattern,
	type PromptTemplate,
	patternSpecificity,
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

describe("pattern specificity", () => {
	// The shape this exists for: a generic family template as the fallback, and
	// a narrower one per generation above it. Without pattern specificity both
	// score `family` and the winner is array order.
	const kimi = template({
		name: "kimi",
		match: { family: ["kimi*"] },
		system: "generic",
	});
	const k3 = template({
		name: "kimi-k3",
		match: { family: ["kimi-k3*"] },
		system: "k3",
	});
	const at = (family: string) => ({
		providerId: "ollama",
		modelId: `x:${family}`,
		family,
	});

	it("prefers the narrower family pattern in either order", () => {
		expect(resolvePromptTemplate([kimi, k3], at("kimi-k3"))?.system).toBe("k3");
		expect(resolvePromptTemplate([k3, kimi], at("kimi-k3"))?.system).toBe("k3");
	});

	// The whole reason for keeping the generic one: a generation nobody has
	// written a template for yet lands on the family's template rather than
	// falling silently to the base layer, which is what hit `glm5*` and
	// `deepseek4*`.
	it("falls back to the generic pattern for a generation with no template", () => {
		expect(resolvePromptTemplate([kimi, k3], at("kimi-k2"))?.system).toBe(
			"generic",
		);
		expect(resolvePromptTemplate([kimi, k3], at("kimi-k4"))?.system).toBe(
			"generic",
		);
	});

	it("ranks an exact pattern above a wildcard that matches the same value", () => {
		const exact = template({
			name: "e",
			match: { family: ["kimi-k3"] },
			system: "exact",
		});
		expect(resolvePromptTemplate([k3, exact], at("kimi-k3"))?.system).toBe(
			"exact",
		);
		expect(resolvePromptTemplate([exact, k3], at("kimi-k3"))?.system).toBe(
			"exact",
		);
	});

	// A dimension still outranks narrowness inside a lesser one: `model` is 3,
	// `family` is 2, and no amount of literal text in a family pattern crosses
	// that.
	it("never lets a narrow family pattern beat a model match", () => {
		const byModel = template({
			name: "m",
			match: { model: ["*x*"] },
			system: "model",
		});
		const longFamily = template({
			name: "f",
			match: { family: ["kimi-k3-something-very-long*"] },
			system: "family",
		});
		const target = {
			providerId: "ollama",
			modelId: "x:kimi-k3-something-very-long",
			family: "kimi-k3-something-very-long",
		};
		expect(resolvePromptTemplate([longFamily, byModel], target)?.system).toBe(
			"model",
		);
	});

	it("ignores exclusions when measuring narrowness", () => {
		// `!*moe*` is 5 literal characters and must not make this the winner.
		const excluding = template({
			name: "x",
			match: { family: ["kimi*", "!*moe*"] },
			system: "excluding",
		});
		expect(resolvePromptTemplate([excluding, k3], at("kimi-k3"))?.system).toBe(
			"k3",
		);
	});

	it("scores nothing for a value no pattern claims", () => {
		expect(patternSpecificity("gemma4", ["kimi*"])).toBe(0);
		expect(patternSpecificity(undefined, ["kimi*"])).toBe(0);
		expect(patternSpecificity("kimi-k3", undefined)).toBe(0);
	});
});

describe("match exclusions", () => {
	// The regression this exists for. Scoring used to be per dimension only, so
	// `qwen*` and `qwen*moe*` both scored `family` and the tie fell through
	// SOURCE_RANK to array order: measured, the same session resolved to `qwen`
	// with one ordering and `qwen-moe` with the other. Pattern specificity
	// decides it now; the exclusion remains the way to say "not claimed at
	// all", which specificity cannot express.
	const qwenAll = template({
		name: "qwen",
		match: { family: ["qwen*"] },
		system: "qwen",
	});
	const qwenNotMoe = template({
		name: "qwen",
		match: { family: ["qwen*", "!*moe*"] },
		system: "qwen",
	});
	const moe = template({
		name: "qwen-moe",
		match: { family: ["qwen*moe*"] },
		system: "moe",
	});
	const a3b = {
		providerId: "ollama",
		modelId: "ornith15-base-rp_tb:35b-high",
		family: "qwen35moe",
	};
	const dense = {
		providerId: "ollama",
		modelId: "qwen36-base-mtp_tb:27b-q4km-128k",
		family: "qwen35",
	};

	// Was "is order-dependent without an exclusion", and asserted the defect:
	// `[qwenAll, moe]` gave `qwen` and the reverse gave `moe`. The narrower
	// pattern wins on its own now, so an exclusion is no longer needed merely
	// to make routing deterministic.
	it("prefers the narrower pattern whatever the order, with no exclusion", () => {
		expect(resolvePromptTemplate([qwenAll, moe], a3b)?.system).toBe("moe");
		expect(resolvePromptTemplate([moe, qwenAll], a3b)?.system).toBe("moe");
	});

	// ...and the generic template still claims everything the narrow one does
	// not, which is the point of keeping it.
	it("falls back to the generic pattern for the rest of the family", () => {
		expect(resolvePromptTemplate([qwenAll, moe], dense)?.system).toBe("qwen");
	});

	it("routes the same session the same way whatever the order", () => {
		expect(resolvePromptTemplate([qwenNotMoe, moe], a3b)?.system).toBe("moe");
		expect(resolvePromptTemplate([moe, qwenNotMoe], a3b)?.system).toBe("moe");
	});

	it("leaves the family's other architectures alone", () => {
		expect(resolvePromptTemplate([qwenNotMoe, moe], dense)?.system).toBe(
			"qwen",
		);
	});

	it("excludes regardless of where in the list the exclusion sits", () => {
		const first = template({
			name: "qwen",
			match: { family: ["!*moe*", "qwen*"] },
			system: "qwen",
		});
		expect(scorePromptTemplate(first, a3b)).toBeUndefined();
	});

	// An exclusion is not an inclusion: a family the list never names is still
	// not claimed by it.
	it("does not claim an unrelated family it merely failed to exclude", () => {
		expect(
			scorePromptTemplate(qwenNotMoe, {
				providerId: "ollama",
				modelId: "v7-coder_tb:Q4_K_M",
				family: "gemma4",
			}),
		).toBeUndefined();
	});

	it("matches everything it does not name when given only exclusions", () => {
		const allButMoe = template({
			name: "catch-all",
			match: { family: ["!*moe*"] },
			system: "catch-all",
		});
		expect(scorePromptTemplate(allButMoe, dense)).toBe(2);
		expect(scorePromptTemplate(allButMoe, a3b)).toBeUndefined();
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

	/**
	 * The host's own name, in a tool description.
	 *
	 * The word being replaced is "IDE": the shipped descriptions said "the
	 * IDE's language servers" and "the IDE's Problems panel" to a model running
	 * in a terminal, where there is neither. A template that wants to name the
	 * host now can, and gets the same string the system prompt's `IDE:` line
	 * shows.
	 */
	describe("{{IDE_NAME}}", () => {
		it("resolves to the host the caller named", () => {
			const result = applyPromptTemplateToTools(
				tools,
				template({
					name: "g",
					tools: { editor: "Edit files in {{IDE_NAME}}." },
				}),
				{ ideName: "Terminal Shell" },
			);

			expect(result[0]?.description).toBe("Edit files in Terminal Shell.");
		});

		it("resolves in a description no template touched", () => {
			// A host builds its own tools and can write the token into one of
			// them. Resolving it only in template sections would make the same
			// token mean two different things depending on where it was written.
			const result = applyPromptTemplateToTools(
				[{ name: "check_file", description: "Ask {{IDE_NAME}}." }],
				template({ name: "g", tools: { editor: "unrelated" } }),
				{ ideName: "VS Code" },
			);

			expect(result[0]?.description).toBe("Ask VS Code.");
		});

		it("resolves every occurrence, not just the first", () => {
			const result = applyPromptTemplateToTools(
				tools,
				template({
					name: "g",
					tools: { editor: "{{IDE_NAME}} and {{IDE_NAME}}" },
				}),
				{ ideName: "VS Code" },
			);

			expect(result[0]?.description).toBe("VS Code and VS Code");
		});

		it("resolves inside text the marker expanded", () => {
			const result = applyPromptTemplateToTools(
				[{ name: "editor", description: "built in {{IDE_NAME}}" }],
				template({ name: "g", tools: { editor: "Wrapped. {{DEFAULT}}" } }),
				{ ideName: "VS Code" },
			);

			expect(result[0]?.description).toBe("Wrapped. built in VS Code");
		});

		// Never left as braces in front of the model: a host that says nothing
		// gets wording that is vague rather than wording that is broken.
		it("falls back to a generic name when the host does not say", () => {
			const section = template({
				name: "g",
				tools: { editor: "Ask {{IDE_NAME}}." },
			});

			expect(applyPromptTemplateToTools(tools, section)[0]?.description).toBe(
				"Ask the editor.",
			);
			expect(
				applyPromptTemplateToTools(tools, section, { ideName: "  " })[0]
					?.description,
			).toBe("Ask the editor.");
		});

		it("leaves a description that does not use it identical", () => {
			const result = applyPromptTemplateToTools(tools, undefined, {
				ideName: "VS Code",
			});

			expect(result).toEqual(tools);
			expect(result[0]).toBe(tools[0]);
		});
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
	const tools = [
		{
			name: "team_finalize_outcome",
			description: "Finalize one outcome. Output: {outcomeId, status}.",
		},
	];

	it("keeps the built-in text when a section is empty", () => {
		const [applied] = applyPromptTemplateToTools(tools, {
			tools: { team_finalize_outcome: "" },
		});

		expect(applied?.description).toBe(tools[0]?.description);
	});

	it("keeps the built-in text when a section is only whitespace", () => {
		const [applied] = applyPromptTemplateToTools(tools, {
			tools: { team_finalize_outcome: "  \n\t " },
		});

		expect(applied?.description).toBe(tools[0]?.description);
	});

	it("keeps the built-in text when a section is only the marker", () => {
		const [applied] = applyPromptTemplateToTools(tools, {
			tools: { team_finalize_outcome: "{{DEFAULT}}" },
		});

		expect(applied?.description).toBe(tools[0]?.description);
	});

	it("still lets a real replacement replace", () => {
		const [applied] = applyPromptTemplateToTools(tools, {
			tools: { team_finalize_outcome: "Close it out." },
		});

		expect(applied?.description).toBe("Close it out.");
	});
});
