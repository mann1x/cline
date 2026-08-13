import { describe, expect, it } from "vitest";
import {
	describeResolvedPromptTemplate,
	resolveSessionPromptTemplateFrom,
} from "./prompt-template-session";

/**
 * The resolver both hosts now share.
 *
 * These cases are the ones the CLI failed silently: a qwen-family model landing
 * on `default.md` rather than `qwen.md` is not a cosmetic difference — `qwen.md`
 * is the file that says "use `editor`, never `sed -i`, never `cat`", and a run
 * without it spent 119 of one transaction's tool calls shelling out to rewrite
 * a file the `editor` tool exists to edit.
 */
describe("resolveSessionPromptTemplateFrom", () => {
	it("gives a qwen-family model the qwen template", () => {
		const { rendered } = resolveSessionPromptTemplateFrom({
			providerId: "ollama",
			// A local name that says nothing about the architecture, which is the
			// whole reason the family is looked up rather than parsed out.
			modelId: "a3b-coder_tb:Q4_K_M",
			family: "qwen35moe",
		});
		expect(rendered?.name).toBe("qwen");
		expect(rendered?.overlaid).toBe(true);
	});

	it("gives a gemma-family model the gemma template", () => {
		const { rendered } = resolveSessionPromptTemplateFrom({
			providerId: "ollama",
			modelId: "v7-coder_tb:Q4_K_M",
			family: "gemma4",
		});
		expect(rendered?.name).toBe("gemma");
	});

	// Without a family a local model matches nothing, which is exactly the state
	// the CLI was permanently in: every one of them fell through to the default.
	it("falls back to the default when no family is known", () => {
		const { rendered } = resolveSessionPromptTemplateFrom({
			providerId: "ollama",
			modelId: "a3b-coder_tb:Q4_K_M",
		});
		expect(rendered?.name).toBe("default");
		expect(rendered?.overlaid).toBe(false);
	});

	it("carries the tool descriptions, not just the system section", () => {
		const { rendered } = resolveSessionPromptTemplateFrom({
			providerId: "ollama",
			modelId: "a3b-coder_tb:Q4_K_M",
			family: "qwen35moe",
		});
		expect(rendered?.system).toBeTruthy();
		expect(rendered?.tools.editor).toBeTruthy();
	});

	// Model name rather than family, for a provider that can already be told
	// apart by its ids.
	it("matches a hosted model on its name", () => {
		const { rendered } = resolveSessionPromptTemplateFrom({
			providerId: "anthropic",
			modelId: "claude-opus-4-20250514",
		});
		expect(rendered?.name).toBe("claude");
	});
});

describe("describeResolvedPromptTemplate", () => {
	it("names the template, the model and the family", () => {
		const { rendered } = resolveSessionPromptTemplateFrom({
			providerId: "ollama",
			modelId: "a3b-coder_tb:Q4_K_M",
			family: "qwen35moe",
		});
		expect(
			describeResolvedPromptTemplate(
				{ modelId: "a3b-coder_tb:Q4_K_M", family: "qwen35moe" },
				rendered,
			),
		).toBe(
			"[PromptTemplates] a3b-coder_tb:Q4_K_M (qwen35moe) → qwen over default",
		);
	});

	// Said out loud rather than left silent: a host resolving no template at all
	// is how this went unnoticed for as long as it did.
	it("says so when nothing was resolved", () => {
		expect(
			describeResolvedPromptTemplate({ modelId: "some-model" }, undefined),
		).toBe(
			"[PromptTemplates] some-model → none; the built-in prompt applies",
		);
	});
});
