import { describe, expect, it } from "vitest"
import { resolveVisionModelStatus, visionSnapshotProviderId } from "./vision-config"

const snapshot = (value: Record<string, unknown>) => JSON.stringify(value)

describe("resolveVisionModelStatus", () => {
	it("is off when the toggle is off, however complete the tab is", () => {
		const configured = snapshot({ global: {}, mode: { apiProvider: "ollama" } })
		expect(resolveVisionModelStatus(false, configured)).toBe("off")
		expect(resolveVisionModelStatus(undefined, configured)).toBe("off")
	})

	// The state a tester was in: the box ticked, the tab never filled in, and
	// nothing anywhere saying so. The chat UI read the toggle, let an image
	// through, and the primary model refused the turn.
	it("is unconfigured when the toggle is on and the tab names no provider", () => {
		expect(resolveVisionModelStatus(true, undefined)).toBe("unconfigured")
		expect(resolveVisionModelStatus(true, "")).toBe("unconfigured")
		expect(resolveVisionModelStatus(true, snapshot({ global: {}, mode: {} }))).toBe("unconfigured")
	})

	// A model picked on the Vision tab is written into `providerConfig` alone;
	// the provider is what says a describer can be built at all.
	it("is unconfigured when only a model was picked", () => {
		const modelOnly = snapshot({ global: {}, mode: {}, providerConfig: { selectedModelId: "qwen3-vl:8b" } })
		expect(resolveVisionModelStatus(true, modelOnly)).toBe("unconfigured")
	})

	it("is ready once the tab names a provider", () => {
		const configured = snapshot({
			global: { ollamaBaseUrl: "http://localhost:11434" },
			mode: { apiProvider: "ollama", ollamaModelId: "qwen3-vl:8b" },
		})
		expect(resolveVisionModelStatus(true, configured)).toBe("ready")
		expect(visionSnapshotProviderId(configured)).toBe("ollama")
	})

	it("is unconfigured rather than throwing on a snapshot that will not parse", () => {
		expect(resolveVisionModelStatus(true, "{broken")).toBe("unconfigured")
		expect(visionSnapshotProviderId("{broken")).toBeUndefined()
	})
})
