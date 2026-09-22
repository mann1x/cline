import { PRIMARY_AGENT_NODE_ID, parseAgentNodes } from "@shared/agent-nodes"
import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useApiConfigurationProfiles } from "../useApiConfigurationProfiles"

// A profile bar sits above the Agents tab, outside it, and every agent node is
// a configuration of its own. Standing on Node2 and loading a profile has to
// land on Node2 -- before this, both the read and the write went to
// `agentsModeApiConfiguration`, so the bar showed Node1's settings and loading
// replaced Node1's configuration with no warning and no way back.

const NODE_PROFILE = {
	name: "ollama / small",
	updatedAt: 1,
	snapshot: { global: {}, mode: { ollamaModelId: "small:q4", apiProvider: "ollama" } },
}

const updateSettings = vi.fn().mockResolvedValue(undefined)
const commitSelection = vi.fn().mockResolvedValue(undefined)

vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({ config: {}, write: vi.fn().mockResolvedValue(undefined), commitSelection }),
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

const NODE1 = '{"global":{},"mode":{"apiProvider":"ollama","ollamaModelId":"lead:q8"}}'
const NODE2 = '{"global":{},"mode":{"apiProvider":"ollama","ollamaModelId":"worker:q4"}}'

const extensionState = {
	apiConfiguration: { actModeApiProvider: "ollama", planModeApiProvider: "ollama" },
	apiConfigurationProfiles: JSON.stringify([NODE_PROFILE]),
	activeApiConfigurationProfile: "",
	visionModeApiConfiguration: "",
	escalationModeApiConfiguration: "",
	agentsModeApiConfiguration: NODE1,
	agentNodes: JSON.stringify([
		{ id: PRIMARY_AGENT_NODE_ID, priority: 1 },
		{ id: "b", priority: 2, snapshot: NODE2 },
	]),
	planActSeparateModelsSetting: false,
}

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => extensionState }))

describe("the profile bar on an agent node", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		updateSettings.mockResolvedValue(undefined)
	})

	// What the bar is reading is observable through what a save captures.
	const savedSnapshot = () => {
		const patch = updateSettings.mock.calls
			.map((call) => call[0] as Record<string, unknown>)
			.find((call) => typeof call.apiConfigurationProfiles === "string")
		return patch?.apiConfigurationProfiles as string
	}

	it("reads Node1's configuration when no node is named", async () => {
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "agents" }))

		await result.current.saveProfile("captured")

		expect(savedSnapshot()).toContain("lead:q8")
		expect(savedSnapshot()).not.toContain("worker:q4")
	})

	it("reads the node's own configuration when one is named", async () => {
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "agents", nodeId: "b" }))

		await result.current.saveProfile("captured")

		expect(savedSnapshot()).toContain("worker:q4")
		expect(savedSnapshot()).not.toContain("lead:q8")
	})

	// The one that matters: the write.
	it("loads a profile into the node, leaving Node1 alone", async () => {
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "agents", nodeId: "b" }))

		await result.current.loadProfile(NODE_PROFILE.name)

		const wrote = updateSettings.mock.calls.map((call) => call[0] as Record<string, unknown>)
		// Nothing may touch the key Node1 lives in.
		expect(wrote.some((patch) => patch.agentsModeApiConfiguration !== undefined)).toBe(false)

		const nodesPatch = wrote.find((patch) => typeof patch.agentNodes === "string")
		expect(nodesPatch).toBeTruthy()
		const nodes = parseAgentNodes(nodesPatch?.agentNodes as string)
		expect(nodes.find((node) => node.id === "b")?.snapshot).toContain("small:q4")
	})

	it("still writes Node1 through its own key", async () => {
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "agents" }))

		await result.current.loadProfile(NODE_PROFILE.name)

		const wrote = updateSettings.mock.calls.map((call) => call[0] as Record<string, unknown>)
		expect(wrote.some((patch) => typeof patch.agentsModeApiConfiguration === "string")).toBe(true)
		expect(wrote.some((patch) => patch.agentNodes !== undefined)).toBe(false)
	})

	// Two nodes are two configurations, so the profile named as active on one
	// says nothing about the other.
	it("keeps the active profile name per node", async () => {
		const { result } = renderHook(() => useApiConfigurationProfiles({ kind: "agents", nodeId: "b" }))

		await result.current.loadProfile(NODE_PROFILE.name)

		const names = updateSettings.mock.calls
			.map((call) => (call[0] as Record<string, unknown>).activeApiConfigurationProfile)
			.filter((value): value is string => typeof value === "string")
		expect(names.length).toBeGreaterThan(0)
		expect(names.join(" ")).toContain("agents::b")
	})
})
