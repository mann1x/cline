import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useApiConfigurationProfiles } from "../useApiConfigurationProfiles"

/**
 * The two caps, changed from a profile that does not carry one.
 *
 * Reported from the panel: "both tools cap and per-turn cap do not trigger the
 * update button when they are empty ... if they are not empty in the profile
 * and I change it, the update button shows. If I change to a profile where they
 * are empty, when I change them the update button doesn't show anymore."
 *
 * The update button is `isDirty`, so that is what these assert.
 */

// What providers.json holds for the panel's provider right now. Mutable: the
// point of these tests is what happens the moment a cap is written into it.
let panelProviderConfig: Record<string, unknown> = {
	contextWindow: 110000,
	actSelection: { modelId: "a3b-coder" },
}

vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({
		config: panelProviderConfig,
		write: vi.fn().mockResolvedValue(undefined),
		commitSelection: vi.fn().mockResolvedValue(undefined),
	}),
	writeProviderConfigFor: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldsChange: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { updateSettings: vi.fn().mockResolvedValue(undefined) },
	ModelsServiceClient: { commitModelSelection: vi.fn().mockResolvedValue(undefined) },
}))

/** A profile with a context window and NO cap of either kind: "empty". */
const PROFILE = {
	name: "ollama / no caps",
	updatedAt: 1,
	snapshot: {
		global: {},
		mode: { ollamaModelId: "a3b-coder", apiProvider: "ollama" },
		providerConfig: { contextWindow: 110000 },
	},
}

const extensionState = {
	apiConfiguration: {
		actModeApiProvider: "ollama",
		actModeOllamaModelId: "a3b-coder",
		planModeApiProvider: "ollama",
		planModeOllamaModelId: "a3b-coder",
	},
	apiConfigurationProfiles: JSON.stringify([PROFILE]),
	// The profile is loaded, which is what puts an Update button on screen at all.
	activeApiConfigurationProfile: JSON.stringify({ act: PROFILE.name }),
	visionModeApiConfiguration: "",
	planActSeparateModelsSetting: false,
}

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState,
}))

describe("changing a cap the loaded profile does not carry", () => {
	beforeEach(() => {
		panelProviderConfig = { contextWindow: 110000, actSelection: { modelId: "a3b-coder" } }
	})

	it("is not dirty while the panel matches the profile", () => {
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "mode", mode: "act" }))
		expect(result.current.isDirty).toBe(false)
	})

	it("is dirty once a tool-result cap is set", () => {
		const { result, rerender } = renderHook(() => useApiConfigurationProfiles({ kind: "mode", mode: "act" }))
		expect(result.current.isDirty).toBe(false)

		panelProviderConfig = { ...panelProviderConfig, maxToolResultChars: 32000 }
		rerender()

		expect(result.current.isDirty).toBe(true)
	})

	it("is dirty once a per-turn output cap is set", () => {
		const { result, rerender } = renderHook(() => useApiConfigurationProfiles({ kind: "mode", mode: "act" }))
		expect(result.current.isDirty).toBe(false)

		// Where the per-turn cap actually lands: the committed model selection's
		// overrides, which the provider config response carries per mode.
		panelProviderConfig = {
			contextWindow: 110000,
			actSelection: { modelId: "a3b-coder", overrides: { maxTokens: 4096 } },
		}
		rerender()

		expect(result.current.isDirty).toBe(true)
	})

	it("is dirty once the tool-result cap is cleared", () => {
		panelProviderConfig = { contextWindow: 110000, actSelection: { modelId: "a3b-coder" }, maxToolResultChars: 64000 }
		const { result, rerender } = renderHook(() => useApiConfigurationProfiles({ kind: "mode", mode: "act" }))
		// Against a profile that carries no cap, holding one is already a change.
		expect(result.current.isDirty).toBe(true)

		panelProviderConfig = { contextWindow: 110000, actSelection: { modelId: "a3b-coder" } }
		rerender()
		expect(result.current.isDirty).toBe(false)
	})

	it("is dirty when clearing the last thing providers.json held", () => {
		// Nothing but the cap in the entry: clearing it leaves the panel with
		// nothing to capture, and a snapshot that captured nothing is read as one
		// that has not finished loading.
		panelProviderConfig = { maxToolResultChars: 64000 }
		const { result, rerender } = renderHook(() => useApiConfigurationProfiles({ kind: "mode", mode: "act" }))

		panelProviderConfig = {}
		rerender()
		expect(result.current.isDirty).toBe(true)
	})
})
