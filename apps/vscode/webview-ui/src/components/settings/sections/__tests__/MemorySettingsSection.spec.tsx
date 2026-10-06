import { DEFAULT_MEMORY_SETTINGS } from "@cline/shared"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MemorySettingsSection, { parseMemorySettings } from "../MemorySettingsSection"

const state = { memoryEnabled: false, memorySettings: "", embeddingEnabled: false, retrievalEndpoints: "" }

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ ...state }),
}))

const updateSettings = vi.fn(async (_request: Record<string, unknown>) => ({}))
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { updateSettings: (request: Record<string, unknown>) => updateSettings(request) },
}))

const header = () => <div>Memory</div>

describe("the Memory panel", () => {
	beforeEach(() => {
		state.memoryEnabled = false
		state.memorySettings = ""
		state.embeddingEnabled = false
		state.retrievalEndpoints = ""
		updateSettings.mockClear()
	})

	it("reads nothing, and anything unreadable, as the defaults", () => {
		expect(parseMemorySettings(undefined)).toEqual(DEFAULT_MEMORY_SETTINGS)
		expect(parseMemorySettings("{broken")).toEqual(DEFAULT_MEMORY_SETTINGS)
	})

	it("shows only the switch while Memory is off, and turns it on through its own setting", async () => {
		render(<MemorySettingsSection renderSectionHeader={header} />)
		expect(screen.queryByText("Notes a recall returns")).toBeNull()
		fireEvent.click(screen.getByText("Enable Memory"))
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		expect(updateSettings.mock.calls[0][0]).toMatchObject({ memoryEnabled: true })
	})

	it("says notes are found by keyword until an embedding model is named", () => {
		state.memoryEnabled = true
		render(<MemorySettingsSection renderSectionHeader={header} />)
		expect(screen.getByText(/Notes are found by keyword\. Tick/)).toBeTruthy()
		expect(screen.getByText("Notes a recall returns")).toBeTruthy()
		expect(screen.getByText("Where a note is kept when the model does not say")).toBeTruthy()
	})

	it("names the embedding model it shares with the Library", () => {
		state.memoryEnabled = true
		state.embeddingEnabled = true
		state.retrievalEndpoints = JSON.stringify({ embedding: { baseUrl: "http://h", model: "bge-m3" } })
		render(<MemorySettingsSection renderSectionHeader={header} />)
		expect(screen.getByText("Notes are found by keyword and by meaning, embedding with bge-m3.")).toBeTruthy()
	})
})
