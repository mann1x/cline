import { describe, expect, it } from "vitest"
import { providerSwitchCarry, sameProviderFamily } from "./provider-switch-carry"

// The Ollama entry the panel showed before the switch, shaped like the
// ProviderConfigResponse the webview holds (pandorum, 2026-11-28).
const solidpcOllama = {
	providerId: "ollama",
	baseUrl: "http://192.168.178.2:11434",
	headers: {},
	contextWindow: 128000,
	reasoning: { enabled: true, effort: "high" },
	sampling: { temperature: 0.8 },
	actSelection: { modelId: "omnimerge-v6-mtp_tb:27b-q4km-128k" },
	planSelection: { modelId: "omnimerge-v6-mtp_tb:27b-q4km-128k", overrides: { maxTokens: 8192 } },
}

describe("sameProviderFamily", () => {
	it("pairs Ollama with xOllama and opencoti with llama.cpp, both ways", () => {
		expect(sameProviderFamily("ollama", "xollama")).toBe(true)
		expect(sameProviderFamily("xollama", "ollama")).toBe(true)
		expect(sameProviderFamily("opencoti", "llamacpp")).toBe(true)
		expect(sameProviderFamily("llamacpp", "opencoti")).toBe(true)
	})

	it("does not pair across families, with itself, or with nothing", () => {
		expect(sameProviderFamily("ollama", "opencoti")).toBe(false)
		expect(sameProviderFamily("xollama", "llamacpp")).toBe(false)
		expect(sameProviderFamily("ollama", "anthropic")).toBe(false)
		expect(sameProviderFamily("ollama", "ollama")).toBe(false)
		expect(sameProviderFamily(undefined, "ollama")).toBe(false)
	})
})

describe("providerSwitchCarry", () => {
	it("carries the server, model, window, sampler and reasoning from Ollama to xOllama", () => {
		const carry = providerSwitchCarry("ollama", "xollama", solidpcOllama, ["plan", "act"])
		expect(carry?.patch).toMatchObject({
			baseUrl: "http://192.168.178.2:11434",
			contextWindow: 128000,
			sampling: { temperature: 0.8 },
			reasoning: { enabled: true, effort: "high" },
		})
		expect(carry?.selections.act).toEqual({ modelId: "omnimerge-v6-mtp_tb:27b-q4km-128k" })
		expect(carry?.selections.plan).toEqual({
			modelId: "omnimerge-v6-mtp_tb:27b-q4km-128k",
			overrides: { maxTokens: 8192 },
		})
	})

	it("clears what the source does not hold instead of keeping the target's old value", () => {
		// The xOllama entry still held the Bonsai profile's 192k window and its
		// output budget; Ollama holds neither, so the patch must clear both.
		const carry = providerSwitchCarry("ollama", "xollama", { providerId: "ollama", baseUrl: "http://h:11434" }, ["act"])
		expect(carry?.patch.contextWindow).toBe(0)
		expect(carry?.patch.maxToolResultChars).toBe(0)
		expect(carry?.patch.sampling).toEqual({})
		expect(carry?.patch.outputBudget).toEqual({})
		expect(carry?.patch.reasoning).toEqual({})
	})

	it("leaves the target's own engine settings alone", () => {
		const carry = providerSwitchCarry(
			"xollama",
			"ollama",
			{
				...solidpcOllama,
				providerId: "xollama",
				polykv: { dynamicContextSize: true },
				notices: { enabled: true },
				parallelSessions: 2,
			},
			["act"],
		)
		expect(carry?.patch).not.toHaveProperty("polykv")
		expect(carry?.patch).not.toHaveProperty("notices")
		expect(carry?.patch).not.toHaveProperty("parallelSessions")
		expect(carry?.patch).not.toHaveProperty("agentWindow")
		expect(carry?.patch).not.toHaveProperty("modelOverrides")
	})

	it("carries opencoti to llama.cpp the same way", () => {
		const carry = providerSwitchCarry(
			"opencoti",
			"llamacpp",
			{ providerId: "opencoti", baseUrl: "http://192.168.178.2:8240", actSelection: { modelId: "m.gguf" } },
			["act"],
		)
		expect(carry?.patch.baseUrl).toBe("http://192.168.178.2:8240")
		expect(carry?.selections.act).toEqual({ modelId: "m.gguf" })
	})

	it("carries nothing outside a family, or before the source entry is read", () => {
		expect(providerSwitchCarry("ollama", "opencoti", solidpcOllama, ["act"])).toBeUndefined()
		expect(providerSwitchCarry("ollama", "xollama", undefined, ["act"])).toBeUndefined()
	})

	it("commits no model for a mode the source has none for", () => {
		const carry = providerSwitchCarry("ollama", "xollama", { providerId: "ollama", actSelection: { modelId: " " } }, [
			"plan",
			"act",
		])
		expect(carry?.selections).toEqual({})
	})
})
