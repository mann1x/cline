import { beforeEach, describe, expect, it, vi } from "vitest"

const stored = { endpoint: "" as string, apiKey: undefined as string | undefined }

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalSettingsKey: (key: string) => (key === "imageGenEndpoint" ? stored.endpoint : undefined),
			getSecretKey: (key: string) => (key === "imageGenApiKey" ? stored.apiKey : undefined),
		}),
	},
}))

vi.mock("@/shared/services/Logger", () => ({
	Logger: { log: () => {}, warn: () => {}, error: () => {} },
}))

import { isImageGenerationConfigured, readImageGenerationEndpoint } from "./image-generation-config"

beforeEach(() => {
	stored.endpoint = ""
	stored.apiKey = undefined
})

describe("readImageGenerationEndpoint", () => {
	it("reads the endpoint the user named on the Images tab", () => {
		stored.endpoint = JSON.stringify({ baseUrl: " https://gen.pollinations.ai ", model: " z-image ", size: "1024x1024" })

		expect(readImageGenerationEndpoint()).toEqual({
			baseUrl: "https://gen.pollinations.ai",
			model: "z-image",
			size: "1024x1024",
		})
	})

	// The key is stored apart from the rest, and has to be put back together
	// here: nothing else reads both, and the tool needs one object.
	it("joins the stored key back on", () => {
		stored.endpoint = JSON.stringify({ baseUrl: "https://gen.pollinations.ai", model: "z-image" })
		stored.apiKey = "  sk-secret  "

		expect(readImageGenerationEndpoint()?.apiKey).toBe("sk-secret")
	})

	it("leaves the key off entirely when there is none", () => {
		stored.endpoint = JSON.stringify({ baseUrl: "http://localhost:8080", model: "z-image" })
		stored.apiKey = "   "

		expect(readImageGenerationEndpoint()).not.toHaveProperty("apiKey")
		expect(isImageGenerationConfigured()).toBe(true)
	})

	// Half a configuration cannot be called. Offering the tool on it only moves
	// the failure to where the model has to explain it to the user.
	it("is nothing without both an endpoint and a model", () => {
		stored.endpoint = JSON.stringify({ baseUrl: "http://localhost:8080", model: "" })
		expect(readImageGenerationEndpoint()).toBeUndefined()
		expect(isImageGenerationConfigured()).toBe(false)

		stored.endpoint = JSON.stringify({ baseUrl: "   ", model: "z-image" })
		expect(readImageGenerationEndpoint()).toBeUndefined()

		stored.endpoint = ""
		expect(readImageGenerationEndpoint()).toBeUndefined()
	})

	// Stored JSON that will not parse is a settings file someone edited, not a
	// reason to throw inside a tool call.
	it("treats unparseable storage as nothing configured", () => {
		stored.endpoint = "{not json"

		expect(readImageGenerationEndpoint()).toBeUndefined()
	})
})
