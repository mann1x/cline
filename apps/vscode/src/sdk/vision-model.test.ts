import type { ApiConfiguration } from "@shared/api"
import { captureApiConfigurationSnapshot } from "@shared/api-config-snapshot"
import { describe, expect, it } from "vitest"
import { buildVisionApiConfiguration } from "./vision-model"

function storedSnapshot(configuration: Partial<ApiConfiguration>): string {
	return JSON.stringify(captureApiConfigurationSnapshot(configuration as ApiConfiguration, "act"))
}

describe("buildVisionApiConfiguration", () => {
	it("rebuilds the configuration the Vision tab saved", () => {
		const stored = storedSnapshot({
			actModeApiProvider: "ollama",
			actModeOllamaModelId: "qwen2.5vl:7b",
			ollamaBaseUrl: "http://127.0.0.1:11434",
		})

		const built = buildVisionApiConfiguration({} as ApiConfiguration, stored)

		expect(built?.actModeApiProvider).toBe("ollama")
		expect(built?.actModeOllamaModelId).toBe("qwen2.5vl:7b")
		expect(built?.ollamaBaseUrl).toBe("http://127.0.0.1:11434")
	})

	// The Vision tab has no Plan/Act distinction, and the handler is built for
	// "act"; a snapshot restored into only one mode would resolve to no model.
	it("fills both modes so the handler resolves whichever it asks for", () => {
		const built = buildVisionApiConfiguration(
			{} as ApiConfiguration,
			storedSnapshot({ actModeApiProvider: "ollama", actModeOllamaModelId: "qwen2.5vl:7b" }),
		)

		expect(built?.planModeApiProvider).toBe("ollama")
		expect(built?.planModeOllamaModelId).toBe("qwen2.5vl:7b")
	})

	// Keys are stored per provider and shared with the rest of the app, so they
	// are never in a snapshot and have to come from the live configuration.
	it("takes API keys from the primary configuration", () => {
		const built = buildVisionApiConfiguration(
			{ ollamaApiKey: "sk-live" } as unknown as ApiConfiguration,
			storedSnapshot({ actModeApiProvider: "ollama", actModeOllamaModelId: "qwen2.5vl:7b" }),
		)

		expect((built as Record<string, unknown>).ollamaApiKey).toBe("sk-live")
	})

	// Without a provider there is nothing to call; the caller reads undefined as
	// "install no describer" and the runtime keeps its existing behaviour.
	it("reports nothing configured when no model has been chosen", () => {
		expect(buildVisionApiConfiguration({} as ApiConfiguration, undefined)).toBeUndefined()
		expect(buildVisionApiConfiguration({} as ApiConfiguration, "")).toBeUndefined()
		expect(buildVisionApiConfiguration({} as ApiConfiguration, storedSnapshot({}))).toBeUndefined()
	})

	it("survives a stored value that is not a snapshot at all", () => {
		expect(buildVisionApiConfiguration({} as ApiConfiguration, "{broken")).toBeUndefined()
	})
})
