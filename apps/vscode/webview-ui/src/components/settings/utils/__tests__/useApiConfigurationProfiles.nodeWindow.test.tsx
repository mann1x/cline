import { NODE_MODEL_ID } from "@shared/__tests__/scoped-context-window.fixtures"
import { parseApiConfigurationProfiles } from "@shared/api-config-profiles"
import { scopedContextWindow } from "@shared/api-config-snapshot"
import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useApiConfigurationProfiles } from "../useApiConfigurationProfiles"

// A profile files the committed model's overrides as `modelOverrides`; a
// scoped tab's panel reads `selectedModelOverrides`. Loading a profile into
// Node1 copied its provider config verbatim, so a window it carried only among
// its overrides was stored where nothing on the tab looked -- the box showed a
// default and the agents ran on the catalog's number.

const WINDOW_PROFILE = {
	name: "opencoti / v9 64k",
	updatedAt: 1,
	snapshot: {
		global: {},
		mode: { apiProvider: "opencoti", apiModelId: NODE_MODEL_ID },
		providerConfig: { modelOverrides: { contextWindow: 65_536, maxTokens: 8_000 } },
	},
}

const updateSettings = vi.fn().mockResolvedValue(undefined)

vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({
		config: {},
		write: vi.fn().mockResolvedValue(undefined),
		commitSelection: vi.fn().mockResolvedValue(undefined),
	}),
	readProviderConfig: () => ({}),
	writeProviderConfigFor: vi.fn().mockResolvedValue(undefined),
	toProtobufProviderModelOverrides: (overrides: unknown) => overrides,
}))
vi.mock("../useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldsChange: vi.fn().mockResolvedValue(undefined) }),
}))
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { updateSettings: (...args: unknown[]) => updateSettings(...args) },
	ModelsServiceClient: { commitModelSelection: vi.fn().mockResolvedValue(undefined) },
}))

let extensionState: Record<string, unknown>
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => extensionState }))

function stateWithNode1(node1: string, active = ""): Record<string, unknown> {
	return {
		apiConfiguration: { actModeApiProvider: "ollama", planModeApiProvider: "ollama" },
		apiConfigurationProfiles: JSON.stringify([WINDOW_PROFILE]),
		activeApiConfigurationProfile: active,
		visionModeApiConfiguration: "",
		escalationModeApiConfiguration: "",
		agentsModeApiConfiguration: node1,
		agentNodes: "",
		planActSeparateModelsSetting: false,
	}
}

const EMPTY_NODE1 = JSON.stringify({ global: {}, mode: { apiProvider: "opencoti" } })

function writtenNode1(): { providerConfig?: Record<string, unknown> } {
	const patch = updateSettings.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.find((call) => typeof call.agentsModeApiConfiguration === "string")
	return JSON.parse(patch?.agentsModeApiConfiguration as string)
}

function savedProfile(name: string) {
	const patch = updateSettings.mock.calls
		.map((call) => call[0] as Record<string, unknown>)
		.find((call) => typeof call.apiConfigurationProfiles === "string")
	return parseApiConfigurationProfiles(patch?.apiConfigurationProfiles as string).find((p) => p.name === name)
}

describe("a context window crossing between a profile and an agent node", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		updateSettings.mockResolvedValue(undefined)
		extensionState = stateWithNode1(EMPTY_NODE1)
	})

	it("loads a profile's modelOverrides window into Node1 where the tab reads it", async () => {
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "agents" }))

		await result.current.loadProfile(WINDOW_PROFILE.name)

		const providerConfig = writtenNode1().providerConfig ?? {}
		expect(providerConfig.contextWindow).toBe(65_536)
		expect(providerConfig.selectedModelOverrides).toEqual({ contextWindow: 65_536, maxTokens: 8_000 })
		expect(providerConfig).not.toHaveProperty("modelOverrides")
		expect(providerConfig.selectedModelId).toBe(NODE_MODEL_ID)
		expect(scopedContextWindow(providerConfig)).toBe(65_536)
	})

	// The profile is unchanged by being loaded, so the bar must not ask to
	// update it just because the tab stores the same window under its own keys.
	it("reads the loaded node as matching the profile", async () => {
		const { result: load } = renderHook(() => useApiConfigurationProfiles({ kind: "agents" }))
		await load.current.loadProfile(WINDOW_PROFILE.name)
		extensionState = stateWithNode1(JSON.stringify(writtenNode1()), JSON.stringify({ agents: WINDOW_PROFILE.name }))

		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "agents" }))

		expect(result.current.activeName).toBe(WINDOW_PROFILE.name)
		expect(result.current.isDirty).toBe(false)
	})

	// The reverse: a profile saved from Node1 has to carry the window, under the
	// spelling a load into Plan or Act commits.
	it("saves Node1's window into the profile", async () => {
		extensionState = stateWithNode1(
			JSON.stringify({
				global: {},
				mode: { apiProvider: "opencoti" },
				providerConfig: {
					selectedModelId: NODE_MODEL_ID,
					contextWindow: 128_000,
					selectedModelOverrides: { contextWindow: 128_000, maxTokens: 8_000 },
				},
			}),
		)
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "agents" }))

		await result.current.saveProfile("node1 128k")

		const providerConfig = savedProfile("node1 128k")?.snapshot.providerConfig as Record<string, unknown>
		expect(providerConfig.contextWindow).toBe(128_000)
		expect(providerConfig.modelOverrides).toEqual({ contextWindow: 128_000, maxTokens: 8_000 })
		expect(providerConfig).not.toHaveProperty("selectedModelOverrides")
		expect(providerConfig).not.toHaveProperty("selectedModelId")
	})

	it("saves a window Node1 holds only among its overrides", async () => {
		extensionState = stateWithNode1(
			JSON.stringify({
				global: {},
				mode: { apiProvider: "opencoti" },
				providerConfig: { selectedModelId: NODE_MODEL_ID, selectedModelOverrides: { contextWindow: 98_304 } },
			}),
		)
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "agents" }))

		await result.current.saveProfile("node1 96k")

		const providerConfig = savedProfile("node1 96k")?.snapshot.providerConfig as Record<string, unknown>
		expect(providerConfig.contextWindow).toBe(98_304)
		expect(scopedContextWindow(providerConfig)).toBe(98_304)
	})
})
