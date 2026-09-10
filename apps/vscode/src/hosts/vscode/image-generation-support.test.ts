import { afterEach, describe, expect, it } from "vitest"
import * as vscode from "vscode"
import { isImageGenerationConfigured, readImageGenerationEndpoint } from "./image-generation-support"

const originalGetConfiguration = vscode.workspace.getConfiguration
const originalEnv = { ...process.env }

function stubSettings(values: Record<string, string | undefined>): void {
	vscode.workspace.getConfiguration = ((section?: string) =>
		section === "cline.imageGeneration"
			? { get: (key: string) => values[key] }
			: originalGetConfiguration(section as never)) as typeof vscode.workspace.getConfiguration
}

afterEach(() => {
	vscode.workspace.getConfiguration = originalGetConfiguration
	process.env = { ...originalEnv }
})

describe("readImageGenerationEndpoint", () => {
	it("reads the endpoint the user configured", () => {
		stubSettings({ endpoint: " http://localhost:8080/v1 ", model: " z-image ", size: "1024x1024" })

		expect(readImageGenerationEndpoint()).toEqual({
			baseUrl: "http://localhost:8080/v1",
			model: "z-image",
			size: "1024x1024",
		})
	})

	// Half a configuration cannot be called. Offering the tool on it only moves
	// the failure to where the model has to explain it to the user.
	it("is nothing without both an endpoint and a model", () => {
		stubSettings({ endpoint: "http://localhost:8080", model: "" })
		expect(readImageGenerationEndpoint()).toBeUndefined()
		expect(isImageGenerationConfigured()).toBe(false)

		stubSettings({ endpoint: "   ", model: "z-image" })
		expect(readImageGenerationEndpoint()).toBeUndefined()

		stubSettings({})
		expect(readImageGenerationEndpoint()).toBeUndefined()
	})

	// So a key need not be written into a settings file that syncs and gets
	// committed.
	it("takes the API key from the environment when asked to", () => {
		process.env.CLINE_TEST_IMAGE_KEY = "sk-from-env"
		stubSettings({
			endpoint: "https://api.example.com/v1",
			model: "dall-e-3",
			apiKey: "${env:CLINE_TEST_IMAGE_KEY}",
		})

		expect(readImageGenerationEndpoint()?.apiKey).toBe("sk-from-env")
	})

	it("leaves the key off entirely when there is none", () => {
		stubSettings({ endpoint: "http://localhost:8080", model: "z-image", apiKey: "  " })

		expect(readImageGenerationEndpoint()).not.toHaveProperty("apiKey")
		expect(isImageGenerationConfigured()).toBe(true)
	})
})
