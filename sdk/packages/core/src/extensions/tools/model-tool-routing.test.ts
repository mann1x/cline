import { describe, expect, it } from "vitest";
import {
	DEFAULT_MODEL_TOOL_ROUTING_RULES,
	resolveToolRoutingConfig,
} from "./model-tool-routing";

describe("model tool routing", () => {
	it("applies default codex/gpt routing in act mode", () => {
		const config = resolveToolRoutingConfig(
			"openai",
			"openai/gpt-5.4",
			"act",
			DEFAULT_MODEL_TOOL_ROUTING_RULES,
		);

		expect(config.enableApplyPatch).toBe(true);
		expect(config.enableEditor).toBe(false);
	});

	it("does not apply default codex/gpt routing in plan mode", () => {
		const config = resolveToolRoutingConfig(
			"openai",
			"openai/gpt-5.4",
			"plan",
			DEFAULT_MODEL_TOOL_ROUTING_RULES,
		);

		expect(config).toEqual({});
	});

	it("applies matching custom rules in order", () => {
		const config = resolveToolRoutingConfig(
			"anthropic",
			"claude-sonnet-4-6",
			"act",
			[
				{
					name: "claude-editor-off",
					mode: "act",
					modelIdIncludes: ["claude"],
					disableTools: ["editor"],
				},
				{
					name: "claude-apply-patch-on",
					mode: "act",
					modelIdIncludes: ["claude"],
					enableTools: ["apply_patch"],
				},
			],
		);

		expect(config.enableEditor).toBe(false);
		expect(config.enableApplyPatch).toBe(true);
	});

	it("returns empty config when no rules match", () => {
		const config = resolveToolRoutingConfig(
			"anthropic",
			"claude-sonnet-4-6",
			"act",
			[
				{
					mode: "act",
					modelIdIncludes: ["gpt"],
					enableTools: ["apply_patch"],
				},
			],
		);

		expect(config).toEqual({});
	});

	it("can match provider-only rules", () => {
		const config = resolveToolRoutingConfig("openai", "o4-mini", "act", [
			{
				mode: "act",
				providerIdIncludes: ["openai"],
				enableTools: ["apply_patch"],
				disableTools: ["editor"],
			},
		]);

		expect(config.enableApplyPatch).toBe(true);
		expect(config.enableEditor).toBe(false);
	});

	// automaticum audit 2026-11-08, rest M9: "gpt" anywhere matched.
	it("leaves the editor to models that only contain the letters gpt", () => {
		for (const id of [
			"Qwen2.5-Coder-32B-Instruct-GPTQ-Int4",
			"gpt-oss-20b",
			"openai/gpt-oss-120b",
			"my-gptx",
		]) {
			expect(
				resolveToolRoutingConfig(
					"openai-compatible",
					id,
					"act",
					DEFAULT_MODEL_TOOL_ROUTING_RULES,
				),
			).toEqual({});
		}
		for (const id of [
			"gpt-4o",
			"gpt-5",
			"openai/gpt-4.1-mini",
			"codex-mini-latest",
		]) {
			expect(
				resolveToolRoutingConfig(
					"openai-compatible",
					id,
					"act",
					DEFAULT_MODEL_TOOL_ROUTING_RULES,
				),
			).toMatchObject({ enableEditor: false, enableApplyPatch: true });
		}
	});

	it("matches nothing with a pattern that does not compile", () => {
		expect(
			resolveToolRoutingConfig("x", "anything", "act", [
				{ modelIdPattern: "(", disableTools: ["editor"] },
			]),
		).toEqual({});
	});
});
