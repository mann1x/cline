import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useApiConfigurationProfiles } from "../useApiConfigurationProfiles"

// The model a profile is for lives in two places: the settings snapshot
// (`ollamaModelId`) and the provider store's per-mode selection. The panel and
// the session both read the SECOND one — so a load that writes only the first
// leaves the picker on the previous model with nothing marked unsaved.

const PROFILE = {
	name: "ollama / a3b-coder",
	updatedAt: 1,
	snapshot: {
		global: { ollamaApiOptionsCtxNum: "110000" },
		mode: { ollamaModelId: "a3b-coder_tb:iq2_xs", apiProvider: "ollama" },
		providerConfig: { contextWindow: 110000 },
	},
}

const SWITCHING_PROFILE = {
	name: "sap / sonnet",
	updatedAt: 2,
	snapshot: {
		global: {},
		mode: { apiModelId: "sap-sonnet", apiProvider: "sapaicore" },
	},
}

const commitSelection = vi.fn().mockResolvedValue(undefined)
const writeProviderConfig = vi.fn().mockResolvedValue(undefined)
const handleFieldsChange = vi.fn().mockResolvedValue(undefined)
const updateSettings = vi.fn().mockResolvedValue(undefined)
const commitModelSelection = vi.fn().mockResolvedValue(undefined)
// Hoisted, unlike the mocks above it: those are reached lazily from inside a
// factory function, while this one is named directly in the returned object and
// so is read while `vi.mock` is still being hoisted past its declaration.
const writeProviderConfigFor = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({
		config: { contextWindow: 110000 },
		write: writeProviderConfig,
		commitSelection,
	}),
	writeProviderConfigFor,
}))

vi.mock("../useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldsChange }),
}))

vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { updateSettings: (...args: unknown[]) => updateSettings(...args) },
	ModelsServiceClient: { commitModelSelection: (...args: unknown[]) => commitModelSelection(...args) },
}))

const extensionState = {
	apiConfiguration: {
		actModeApiProvider: "ollama",
		actModeOllamaModelId: "v7-coder_tb:cd-q2_k",
		planModeApiProvider: "ollama",
		planModeOllamaModelId: "v7-coder_tb:cd-q2_k",
	},
	apiConfigurationProfiles: JSON.stringify([PROFILE, SWITCHING_PROFILE]),
	activeApiConfigurationProfile: "",
	visionModeApiConfiguration: "",
	planActSeparateModelsSetting: false,
}

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState,
}))

describe("useApiConfigurationProfiles — loading a profile", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// clearAllMocks keeps implementations, and one test replaces them.
		handleFieldsChange.mockResolvedValue(undefined)
		writeProviderConfig.mockResolvedValue(undefined)
		commitSelection.mockResolvedValue(undefined)
		updateSettings.mockResolvedValue(undefined)
		commitModelSelection.mockResolvedValue(undefined)
	})

	it("commits the profile's model to the provider store, not just the settings", async () => {
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "mode", mode: "act" }))

		await result.current.loadProfile(PROFILE.name)

		// Both modes, because Plan and Act are kept identical here.
		await waitFor(() => expect(commitSelection).toHaveBeenCalledTimes(2))
		expect(commitSelection).toHaveBeenCalledWith("plan", {
			providerId: "ollama",
			modelId: "a3b-coder_tb:iq2_xs",
		})
		expect(commitSelection).toHaveBeenCalledWith("act", {
			providerId: "ollama",
			modelId: "a3b-coder_tb:iq2_xs",
		})
		// And the settings copy still gets written, so the two agree.
		expect(handleFieldsChange).toHaveBeenCalledOnce()
	})

	it("writes providers.json after the settings copy and before the model", async () => {
		// The store mirrors the Ollama context window into the legacy settings
		// key, so a providers.json write that lands first is followed by the
		// profile's own copy of that key overwriting the mirror. It still has to
		// precede the model, so that a turn starting in between runs the
		// profile's sampler rather than the previous one.
		const order: string[] = []
		handleFieldsChange.mockImplementation(async () => {
			order.push("settings")
		})
		writeProviderConfig.mockImplementation(async () => {
			order.push("providerConfig")
		})
		commitSelection.mockImplementation(async () => {
			order.push("model")
		})

		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "mode", mode: "act" }))

		await result.current.loadProfile(PROFILE.name)

		await waitFor(() => expect(order).toContain("model"))
		expect(order.slice(0, 3)).toEqual(["settings", "providerConfig", "model"])
	})

	it("goes around the bound hook when the profile also switches provider", async () => {
		// `commitSelection` is bound to the provider the panel was showing and
		// throws on a mismatch, so the switch has to go direct.
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "mode", mode: "act" }))

		await result.current.loadProfile(SWITCHING_PROFILE.name)

		await waitFor(() => expect(commitModelSelection).toHaveBeenCalledTimes(2))
		expect(commitSelection).not.toHaveBeenCalled()
		expect(commitModelSelection.mock.calls[0][0]).toMatchObject({
			providerId: "sapaicore",
			modelId: "sap-sonnet",
		})
		// The provider config has to go around the bound hook for the same
		// reason the model does. It did not: the incoming profile's context
		// window was written onto the entry of the provider being *left*, while
		// the profile's own entry kept the number it already had — a profile
		// whose context window "still matches the main profile" from outside.
		expect(writeProviderConfig).not.toHaveBeenCalled()
		expect(writeProviderConfigFor.mock.calls[0][0]).toBe("sapaicore")
	})

	// A profile that stores no context window must not inherit the one the last
	// profile left in the shared provider entry. Cleared, so it falls back to
	// what the model itself declares rather than to whoever was loaded before.
	it("clears the context window for a profile that carries none", async () => {
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "mode", mode: "act" }))

		await result.current.loadProfile(SWITCHING_PROFILE.name)

		await waitFor(() => expect(writeProviderConfigFor).toHaveBeenCalled())
		expect(writeProviderConfigFor.mock.calls[0][1]).toMatchObject({ contextWindow: undefined })
	})

	it("carries the model into the vision snapshot, where that tab's picker reads it", async () => {
		// The vision tab keeps its selection in its own snapshot rather than in
		// providers.json; without this it fell back to the first model in the list.
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "vision" }))

		await result.current.loadProfile(PROFILE.name)

		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		const written = JSON.parse(updateSettings.mock.calls[0][0].visionModeApiConfiguration)
		expect(written.providerConfig.selectedModelId).toBe("a3b-coder_tb:iq2_xs")
		expect(written.providerConfig.contextWindow).toBe(110000)
		expect(commitSelection).not.toHaveBeenCalled()
	})
})
