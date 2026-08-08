import type { ApiConfiguration } from "@shared/api"
import { ApiHandlerSettingsKeys } from "@shared/storage/state-keys"
import { describe, expect, it } from "vitest"
import {
	apiConfigurationSnapshotsEqual,
	applyApiConfigurationSnapshot,
	captureApiConfigurationSnapshot,
	captureProviderConfigSnapshot,
	modeScopedKey,
	parseModeScopedKey,
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

	it("says nothing when the provider has no entry", () => {
		expect(captureProviderConfigSnapshot(undefined)).toBeUndefined()
		expect(captureProviderConfigSnapshot({})).toBeUndefined()
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
