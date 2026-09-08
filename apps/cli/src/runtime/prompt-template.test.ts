import { primeDeclaredNumCtx } from "@cline/core";
import { describe, expect, it, vi } from "vitest";
import { resolveCliPromptTemplate } from "./prompt-template";

/**
 * The CLI half of the host gap.
 *
 * The extension has resolved a prompt template per session since templates
 * existed; this host resolved none, so the same local model read `qwen.md` in
 * the plugin and the built-in prompt here. Nothing reported the difference from
 * either side, which is why it survived a whole measurement campaign.
 */
const LOCAL = "http://localhost:11434";

/** `/api/show` as Ollama answers it, carrying the window and the family. */
function showFetch(family: string | undefined): typeof fetch {
	return vi.fn(async () => {
		return {
			ok: true,
			json: async () => ({
				parameters: "num_ctx                        262144",
				...(family ? { details: { family } } : {}),
			}),
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

describe("resolveCliPromptTemplate", () => {
	// Each case primes a fresh model id, so the family cache -- which is process
	// wide and deliberately outlives a session -- cannot leak between them.
	it("gives a qwen-family ollama model the qwen template", async () => {
		const modelId = `a3b-coder_tb:${Math.random()}`;
		await primeDeclaredNumCtx(LOCAL, modelId, showFetch("qwen35moe"));

		const rendered = resolveCliPromptTemplate({
			providerId: "ollama",
			modelId,
			baseUrl: LOCAL,
		});

		expect(rendered?.name).toBe("qwen");
		expect(rendered?.tools.editor).toBeTruthy();
	});

	// The state the CLI was permanently in before this: no family, so no match,
	// so the generic prompt for every local model whatever its architecture.
	it("falls back to the default when the server names no family", async () => {
		const modelId = `nameless:${Math.random()}`;
		await primeDeclaredNumCtx(LOCAL, modelId, showFetch(undefined));

		const rendered = resolveCliPromptTemplate({
			providerId: "ollama",
			modelId,
			baseUrl: LOCAL,
		});

		expect(rendered?.name).toBe("default");
	});

	it("says which template a session ended up on", async () => {
		const modelId = `a3b-coder_tb:${Math.random()}`;
		await primeDeclaredNumCtx(LOCAL, modelId, showFetch("qwen35moe"));
		const log = vi.fn();

		resolveCliPromptTemplate({
			providerId: "ollama",
			modelId,
			baseUrl: LOCAL,
			log,
		});

		expect(log).toHaveBeenCalledWith(
			expect.stringContaining("(qwen35moe) → qwen"),
		);
	});

	// Only Ollama is asked: a hosted provider's model ids already say what they
	// are, and the family cache holds nothing for them.
	it("matches a hosted model without asking for a family", () => {
		const rendered = resolveCliPromptTemplate({
			providerId: "anthropic",
			modelId: "claude-opus-4-20250514",
		});

		expect(rendered?.name).toBe("claude");
	});
});
