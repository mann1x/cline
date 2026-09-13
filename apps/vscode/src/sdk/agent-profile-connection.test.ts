import type { ApiConfiguration } from "@shared/api"
import { describe, expect, it } from "vitest"
import { createAgentProfileConnectionResolver } from "./agent-profile-connection"

const PROFILES = JSON.stringify([
	{
		name: "fast-reviewer",
		updatedAt: 1,
		snapshot: {
			global: { ollamaBaseUrl: "http://192.168.1.100:30068/" },
			mode: { apiProvider: "ollama", ollamaModelId: "stale-model" },
			providerConfig: { selectedModelId: "reviewer-model", contextWindow: 32_768 },
		},
	},
	{
		name: "cloud-anthropic",
		updatedAt: 2,
		snapshot: { global: {}, mode: { apiProvider: "anthropic", apiModelId: "claude-sonnet-4-6" } },
	},
])

const PRIMARY = { ollamaApiKey: "ollama-key", apiKey: "anthropic-key" } as unknown as ApiConfiguration

function resolve(name: string) {
	return createAgentProfileConnectionResolver({ storedProfiles: PROFILES, primary: PRIMARY })(name)
}

describe("an agent file naming a saved profile", () => {
	it("resolves the provider and the model", () => {
		const connection = resolve("fast-reviewer")

		expect(connection?.providerId).toBe("ollama")
		expect(connection?.modelId).toBe("reviewer-model")
	})

	// The context window is the field with no home in an agent file at all, and
	// the main reason to name a profile rather than a provider and a model.
	it("carries the settings the profile exists for", () => {
		expect((resolve("fast-reviewer")?.providerConfig as { contextWindow?: number }).contextWindow).toBe(32_768)
	})

	// Same rule as the Vision tab (#43): two fields name a model and the
	// picker's is the one the user last chose. A profile saved before that fix
	// can hold a stale model in its mode keys.
	it("prefers the picker's model over a stale one in the mode keys", () => {
		expect(resolve("fast-reviewer")?.modelId).toBe("reviewer-model")
	})

	it("falls back to the mode keys when the profile has no picker copy", () => {
		expect(resolve("cloud-anthropic")?.modelId).toBe("claude-sonnet-4-6")
	})

	// Profiles deliberately store no API key, so it has to come from where keys
	// are kept — per provider, on the session's configuration.
	it("takes the API key from the session, since profiles hold none", () => {
		expect(resolve("fast-reviewer")?.apiKey).toBe("ollama-key")
	})

	it("carries the base URL the profile was saved with", () => {
		expect(resolve("fast-reviewer")?.baseUrl).toBe("http://192.168.1.100:30068/")
	})

	// Core turns this into a refusal naming the agent and the profile. Returning
	// a half-built connection instead would run the agent on the session's model
	// under a name the user chose for something else.
	it("resolves nothing for a name that was renamed or deleted", () => {
		expect(resolve("no-such-profile")).toBeUndefined()
	})

	it("resolves nothing for a profile that names no provider", () => {
		const resolver = createAgentProfileConnectionResolver({
			storedProfiles: JSON.stringify([{ name: "broken", updatedAt: 1, snapshot: { global: {}, mode: {} } }]),
			primary: PRIMARY,
		})

		expect(resolver("broken")).toBeUndefined()
	})

	it("resolves nothing when no profiles have ever been saved", () => {
		expect(createAgentProfileConnectionResolver({ storedProfiles: undefined, primary: PRIMARY })("any")).toBeUndefined()
	})
})
