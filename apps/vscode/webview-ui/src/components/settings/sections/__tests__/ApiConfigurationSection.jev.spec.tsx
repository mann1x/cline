import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ApiConfigurationSection from "../ApiConfigurationSection"

const state = { jevEnabled: false, jevApiKeySet: false }

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		planActSeparateModelsSetting: false,
		visionModelEnabled: false,
		visionModeApiConfiguration: undefined,
		agentsModelEnabled: false,
		agentsModeApiConfiguration: undefined,
		escalationModelEnabled: false,
		escalationModeApiConfiguration: undefined,
		imageGenEnabled: false,
		imageGenEndpoint: "",
		jevEnabled: state.jevEnabled,
		jevSettings: "",
		jevApiKeySet: state.jevApiKeySet,
		mode: "act",
		apiConfiguration: {},
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { updateSettings: vi.fn() },
}))

vi.mock("../../utils/useApiConfigurationHandlers", () => ({
	useApiConfigurationHandlers: () => ({ handleFieldsChange: vi.fn() }),
}))

vi.mock("../../ApiOptions", () => ({ default: () => <div>api options</div> }))
vi.mock("../../ApiConfigProfileBar", () => ({ default: () => <div>profile bar</div> }))
vi.mock("../../JevTab", () => ({ default: () => <div>jev tab content</div> }))

describe("ApiConfigurationSection: Jev", () => {
	beforeEach(() => {
		state.jevEnabled = false
		state.jevApiKeySet = false
	})

	it("offers the checkbox below image generation, with no tab until it is ticked", () => {
		render(<ApiConfigurationSection />)

		expect(screen.getByText("Use Jev for confidence")).toBeTruthy()
		expect(screen.queryByText("Jev")).toBeNull()
	})

	it("shows the Jev tab when ticked, and says a key is missing", () => {
		state.jevEnabled = true
		render(<ApiConfigurationSection />)

		expect(screen.getByText(/No Jev API key is stored/)).toBeTruthy()
		fireEvent.click(screen.getByText("Jev"))
		expect(screen.getByText("jev tab content")).toBeTruthy()
	})

	it("drops the warning once a key is stored", () => {
		state.jevEnabled = true
		state.jevApiKeySet = true
		render(<ApiConfigurationSection />)

		expect(screen.queryByText(/No Jev API key is stored/)).toBeNull()
	})
})
