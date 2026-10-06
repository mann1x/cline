import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	secrets: {} as Record<string, string>,
	built: [] as Array<{ configuration: Record<string, unknown>; options: Record<string, unknown> | undefined }>,
	chunks: [] as Array<Record<string, unknown>>,
	sent: [] as Array<{ system: string; messages: unknown }>,
}))

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalSettingsKey: (key: string) => state.settings[key],
			getSecretKey: (key: string) => state.secrets[key],
			getApiConfiguration: () => ({}),
		}),
	},
}))

vi.mock("./sdk-api-handler", () => ({
	buildApiHandler: (configuration: Record<string, unknown>, _mode: string, options?: Record<string, unknown>) => {
		state.built.push({ configuration, options })
		return {
			setAbortSignal: () => {},
			createMessage: async function* (system: string, messages: unknown) {
				state.sent.push({ system, messages })
				for (const chunk of state.chunks) {
					yield chunk
				}
			},
		}
	},
}))

import { readMemoryQueryExpander } from "./memory-recall"

const profile = (name: string) => ({
	name,
	updatedAt: 1,
	snapshot: {
		global: { ollamaBaseUrl: "https://ollama.com" },
		mode: { apiProvider: "ollama", ollamaModelId: "gemma4:31b-cloud" },
		providerConfig: { selectedModelId: "gemma4:31b-cloud", contextWindow: 16384 },
	},
})

const memory = (settings: Record<string, unknown>) => {
	state.settings.memoryEnabled = true
	state.settings.memorySettings = JSON.stringify(settings)
}

describe("the model that writes Memory's expansion", () => {
	beforeEach(() => {
		state.settings = { apiConfigurationProfiles: JSON.stringify([profile("cheap cloud")]) }
		state.built = []
		state.sent = []
		state.chunks = [
			{ type: "reasoning", reasoning: "thinking about it" },
			{ type: "text", text: " Tests run with " },
			{ type: "text", text: "node --test. " },
			{ type: "done", success: true },
		]
	})

	it("is absent until the expansion is on and a profile is named", () => {
		memory({})
		expect(readMemoryQueryExpander({})).toBeUndefined()
		memory({ hyde: true })
		expect(readMemoryQueryExpander({})).toBeUndefined()
		memory({ hyde: false, hydeProfile: "cheap cloud" })
		expect(readMemoryQueryExpander({})).toBeUndefined()
		memory({ hyde: true, hydeProfile: "cheap cloud" })
		expect(readMemoryQueryExpander({})).toBeTypeOf("function")
	})

	it("is absent when the named profile no longer exists", () => {
		memory({ hyde: true, hydeProfile: "deleted" })
		expect(readMemoryQueryExpander({})).toBeUndefined()
	})

	it("asks the profile's model, with the session's keys, and returns the text alone", async () => {
		memory({ hyde: true, hydeProfile: "cheap cloud" })
		const expand = readMemoryQueryExpander({ ollamaApiKey: "k-1" } as never)
		const text = await expand?.({ system: "S", prompt: "P", signal: new AbortController().signal })
		expect(text).toBe("Tests run with node --test.")
		expect(state.sent).toEqual([{ system: "S", messages: [{ role: "user", content: "P" }] }])
		expect(state.built[0].configuration).toMatchObject({
			actModeApiProvider: "ollama",
			actModeOllamaModelId: "gemma4:31b-cloud",
			ollamaApiKey: "k-1",
		})
		// The window and sampler saved with the profile, not the session's.
		expect(state.built[0].options).toEqual({
			visionProviderSettings: { selectedModelId: "gemma4:31b-cloud", contextWindow: 16384 },
		})
	})

	it("throws on a failed stream, which the recall treats as no expansion", async () => {
		memory({ hyde: true, hydeProfile: "cheap cloud" })
		state.chunks = [{ type: "done", success: false, error: "401" }]
		const expand = readMemoryQueryExpander({})
		await expect(expand?.({ system: "S", prompt: "P", signal: new AbortController().signal })).rejects.toThrow("401")
	})
})
