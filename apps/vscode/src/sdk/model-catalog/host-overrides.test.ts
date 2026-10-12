import { describe, expect, it, vi } from "vitest"
import { parseProviderId } from "./provider-id"

vi.mock("../provider-migration", () => ({
	getProviderSettingsManager: () => ({ getProviderSettings: () => ({ contextWindow: 64_000 }) }),
}))

describe("applyHostModelInfoOverrides", () => {
	it("does not read the provider's own capability list as 'no images' on Ollama", async () => {
		const { applyHostModelInfoOverrides } = await import("./host-overrides")
		// What the adapter makes of ["streaming", "tools"], which every model
		// discovered from an Ollama server carries, vision models included.
		const listed = { name: "kimi-k2.6:cloud", supportsPromptCache: false, supportsImages: false, contextWindow: 128_000 }
		for (const provider of ["ollama", "xollama"]) {
			const info = applyHostModelInfoOverrides(parseProviderId(provider), "kimi-k2.6:cloud", listed)
			expect("supportsImages" in info).toBe(false)
			expect(info.contextWindow).toBe(64_000)
		}
		// A list that does name images is an answer and is kept.
		expect(
			applyHostModelInfoOverrides(parseProviderId("ollama"), "m", { ...listed, supportsImages: true }).supportsImages,
		).toBe(true)
		// Any other provider's catalog is about the model, and stands.
		expect(applyHostModelInfoOverrides(parseProviderId("deepseek"), "m", listed).supportsImages).toBe(false)
	})
})
