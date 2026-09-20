import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { __resetPendingEdits, registerPendingEdit } from "../../utils/pendingEdits"
import ApiConfigurationSection from "../ApiConfigurationSection"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		planActSeparateModelsSetting: true,
		visionModelEnabled: false,
		visionModeApiConfiguration: undefined,
		agentsModelEnabled: false,
		agentsModeApiConfiguration: undefined,
		escalationModelEnabled: false,
		escalationModeApiConfiguration: undefined,
		imageGenEnabled: false,
		imageGenEndpoint: "",
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

// The panels themselves are what this is about only in so far as they unmount.
vi.mock("../../ApiOptions", () => ({ default: () => <div>api options</div> }))
vi.mock("../../ApiConfigProfileBar", () => ({ default: () => <div>profile bar</div> }))
vi.mock("../../VisionModelTab", () => ({ default: () => <div>vision</div> }))
vi.mock("../../AgentsModelTab", () => ({ default: () => <div>agents</div> }))
vi.mock("../../EscalationModelTab", () => ({ default: () => <div>escalation</div> }))
vi.mock("../../ImageGenModelTab", () => ({ default: () => <div>imagegen</div> }))

describe("ApiConfigurationSection", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	afterEach(() => {
		__resetPendingEdits()
	})

	it("saves a field still inside its debounce before switching panel", () => {
		// Switching panel unmounts the one being left. A value typed a moment
		// earlier goes with it unless the write is started first.
		const flush = vi.fn()
		registerPendingEdit({ pending: () => true, flush, discard: () => {} })
		render(<ApiConfigurationSection />)

		fireEvent.click(screen.getByText("Plan Mode"))

		expect(flush).toHaveBeenCalled()
	})

	it("leaves a field alone when it has nothing pending", () => {
		const flush = vi.fn()
		registerPendingEdit({ pending: () => false, flush, discard: () => {} })
		render(<ApiConfigurationSection />)

		fireEvent.click(screen.getByText("Plan Mode"))

		expect(flush).not.toHaveBeenCalled()
	})
})
