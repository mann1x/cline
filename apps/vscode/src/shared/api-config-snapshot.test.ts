import type { ApiConfiguration } from "@shared/api"
import { ApiHandlerSettingsKeys } from "@shared/storage/state-keys"
import { describe, expect, it } from "vitest"
import {
	apiConfigurationSnapshotsEqual,
	applyApiConfigurationSnapshot,
	captureApiConfigurationSnapshot,
	captureProviderConfigSnapshot,
	modeScopedKey,
	PROVIDER_CONFIG_CLEARS,
	PROVIDER_CONFIG_PROFILE_KEYS,
	parseModeScopedKey,
	providerConfigPatchForProfile,
} from "./api-config-snapshot"

const configuration = {
	ollamaBaseUrl: "http://127.0.0.1:11434",
	ollamaApiOptionsCtxNum: "110000",
	planModeApiProvider: "anthropic",
	actModeApiProvider: "ollama",
	planModeOllamaModelId: "plan-model",
	actModeOllamaModelId: "act-model",
	geminiPlanModeThinkingLevel: "high",
	geminiActModeThinkingLevel: "low",
} as unknown as ApiConfiguration

describe("parseModeScopedKey", () => {
	it("splits a prefixed key into its mode and bare name", () => {
		expect(parseModeScopedKey("planModeOllamaModelId")).toEqual({ mode: "plan", unprefixed: "ollamaModelId" })
		expect(parseModeScopedKey("actModeApiProvider")).toEqual({ mode: "act", unprefixed: "apiProvider" })
	})

	it("leaves a global key alone", () => {
		expect(parseModeScopedKey("ollamaBaseUrl")).toBeNull()
	})

	// This pair does not carry the prefix at the front, and a regex alone reads
	// it as global — which would put one mode's value into both.
	it("knows the gemini thinking level is mode-scoped despite its spelling", () => {
		expect(parseModeScopedKey("geminiPlanModeThinkingLevel")).toEqual({
			mode: "plan",
			unprefixed: "geminiThinkingLevel",
		})
	})

	it("round-trips every mode-scoped key the panel has", () => {
		const scoped = (ApiHandlerSettingsKeys as string[])
			.map((key) => ({ key, parsed: parseModeScopedKey(key) }))
			.filter((entry) => entry.parsed !== null)
		// If this is ever zero the convention has changed and the split is broken.
		expect(scoped.length).toBeGreaterThan(30)
		for (const { key, parsed } of scoped) {
			expect(modeScopedKey(parsed!.unprefixed, parsed!.mode)).toBe(key)
		}
	})
})

describe("captureApiConfigurationSnapshot", () => {
	it("keeps global fields and only the named mode's fields", () => {
		const snapshot = captureApiConfigurationSnapshot(configuration, "act")

		expect(snapshot.global.ollamaBaseUrl).toBe("http://127.0.0.1:11434")
		expect(snapshot.mode.apiProvider).toBe("ollama")
		expect(snapshot.mode.ollamaModelId).toBe("act-model")
		expect(snapshot.mode.geminiThinkingLevel).toBe("low")
	})

	it("does not carry the other mode's values", () => {
		const snapshot = captureApiConfigurationSnapshot(configuration, "act")
		expect(JSON.stringify(snapshot)).not.toContain("plan-model")
	})

	// A profile is written to global state and sent to the webview; secrets are
	// not, and must not start being so by way of this.
	it("captures no API keys", () => {
		const withKeys = { ...configuration, apiKey: "sk-secret", openAiApiKey: "sk-other" } as ApiConfiguration
		const snapshot = captureApiConfigurationSnapshot(withKeys, "act")
		expect(JSON.stringify(snapshot)).not.toContain("sk-secret")
		expect(JSON.stringify(snapshot)).not.toContain("sk-other")
	})

	it("survives having no configuration at all", () => {
		expect(captureApiConfigurationSnapshot(undefined, "act")).toEqual({ global: {}, mode: {} })
	})
})

describe("applyApiConfigurationSnapshot", () => {
	it("writes the captured mode's fields into the requested mode", () => {
		const snapshot = captureApiConfigurationSnapshot(configuration, "act")
		const updates = applyApiConfigurationSnapshot(snapshot, ["plan"]) as Record<string, unknown>

		expect(updates.planModeApiProvider).toBe("ollama")
		expect(updates.planModeOllamaModelId).toBe("act-model")
		expect(updates.geminiPlanModeThinkingLevel).toBe("low")
		// The mode that was not asked for is left untouched rather than cleared.
		expect(updates).not.toHaveProperty("actModeApiProvider")
	})

	it("can load one profile into both modes at once", () => {
		const snapshot = captureApiConfigurationSnapshot(configuration, "act")
		const updates = applyApiConfigurationSnapshot(snapshot, ["plan", "act"]) as Record<string, unknown>

		expect(updates.planModeApiProvider).toBe("ollama")
		expect(updates.actModeApiProvider).toBe("ollama")
	})

	// The failure this prevents: switch from a profile with a base URL to one
	// without, and the old URL is still pointing at the wrong server.
	it("clears fields the profile does not set", () => {
		const snapshot = captureApiConfigurationSnapshot(
			{ actModeApiProvider: "anthropic" } as unknown as ApiConfiguration,
			"act",
		)
		const updates = applyApiConfigurationSnapshot(snapshot, ["act"]) as Record<string, unknown>

		expect(updates).toHaveProperty("ollamaBaseUrl")
		expect(updates.ollamaBaseUrl).toBeUndefined()
	})

	it("round-trips a configuration unchanged", () => {
		const snapshot = captureApiConfigurationSnapshot(configuration, "act")
		const restored = applyApiConfigurationSnapshot(snapshot, ["act"])

		expect(captureApiConfigurationSnapshot(restored as ApiConfiguration, "act")).toEqual(snapshot)
	})
})

describe("apiConfigurationSnapshotsEqual", () => {
	it("matches a snapshot against itself", () => {
		const snapshot = captureApiConfigurationSnapshot(configuration, "act")
		expect(apiConfigurationSnapshotsEqual(snapshot, captureApiConfigurationSnapshot(configuration, "act"))).toBe(true)
	})

	it("notices a changed field", () => {
		const a = captureApiConfigurationSnapshot(configuration, "act")
		const b = captureApiConfigurationSnapshot({ ...configuration, ollamaApiOptionsCtxNum: "8000" }, "act")
		expect(apiConfigurationSnapshotsEqual(a, b)).toBe(false)
	})

	// Model info arrives as an object; storage does not promise key order, and a
	// reordered round trip must not read as an unsaved edit.
	it("ignores key order inside nested objects", () => {
		const a = { global: { openAiHeaders: { a: "1", b: "2" } }, mode: {} }
		const b = { global: { openAiHeaders: { b: "2", a: "1" } }, mode: {} }
		expect(apiConfigurationSnapshotsEqual(a, b)).toBe(true)
	})

	it("treats a missing field and an unset field as the same", () => {
		expect(apiConfigurationSnapshotsEqual({ global: {}, mode: {} }, { global: { ollamaBaseUrl: undefined }, mode: {} })).toBe(
			true,
		)
	})

	// The context window lives in the provider config, not in the settings
	// snapshot: `contextWindow` is what providers.json holds and what the session
	// reads. A comparison that skipped it whenever either side lacked one skipped
	// it permanently for any profile that had none, so changing the context
	// window never marked the profile dirty and it could not be saved.
	it("notices a changed context window", () => {
		const a = { global: {}, mode: {}, providerConfig: { contextWindow: 110000 } }
		const b = { global: {}, mode: {}, providerConfig: { contextWindow: 32768 } }
		expect(apiConfigurationSnapshotsEqual(a, b)).toBe(false)
	})

	it("still matches when neither side carries one", () => {
		expect(apiConfigurationSnapshotsEqual({ global: {}, mode: {} }, { global: {}, mode: {} })).toBe(true)
	})

	it("treats an absent provider config and an empty one as the same", () => {
		expect(apiConfigurationSnapshotsEqual({ global: {}, mode: {} }, { global: {}, mode: {}, providerConfig: {} })).toBe(true)
	})
})

describe("the provider config a profile carries", () => {
	it("captures what providers.json holds for the panel", () => {
		// The Ollama panel keeps two keys in ApiHandlerSettingsKeys and everything
		// the user actually tunes here.
		const captured = captureProviderConfigSnapshot({
			baseUrl: "http://localhost:11434",
			contextWindow: 110000,
			reasoning: { enabled: true, effort: "medium" },
			sampling: { temperature: 0.7, thinkBudget: "8000" },
		})

		expect(captured).toEqual({
			baseUrl: "http://localhost:11434",
			contextWindow: 110000,
			reasoning: { enabled: true, effort: "medium" },
			sampling: { temperature: 0.7, thinkBudget: "8000" },
		})
	})

	// Reported as "Parallel sessions does not trigger Update button as well".
	// It is a provider-level setting edited in the same panel as the context
	// window and the tool-result cap, it is writable through the same patch, and
	// it was simply absent from the key list -- so the profile could neither
	// notice it changing nor store it.
	it("carries the settings edited beside the context window", () => {
		const captured = captureProviderConfigSnapshot({
			contextWindow: 110000,
			maxToolResultChars: 32000,
			parallelSessions: 4,
		})

		expect(captured).toEqual({
			contextWindow: 110000,
			maxToolResultChars: 32000,
			parallelSessions: 4,
		})
	})

	// Reported as "I had disabled polykv and now I found it was enabled ... it
	// does not get saved". Both sections are in the load's clear list and were
	// absent from the save's key list, so every profile load wiped them and no
	// profile save ever put them back. A section the load clears and the save
	// drops is unsettable by construction.
	it("carries every section the load clears", () => {
		const captured = captureProviderConfigSnapshot({
			polykv: { enabled: false, settleTokens: 48 },
			outputBudget: { mode: "manual", maxTokens: 8000 },
		})

		expect(captured).toEqual({
			polykv: { enabled: false, settleTokens: 48 },
			outputBudget: { mode: "manual", maxTokens: 8000 },
		})
	})

	// The round trip is the one that matters: a switch turned off has to still
	// be off after saving the profile and loading it back.
	it("brings a PolyKV switch turned off back through a save and a load", () => {
		const captured = captureProviderConfigSnapshot({ polykv: { enabled: false } })

		expect(providerConfigPatchForProfile(captured).polykv).toEqual({ enabled: false })
	})

	// The guard, so the next section added does not repeat this: the two lists
	// are written a hundred lines apart and nothing but this connects them.
	it("clears nothing it does not also capture", () => {
		const captured = Object.keys(PROVIDER_CONFIG_CLEARS).filter(
			(key) => !(PROVIDER_CONFIG_PROFILE_KEYS as readonly string[]).includes(key),
		)

		expect(captured).toEqual([])
	})

	it("never carries a credential", () => {
		const captured = captureProviderConfigSnapshot({
			baseUrl: "http://localhost:11434",
			apiKey: "sk-secret",
			apiKeyLength: 9,
			accessToken: "token",
			refreshToken: "refresh",
		})

		expect(captured).toEqual({ baseUrl: "http://localhost:11434" })
	})

	it("clears the numbers a profile does not carry", () => {
		// A patch changes what it names. Naming only what the profile holds left
		// the previous profile's cap and window in place, so the panel differed
		// from the profile that had just been loaded and the bar said so.
		expect(providerConfigPatchForProfile({ contextWindow: 110000 })).toEqual({
			contextWindow: 110000,
			maxToolResultChars: 0,
			parallelSessions: 0,
			// An empty message is the sampler's clear, so a profile that carries
			// no sampler resets it instead of inheriting the last one's.
			sampling: {},
			// And the same for the PolyKV section.
			polykv: {},
			// And for the output budget: a profile that names no budget must fall
			// back to auto rather than inherit the last profile's manual cap.
			outputBudget: {},
			// And the reasoning section as a whole.
			reasoning: {},
		})
	})

	it("keeps the numbers a profile does carry", () => {
		expect(providerConfigPatchForProfile({ maxToolResultChars: 32000, parallelSessions: 2 })).toEqual({
			contextWindow: 0,
			maxToolResultChars: 32000,
			parallelSessions: 2,
			sampling: {},
			polykv: {},
			outputBudget: {},
			reasoning: {},
		})
	})

	it("leaves the fields with no clear alone", () => {
		// Base URL and friends say how to reach the provider at all; inventing a
		// value for a profile that is silent about them takes the endpoint down.
		const patch = providerConfigPatchForProfile({ baseUrl: "http://localhost:11434" })

		expect(patch.baseUrl).toBe("http://localhost:11434")
		expect("headers" in patch).toBe(false)
		expect("region" in patch).toBe(false)
	})

	it("clears the whole reasoning section a profile does not carry", () => {
		// `reasoning` is merged field by field on the store side, so an empty
		// object names nothing and is a no-op. `null` is its clear.
		expect(providerConfigPatchForProfile({ contextWindow: 110000 }).reasoning).toEqual({})
	})

	it("clears the reasoning replay a profile is silent about", () => {
		// Automatic is stored as absent, so a profile saved on Automatic carries
		// a reasoning section with no `reasoningHistory` in it. Merged as-is that
		// leaves the previous profile's choice in place under this profile's
		// name — the same fault as the sampler, one level down.
		const patch = providerConfigPatchForProfile({ reasoning: { enabled: true, effort: "high" } })

		expect(patch.reasoning).toEqual({ enabled: true, effort: "high", reasoningHistory: "" })
	})

	it("keeps the reasoning replay a profile does carry", () => {
		const patch = providerConfigPatchForProfile({ reasoning: { reasoningHistory: "last" } })

		expect(patch.reasoning).toEqual({ reasoningHistory: "last" })
	})

	it("keeps a sampler the profile does carry", () => {
		// Only the absent ones are cleared; a retuned sampler is restored as it
		// was saved.
		const patch = providerConfigPatchForProfile({ sampling: { temperature: 0.7, top_p: 0.9 } })

		expect(patch.sampling).toEqual({ temperature: 0.7, top_p: 0.9 })
	})

	it("does not send the model overrides as a provider field", () => {
		// They are restored by committing the selection instead.
		const patch = providerConfigPatchForProfile({ contextWindow: 8192, modelOverrides: { maxTokens: 4096 } })

		expect("modelOverrides" in patch).toBe(false)
	})

	it("says nothing only when there is no entry to read", () => {
		// `undefined` is the RPC that has not resolved. An entry that resolved
		// and holds nothing is an empty capture, not an absent one: the two caps
		// are blank far more often than set, and reading "blank" as "still
		// loading" is what stopped clearing one from marking a profile unsaved.
		expect(captureProviderConfigSnapshot(undefined)).toBeUndefined()
		expect(captureProviderConfigSnapshot({})).toEqual({})
	})

	it("carries the per-turn output cap, which travels with the model", () => {
		// It is committed with the selection rather than written as a provider
		// field, so no entry in the key list could reach it. Uncaptured, changing
		// it marked nothing unsaved and a profile did not carry it.
		const captured = captureProviderConfigSnapshot(
			{
				contextWindow: 110000,
				planSelection: { modelId: "m", overrides: { maxTokens: 8192 } },
				actSelection: { modelId: "m", overrides: { maxTokens: 4096 } },
			},
			"act",
		)

		expect(captured).toEqual({ contextWindow: 110000, modelOverrides: { maxTokens: 4096 } })
	})

	it("takes the overrides of the mode it was asked for", () => {
		const captured = captureProviderConfigSnapshot(
			{
				planSelection: { modelId: "m", overrides: { maxTokens: 8192 } },
				actSelection: { modelId: "m", overrides: { maxTokens: 4096 } },
			},
			"plan",
		)

		expect(captured).toEqual({ modelOverrides: { maxTokens: 8192 } })
	})

	it("sees a changed per-turn output cap as a difference", () => {
		const saved = { global: {}, mode: {}, providerConfig: { modelOverrides: { maxTokens: 4096 } } }
		const edited = { global: {}, mode: {}, providerConfig: { modelOverrides: { maxTokens: 8192 } } }

		expect(apiConfigurationSnapshotsEqual(saved, edited)).toBe(false)
	})

	it("sees a cleared per-turn output cap as a difference", () => {
		const saved = { global: {}, mode: {}, providerConfig: { modelOverrides: { maxTokens: 4096 } } }
		const cleared = { global: {}, mode: {}, providerConfig: {} }

		expect(apiConfigurationSnapshotsEqual(saved, cleared)).toBe(false)
	})

	it("sees a retuned sampler as a difference", () => {
		// The reported bug: the sampler was retuned and the bar said nothing,
		// because none of the settings keys had moved.
		const saved = {
			global: {},
			mode: {},
			providerConfig: { sampling: { temperature: 0.7 } },
		}
		const edited = {
			global: {},
			mode: {},
			providerConfig: { sampling: { temperature: 0.2 } },
		}

		expect(apiConfigurationSnapshotsEqual(saved, edited)).toBe(false)
	})

	it("reads a profile saved before this existed as one that can be saved", () => {
		// It differs, and saying so is what lets the user save it and carry a
		// provider config from then on. The old rule called them equal, which
		// made the difference permanent: the context window lives in the provider
		// config, so changing it never marked the profile dirty.
		const old = { global: { ollamaBaseUrl: "http://localhost:11434" }, mode: {} }
		const current = {
			global: { ollamaBaseUrl: "http://localhost:11434" },
			mode: {},
			providerConfig: { sampling: { temperature: 0.7 } },
		}

		expect(apiConfigurationSnapshotsEqual(old, current)).toBe(false)
	})

	it("waits for the panel to finish reading its provider config", () => {
		// The panel's copy arrives on an RPC that resolves after mount. A
		// snapshot that is still loading is not evidence of a change, and the
		// arguments are (stored, panel) for exactly this reason.
		const stored = { global: {}, mode: {}, providerConfig: { contextWindow: 110000 } }
		const stillLoading = { global: {}, mode: {} }

		expect(apiConfigurationSnapshotsEqual(stored, stillLoading)).toBe(true)
	})
})
