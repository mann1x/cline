import { DEFAULT_MEMORY_SETTINGS } from "@cline/shared"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MemorySettingsSection, { parseMemorySettings } from "../MemorySettingsSection"

const state = {
	memoryEnabled: false,
	memorySettings: "",
	embeddingEnabled: false,
	retrievalEndpoints: "",
	apiConfigurationProfiles: "",
}

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
		state.apiConfigurationProfiles = ""
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

	it("recalls automatically by default, and offers the expansion only then", () => {
		state.memoryEnabled = true
		render(<MemorySettingsSection renderSectionHeader={header} />)
		expect(screen.getByText("Recall automatically")).toBeTruthy()
		expect(screen.getByText("Expand the question first (HyDE)")).toBeTruthy()
		expect(screen.queryByText("Profile whose model writes it")).toBeNull()
	})

	it("hides the expansion while automatic recall is off", () => {
		state.memoryEnabled = true
		state.memorySettings = JSON.stringify({ autoRecall: false, hyde: true })
		render(<MemorySettingsSection renderSectionHeader={header} />)
		expect(screen.queryByText("Expand the question first (HyDE)")).toBeNull()
	})

	it("turns the expansion on in the record, keeping the other settings", async () => {
		state.memoryEnabled = true
		state.memorySettings = JSON.stringify({ recallCount: 8 })
		render(<MemorySettingsSection renderSectionHeader={header} />)
		fireEvent.click(screen.getByText("Expand the question first (HyDE)"))
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		const saved = JSON.parse(String(updateSettings.mock.calls[0][0].memorySettings))
		expect(saved).toMatchObject({ hyde: true, autoRecall: true, recallCount: 8 })
		expect(saved.enabled).toBeUndefined()
	})

	it("lists the saved profiles, says so when there are none, and shows a deleted one as deleted", () => {
		state.memoryEnabled = true
		state.memorySettings = JSON.stringify({ hyde: true })
		const { unmount } = render(<MemorySettingsSection renderSectionHeader={header} />)
		expect(screen.getByText(/There are no saved profiles yet/)).toBeTruthy()
		unmount()

		state.apiConfigurationProfiles = JSON.stringify([
			{ name: "cheap cloud", updatedAt: 1, snapshot: { global: {}, mode: {} } },
		])
		state.memorySettings = JSON.stringify({ hyde: true, hydeProfile: "gone" })
		render(<MemorySettingsSection renderSectionHeader={header} />)
		expect(screen.getByText("cheap cloud")).toBeTruthy()
		expect(screen.getByText("gone (deleted)")).toBeTruthy()
		expect(screen.getByText(/Until a saved profile is picked/)).toBeTruthy()
	})
})
