import type { ApiConfiguration } from "@shared/api"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { parseProviderId } from "./provider-id"

const mocks = vi.hoisted(() => {
	let apiConfiguration: ApiConfiguration = {}
	let providerSettingsById: Record<string, unknown> = {}

	return {
		setApiConfiguration(value: ApiConfiguration): void {
			apiConfiguration = value
		},
		setProviderSettings(value: Record<string, unknown>): void {
			providerSettingsById = value
		},
		getStateManager() {
			return { getApiConfiguration: () => apiConfiguration }
		},
		getProviderSettingsManager() {
			return { getProviderSettings: (providerId: string) => providerSettingsById[providerId] }
		},
	}
})

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: { get: mocks.getStateManager },
}))

vi.mock("../provider-migration", () => ({
	getProviderSettingsManager: mocks.getProviderSettingsManager,
}))

describe("buildEffectiveProviderConfig", () => {
	beforeEach(() => {
		mocks.setApiConfiguration({})
		mocks.setProviderSettings({})
	})

	it("builds Ollama config with StateManager base URL over providers.json and local extras", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			ollama: {
				provider: "ollama",
				apiKey: "provider-ollama-key",
				baseUrl: "http://provider-ollama:11434",
			},
		})
		mocks.setApiConfiguration({
			ollamaBaseUrl: "http://state-ollama:11434",
			ollamaApiOptionsCtxNum: "8192",
		})

		expect(buildEffectiveProviderConfig(parseProviderId("ollama"))).toEqual({
			providerId: parseProviderId("ollama"),
			apiKey: "provider-ollama-key",
			baseUrl: "http://state-ollama:11434",
			// The legacy state string surfaces as the provider-neutral
			// contextWindow when providers.json has none.
			contextWindow: 8192,
		})
	})

	it("prefers the providers.json contextWindow over the legacy Ollama state key", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			ollama: {
				provider: "ollama",
				contextWindow: 65536,
			},
		})
		mocks.setApiConfiguration({
			ollamaApiOptionsCtxNum: "8192",
		})

		expect(buildEffectiveProviderConfig(parseProviderId("ollama"))).toEqual({
			providerId: parseProviderId("ollama"),
			contextWindow: 65536,
		})
	})

	it("builds LiteLLM config by merging providers.json fields and StateManager overlays", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			litellm: {
				provider: "litellm",
				apiKey: "provider-litellm-key",
				baseUrl: "https://provider-litellm.example.com/v1",
				headers: { "x-provider": "provider-header" },
				extras: { providerOnly: true },
			},
		})
		mocks.setApiConfiguration({
			liteLlmBaseUrl: "https://state-litellm.example.com/v1",
			liteLlmUsePromptCache: true,
		})

		expect(buildEffectiveProviderConfig(parseProviderId("litellm"))).toEqual({
			providerId: parseProviderId("litellm"),
			apiKey: "provider-litellm-key",
			baseUrl: "https://state-litellm.example.com/v1",
			headers: { "x-provider": "provider-header" },
			extras: { providerOnly: true, liteLlmUsePromptCache: true },
		})
	})

	it("uses StateManager DeepSeek API key over providers.json", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({ deepseek: { provider: "deepseek", apiKey: "provider-deepseek-key" } })
		mocks.setApiConfiguration({ deepSeekApiKey: "state-deepseek-key" })

		expect(buildEffectiveProviderConfig(parseProviderId("deepseek"))).toEqual({
			providerId: parseProviderId("deepseek"),
			apiKey: "state-deepseek-key",
		})
	})

	it("reads migrated OpenAI Compatible settings from the SDK provider id", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			"openai-compatible": {
				provider: "openai-compatible",
				apiKey: "migrated-openai-compatible-key",
				baseUrl: "https://gateway.example.invalid/v1",
				headers: { "X-Test": "legacy-header" },
			},
		})

		expect(buildEffectiveProviderConfig(parseProviderId("openai"))).toEqual({
			providerId: parseProviderId("openai"),
			apiKey: "migrated-openai-compatible-key",
			baseUrl: "https://gateway.example.invalid/v1",
			headers: { "X-Test": "legacy-header" },
		})
	})

	it("reads normalized nousResearch API key from StateManager", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({ nousResearch: { provider: "nousResearch", apiKey: "provider-nous-key" } })
		mocks.setApiConfiguration({ nousResearchApiKey: "state-nous-key" })

		expect(buildEffectiveProviderConfig(parseProviderId("nousResearch"))).toEqual({
			providerId: parseProviderId("nousResearch"),
			apiKey: "state-nous-key",
		})
	})

	it("carries Qwen apiLine from StateManager effective configuration", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({ qwen: { provider: "qwen", apiKey: "provider-qwen-key", apiLine: "china" } })
		mocks.setApiConfiguration({ qwenApiKey: "state-qwen-key", qwenApiLine: "international" })

		expect(buildEffectiveProviderConfig(parseProviderId("qwen"))).toEqual({
			providerId: parseProviderId("qwen"),
			apiKey: "state-qwen-key",
			apiLine: "international",
		})
	})

	it("reads the Z.AI Coding Plan API key from provider-specific settings", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			"zai-coding-plan": { provider: "zai-coding-plan", apiKey: "provider-zai-coding-plan-key" },
		})
		mocks.setApiConfiguration({ zaiApiKey: "state-zai-key" })

		expect(buildEffectiveProviderConfig(parseProviderId("zai-coding-plan"))).toEqual({
			providerId: parseProviderId("zai-coding-plan"),
			apiKey: "provider-zai-coding-plan-key",
		})
	})

	it("does not reuse the legacy Z.AI API key for Z.AI Coding Plan", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			"zai-coding-plan": { provider: "zai-coding-plan" },
		})
		mocks.setApiConfiguration({ zaiApiKey: "state-zai-key" })

		expect(buildEffectiveProviderConfig(parseProviderId("zai-coding-plan"))).toEqual({
			providerId: parseProviderId("zai-coding-plan"),
		})
	})

	it("respects remote-config-locked LiteLLM key already applied by StateManager", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			litellm: {
				provider: "litellm",
				apiKey: "local-litellm-key-from-providers-json",
				baseUrl: "https://provider-litellm.example.com/v1",
			},
		})
		mocks.setApiConfiguration({
			liteLlmApiKey: "remote-config-locked-litellm-key",
			liteLlmBaseUrl: "https://remote-litellm.example.com/v1",
		})

		expect(buildEffectiveProviderConfig(parseProviderId("litellm"))).toEqual({
			providerId: parseProviderId("litellm"),
			apiKey: "remote-config-locked-litellm-key",
			baseUrl: "https://remote-litellm.example.com/v1",
		})
	})

	it("keeps Cline account auth in the auth envelope", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setApiConfiguration({ clineApiKey: "cline-access-token", clineAccountId: "account-123" })

		expect(buildEffectiveProviderConfig(parseProviderId("cline"))).toEqual({
			providerId: parseProviderId("cline"),
			apiKey: "cline-access-token",
			auth: { accessToken: "cline-access-token", accountId: "account-123" },
		})
	})
})

describe("provider-level numbers the settings panel reads back", () => {
	beforeEach(() => {
		mocks.setApiConfiguration({})
		mocks.setProviderSettings({})
	})

	// Both were written to providers.json and never read back onto the config,
	// so the fields rendered blank after a reload and looked as though the
	// value had not been kept.
	it("returns the stored tool-result cap and parallel-session count", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			ollama: { provider: "ollama", maxToolResultChars: 40_000, parallelSessions: 4 },
		})

		const config = buildEffectiveProviderConfig(parseProviderId("ollama"))

		expect(config.maxToolResultChars).toBe(40_000)
		expect(config.parallelSessions).toBe(4)
	})

	it("leaves the cap absent when nothing stored one, so the global setting still decides", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({ ollama: { provider: "ollama" } })

		const config = buildEffectiveProviderConfig(parseProviderId("ollama"))

		expect(config.maxToolResultChars).toBeUndefined()
	})

	it("ignores a stored cap that is not a positive number", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({ ollama: { provider: "ollama", maxToolResultChars: 0 } })

		const config = buildEffectiveProviderConfig(parseProviderId("ollama"))

		// Zero would otherwise read as "send no tool result at all".
		expect(config.maxToolResultChars).toBeUndefined()
	})
})

// A settings field stored `0.9` as `9`, `0.4` as `4` and `1.05` as `105`, and
// every one passed the sign check and reached a live Ollama. 73 minutes of
// requests ran at temperature 4.0 with a repeat penalty of 105 before anyone
// looked at the server's own sampler log. The panel refuses these on entry now,
// but a settings file written earlier still holds them.
describe("sampling values that cannot mean anything", () => {
	beforeEach(() => {
		mocks.setApiConfiguration({})
		mocks.setProviderSettings({})
	})

	const load = async (sampling: Record<string, number>) => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({ ollama: { provider: "ollama", sampling } })
		return buildEffectiveProviderConfig(parseProviderId("ollama")).sampling
	}

	it("drops a top_p that is not a probability", async () => {
		expect((await load({ topP: 9 }))?.topP).toBeUndefined()
	})

	it("drops a temperature of 4 and a repeat penalty of 105", async () => {
		const sampling = await load({ temperature: 4, repeatPenalty: 105 })
		expect(sampling?.temperature).toBeUndefined()
		expect(sampling?.repeatPenalty).toBeUndefined()
	})

	it("keeps the value that was actually meant", async () => {
		const sampling = await load({ topP: 0.9, temperature: 0.4, repeatPenalty: 1.05, minP: 0.05 })
		expect(sampling?.topP).toBe(0.9)
		expect(sampling?.temperature).toBe(0.4)
		expect(sampling?.repeatPenalty).toBe(1.05)
		expect(sampling?.minP).toBe(0.05)
	})

	it("drops only the bad field, leaving its neighbours in force", async () => {
		const sampling = await load({ topP: 9, temperature: 0.4 })
		expect(sampling?.topP).toBeUndefined()
		expect(sampling?.temperature).toBe(0.4)
	})

	it("still allows the edges each parameter is defined at", async () => {
		const sampling = await load({ temperature: 0, topP: 1, repeatPenalty: 2, presencePenalty: -2 })
		expect(sampling?.temperature).toBe(0)
		expect(sampling?.topP).toBe(1)
		expect(sampling?.repeatPenalty).toBe(2)
		expect(sampling?.presencePenalty).toBe(-2)
	})

	// num_gpu is a layer count, and the point of the field is to override an
	// estimator that under-offloads. Its range has to admit -1 ("you decide"),
	// 0 (CPU only) and counts well past the 99 people habitually type, because
	// large models really do have more layers than that.
	it("keeps every num_gpu that means something, including past 99", async () => {
		expect((await load({ numGpu: -1 }))?.numGpu).toBe(-1)
		expect((await load({ numGpu: 0 }))?.numGpu).toBe(0)
		expect((await load({ numGpu: 99 }))?.numGpu).toBe(99)
		expect((await load({ numGpu: 126 }))?.numGpu).toBe(126)
		expect((await load({ numGpu: 9999 }))?.numGpu).toBe(9999)
	})

	it("drops a num_gpu that is not a layer count", async () => {
		expect((await load({ numGpu: -2 }))?.numGpu).toBeUndefined()
		expect((await load({ numGpu: 990000 }))?.numGpu).toBeUndefined()
	})
})

describe("the PolyKV section", () => {
	// This is the read half of the write-only-field failure: the store writes
	// the section, and if nothing reads it back the panel renders blank and the
	// session runs on defaults while providers.json says otherwise.
	it("reads the stored section back", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			opencoti: {
				provider: "opencoti",
				polykv: {
					enabled: true,
					mode: "enforced",
					targetTpsPerSession: 12,
					prefillMaxSlots: 0,
					compactionPressureThreshold: 0.7,
				},
			},
		})

		const config = buildEffectiveProviderConfig(parseProviderId("opencoti"))

		expect(config.polykv).toEqual({
			enabled: true,
			mode: "enforced",
			targetTpsPerSession: 12,
			// Zero is "off" for this one, not "unset" — a truthiness check here
			// would drop the only value that turns the prefill arm off.
			prefillMaxSlots: 0,
			compactionPressureThreshold: 0.7,
		})
	})

	it("drops a mode the engine would refuse", async () => {
		// `queue` never shipped and the server answers 400 to it. Carrying it
		// forward would put a value in the request that fails the whole turn.
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			opencoti: {
				provider: "opencoti",
				polykv: { enabled: true, mode: "turbo", onSaturation: "queue" },
			},
		})

		const config = buildEffectiveProviderConfig(parseProviderId("opencoti"))

		expect(config.polykv).toEqual({ enabled: true })
	})

	// Adding a field to this section touches a type, a patch mapping and two
	// explicit field lists here — and the field lists are the two that fail
	// silently. A field missing from them is stored, shown in the panel, and
	// dropped on the way to the session, which reads as the setting simply not
	// working.
	it("reads the window controls back, floor included", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			opencoti: {
				provider: "opencoti",
				polykv: { enabled: true, dynamicContextSize: true, contextFloor: 32_768 },
			},
		})

		const config = buildEffectiveProviderConfig(parseProviderId("opencoti"))

		expect(config.polykv).toEqual({
			enabled: true,
			dynamicContextSize: true,
			contextFloor: 32_768,
		})
	})

	// A floor of zero is not a floor. Unlike `prefillMaxSlots`, where 0 is the
	// value that turns the arm off, here it would mean "any window at all is
	// acceptable" — which is the same as having no floor, said in a way that
	// looks deliberate.
	it("reads compaction as a continuation switched off", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			opencoti: { provider: "opencoti", polykv: { enabled: true, continuationCompaction: false } },
		})

		const config = buildEffectiveProviderConfig(parseProviderId("opencoti"))

		expect(config.polykv).toEqual({ enabled: true, continuationCompaction: false })
	})

	it("drops a floor of zero rather than storing a floor of nothing", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			opencoti: {
				provider: "opencoti",
				polykv: { enabled: true, dynamicContextSize: true, contextFloor: 0 },
			},
		})

		const config = buildEffectiveProviderConfig(parseProviderId("opencoti"))

		expect(config.polykv).toEqual({ enabled: true, dynamicContextSize: true })
	})

	it("leaves the section absent when nothing stored one", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({ opencoti: { provider: "opencoti" } })

		const config = buildEffectiveProviderConfig(parseProviderId("opencoti"))

		expect(config.polykv).toBeUndefined()
	})
})

describe("the tool selection", () => {
	// The read half of the write-only-field failure again: the store writes the
	// section, and with nothing reading it back the panel shows every tool on
	// while the session runs without them.
	it("reads the stored selection back", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			ollama: { provider: "ollama", tools: { disabled: ["browser", "awk"] } },
		})

		const config = buildEffectiveProviderConfig(parseProviderId("ollama"))

		expect(config.tools).toEqual({ disabled: ["browser", "awk"] })
	})

	it("reads a selection that withholds nothing as no selection", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({ ollama: { provider: "ollama", tools: { disabled: [] } } })

		const config = buildEffectiveProviderConfig(parseProviderId("ollama"))

		expect(config.tools).toBeUndefined()
	})

	it("drops a name that is not one", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			ollama: { provider: "ollama", tools: { disabled: ["grep", "", 7, null] } },
		})

		const config = buildEffectiveProviderConfig(parseProviderId("ollama"))

		expect(config.tools).toEqual({ disabled: ["grep"] })
	})
})

describe("the output budget", () => {
	// The read half again. This one has a second reader: the session factory
	// reads the same section to size `num_predict`/`n_predict` and to state the
	// cap in the system prompt, so a section that does not read back leaves the
	// model told one number and held to another.
	it("reads the stored section back", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			opencoti: {
				provider: "opencoti",
				outputBudget: { mode: "manual", maxTokens: 96_000 },
			},
		})

		const config = buildEffectiveProviderConfig(parseProviderId("opencoti"))

		expect(config.outputBudget).toEqual({ mode: "manual", maxTokens: 96_000 })
	})

	it("keeps an auto ceiling on its own", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			ollama: { provider: "ollama", outputBudget: { mode: "auto", maxTokens: 200_000 } },
		})

		const config = buildEffectiveProviderConfig(parseProviderId("ollama"))

		expect(config.outputBudget).toEqual({ mode: "auto", maxTokens: 200_000 })
	})

	it("drops a mode that is neither", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			ollama: { provider: "ollama", outputBudget: { mode: "adaptive", maxTokens: 64_000 } },
		})

		const config = buildEffectiveProviderConfig(parseProviderId("ollama"))

		expect(config.outputBudget).toEqual({ maxTokens: 64_000 })
	})

	it("drops a cap that cannot mean anything", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			ollama: { provider: "ollama", outputBudget: { mode: "manual", maxTokens: 0 } },
		})

		const config = buildEffectiveProviderConfig(parseProviderId("ollama"))

		expect(config.outputBudget).toEqual({ mode: "manual" })
	})

	it("leaves the section absent when nothing stored one", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({ ollama: { provider: "ollama" } })

		const config = buildEffectiveProviderConfig(parseProviderId("ollama"))

		expect(config.outputBudget).toBeUndefined()
	})
})

describe("reasoning history", () => {
	// The panel shows what is in force before changing it, so a section written
	// but never read back shows "auto" over a profile that says "last" -- the
	// write-only failure this tree has hit before.
	it("reads the stored choice back", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			ollama: { provider: "ollama", reasoning: { enabled: true, reasoningHistory: "last" } },
		})

		const config = buildEffectiveProviderConfig(parseProviderId("ollama"))

		expect(config.reasoning?.reasoningHistory).toBe("last")
	})

	it("drops a mode the resolver does not understand", async () => {
		const { buildEffectiveProviderConfig } = await import("./effective-config")
		mocks.setProviderSettings({
			ollama: { provider: "ollama", reasoning: { reasoningHistory: "sometimes" } },
		})

		const config = buildEffectiveProviderConfig(parseProviderId("ollama"))

		expect(config.reasoning?.reasoningHistory).toBeUndefined()
	})
})
