import type { ApiConfiguration } from "@shared/api"
import { describe, expect, it } from "vitest"
import { buildScopedApiConfiguration } from "./vision-model"

/**
 * The snapshot a tester dumped out of his settings on #43, reduced to the parts
 * that matter and with the values kept exactly as they were.
 *
 * Two fields name a model and they disagree: `providerConfig.selectedModelId`
 * is the vision model he picked, and `mode.ollamaModelId` is the *primary*
 * model — DeepSeek, which cannot read images and is the whole reason he
 * configured a vision model. He fixed it by editing the file by hand, which is
 * the report this test exists to make impossible to repeat.
 */
const REPORTED_SNAPSHOT = JSON.stringify({
	global: {
		ollamaBaseUrl: "http://192.168.1.100:30068/",
		ollamaApiOptionsCtxNum: "1048576",
	},
	mode: {
		ollamaModelId: "deepseek-v4-flash:0731-cloud",
		apiProvider: "ollama",
	},
	providerConfig: {
		baseUrl: "http://192.168.1.100:30068/",
		contextWindow: 1048576,
		selectedModelId: "mannix/omnimerge-v4-mtp:vision-Q5_K_M",
	},
})

const PRIMARY = { ollamaApiKey: "primary-key" } as unknown as ApiConfiguration

describe("the model a scoped tab actually runs", () => {
	// `buildApiHandler` reads the model from the mode keys. The picker's copy was
	// passed separately, as provider settings, where it supplies the context
	// window and the sampler and never the model — so the describer was built,
	// logged the picked model's name, and sent its request to the primary model.
	it("uses the model the tab's picker names, not the one left in the mode keys", () => {
		const configuration = buildScopedApiConfiguration(PRIMARY, REPORTED_SNAPSHOT) as Record<string, unknown>

		expect(configuration.actModeOllamaModelId).toBe("mannix/omnimerge-v4-mtp:vision-Q5_K_M")
		expect(configuration.planModeOllamaModelId).toBe("mannix/omnimerge-v4-mtp:vision-Q5_K_M")
	})

	it("still carries the provider and the base URL from the snapshot", () => {
		const configuration = buildScopedApiConfiguration(PRIMARY, REPORTED_SNAPSHOT) as Record<string, unknown>

		expect(configuration.actModeApiProvider).toBe("ollama")
		expect(configuration.ollamaBaseUrl).toBe("http://192.168.1.100:30068/")
	})

	it("takes the API key from the primary configuration, where keys live", () => {
		const configuration = buildScopedApiConfiguration(PRIMARY, REPORTED_SNAPSHOT) as Record<string, unknown>

		expect(configuration.ollamaApiKey).toBe("primary-key")
	})

	// A tab configured through the settings fields rather than the picker has no
	// `selectedModelId` at all, and its mode keys are the only thing naming a
	// model. Overriding them with nothing would break exactly that case.
	it("leaves the mode keys alone when the picker names nothing", () => {
		const snapshot = JSON.stringify({
			global: {},
			mode: { ollamaModelId: "settings-configured-model", apiProvider: "ollama" },
		})

		const configuration = buildScopedApiConfiguration(PRIMARY, snapshot) as Record<string, unknown>

		expect(configuration.actModeOllamaModelId).toBe("settings-configured-model")
	})

	// The key is per provider: writing the Ollama one for an Anthropic tab would
	// leave the handler reading an empty field.
	it("writes the model under the key that provider's handler reads", () => {
		const snapshot = JSON.stringify({
			global: {},
			mode: { apiProvider: "anthropic" },
			providerConfig: { selectedModelId: "claude-sonnet-4-6" },
		})

		const configuration = buildScopedApiConfiguration(PRIMARY, snapshot) as Record<string, unknown>

		expect(configuration.actModeApiModelId).toBe("claude-sonnet-4-6")
	})

	it("returns nothing when the tab names no provider", () => {
		expect(buildScopedApiConfiguration(PRIMARY, JSON.stringify({ global: {}, mode: {} }))).toBeUndefined()
	})
})
