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

vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({
		config: { contextWindow: 110000 },
		write: writeProviderConfig,
		commitSelection,
	}),
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
