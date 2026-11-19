import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setPromptTemplateEnabledGlobally } from "../../services/global-settings";
import {
	describeResolvedPromptTemplate,
	resolveSessionPromptTemplate,
	resolveSessionPromptTemplateFrom,
} from "./prompt-template-session";

// The plugin asked Ollama for the family; an SDK host had no way to.
describe("resolveSessionPromptTemplate", () => {
	const show = (family: string) =>
		(async (url: string) =>
			String(url).endsWith("/show")
				? new Response(JSON.stringify({ details: { family } }))
				: new Response("{}", { status: 404 })) as unknown as typeof fetch;

	it("asks xOllama what a local model is, and picks its family's template", async () => {
		const { rendered, family } = await resolveSessionPromptTemplate({
			providerId: "xollama",
			modelId: "a3b-coder_tb:Q4_K_M",
			baseUrl: "http://family-lookup.test:22434",
			fetch: show("qwen35moe"),
		});
		expect(family).toBe("qwen35moe");
		expect(rendered?.name).toBe("qwen");
	});

	it("does not ask a provider whose model ids already say", async () => {
		let asked = false;
		const { family } = await resolveSessionPromptTemplate({
			providerId: "opencoti",
			modelId: "gemma-4",
			baseUrl: "http://no-lookup.test:8261",
			fetch: (async () => {
				asked = true;
				return new Response("{}");
			}) as unknown as typeof fetch,
		});
		expect(asked).toBe(false);
		expect(family).toBeUndefined();
	});
});

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
		).toBe("[PromptTemplates] some-model → none; the built-in prompt applies");
	});
});

// A template the user switched off is taken out before anything is matched,
// in every host, because the switch is a global setting core reads itself.
describe("resolveSessionPromptTemplateFrom: templates switched off", () => {
	const previousGlobalSettingsPath = process.env.CLINE_GLOBAL_SETTINGS_PATH;
	afterEach(() => {
		process.env.CLINE_GLOBAL_SETTINGS_PATH = previousGlobalSettingsPath;
	});

	it("drops a switched-off family template, and its models land on default", () => {
		const { rendered } = resolveSessionPromptTemplateFrom({
			providerId: "ollama",
			modelId: "a3b-coder_tb:Q4_K_M",
			family: "qwen35moe",
			disabledTemplateNames: [" Qwen "],
		});
		expect(rendered?.name).toBe("default");
		expect(rendered?.overlaid).toBe(false);
	});

	it("never drops default, even when asked to", () => {
		const { rendered } = resolveSessionPromptTemplateFrom({
			providerId: "ollama",
			modelId: "a3b-coder_tb:Q4_K_M",
			family: "qwen35moe",
			disabledTemplateNames: ["qwen", "default"],
		});
		expect(rendered?.name).toBe("default");
	});

	it("drops a user's copy along with the builtin of the same name", async () => {
		const root = await mkdtemp(join(tmpdir(), "core-template-off-"));
		try {
			const globalDir = join(root, "templates");
			mkdirSync(globalDir, { recursive: true });
			writeFileSync(
				join(globalDir, "qwen.md"),
				"---\nname: qwen\nmatch:\n  family: qwen*\n---\n# system\nmine\n",
			);
			const on = resolveSessionPromptTemplateFrom({
				providerId: "ollama",
				modelId: "m",
				family: "qwen35moe",
				globalDir,
				disabledTemplateNames: [],
			});
			expect(on.rendered?.source).toBe("global");
			const off = resolveSessionPromptTemplateFrom({
				providerId: "ollama",
				modelId: "m",
				family: "qwen35moe",
				globalDir,
				disabledTemplateNames: ["qwen"],
			});
			expect(off.rendered?.name).toBe("default");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("reads the global setting when the caller names none", async () => {
		const root = await mkdtemp(join(tmpdir(), "core-template-off-"));
		try {
			process.env.CLINE_GLOBAL_SETTINGS_PATH = join(
				root,
				"global-settings.json",
			);
			setPromptTemplateEnabledGlobally("qwen", false);
			expect(
				resolveSessionPromptTemplateFrom({
					providerId: "ollama",
					modelId: "m",
					family: "qwen35moe",
				}).rendered?.name,
			).toBe("default");
			setPromptTemplateEnabledGlobally("qwen", true);
			expect(
				resolveSessionPromptTemplateFrom({
					providerId: "ollama",
					modelId: "m",
					family: "qwen35moe",
				}).rendered?.name,
			).toBe("qwen");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
