import { DEFAULT_LIBRARY_SETTINGS } from "@cline/shared"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import LibrarySettingsSection, { parseLibrarySettings } from "../LibrarySettingsSection"

const state = {
	libraryEnabled: false,
	librarySettings: "",
	embeddingEnabled: false,
	retrievalEndpoints: "",
}

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ ...state }),
}))

const updateSettings = vi.fn(async (_request: Record<string, unknown>) => ({}))
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { updateSettings: (request: Record<string, unknown>) => updateSettings(request) },
}))

const header = () => <div>Library</div>
const lastSaved = () => JSON.parse(String(updateSettings.mock.calls.at(-1)?.[0].librarySettings))

describe("parseLibrarySettings", () => {
	it("reads nothing, and anything unreadable, as the defaults", () => {
		expect(parseLibrarySettings(undefined)).toEqual(DEFAULT_LIBRARY_SETTINGS)
		expect(parseLibrarySettings("{broken")).toEqual(DEFAULT_LIBRARY_SETTINGS)
		expect(parseLibrarySettings("[]").chunkSize).toBe(1500)
	})
})

describe("the Library panel", () => {
	beforeEach(() => {
		state.libraryEnabled = false
		state.librarySettings = ""
		state.embeddingEnabled = false
		state.retrievalEndpoints = ""
		updateSettings.mockClear()
	})

	it("shows only the switch while the Library is off", () => {
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		expect(screen.getByText("Enable the Library")).toBeTruthy()
		expect(screen.queryByText("Splitting documents")).toBeNull()
		expect(screen.queryByText("Hybrid search")).toBeNull()
	})

	it("turns the Library on through its own setting", async () => {
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		fireEvent.click(screen.getByText("Enable the Library"))
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		expect(updateSettings.mock.calls[0][0]).toMatchObject({ libraryEnabled: true })
	})

	it("says it searches by keyword until an embedding model is named", () => {
		state.libraryEnabled = true
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		expect(screen.getByText(/Searching by keyword\. Tick “Use an embedding model”/)).toBeTruthy()
		expect(screen.getByText("Splitting documents")).toBeTruthy()
		expect(screen.getByText("50% meaning · 50% keywords")).toBeTruthy()
	})

	it("names the models in use", () => {
		state.libraryEnabled = true
		state.embeddingEnabled = true
		state.retrievalEndpoints = JSON.stringify({
			embedding: { baseUrl: "http://h", model: "snowflake-arctic-embed2" },
			reranking: { baseUrl: "http://r", model: "bge-reranker-v2-m3", enabled: true },
		})
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		expect(
			screen.getByText(
				"Searching by keyword and by meaning, embedding with snowflake-arctic-embed2, and reranking with bge-reranker-v2-m3.",
			),
		).toBeTruthy()
	})

	it("ignores a filled-in Embedding tab while its box is unticked", () => {
		state.libraryEnabled = true
		state.retrievalEndpoints = JSON.stringify({ embedding: { baseUrl: "http://h", model: "m" } })
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		expect(screen.getByText(/Searching by keyword\. Tick/)).toBeTruthy()
	})

	it("saves a change over the values in use, without the switch", async () => {
		state.libraryEnabled = true
		state.librarySettings = JSON.stringify({ ...DEFAULT_LIBRARY_SETTINGS, enabled: true, topK: 8 })
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		fireEvent.click(screen.getByText("Hybrid search"))
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		const saved = lastSaved()
		expect(saved.hybridSearch).toBe(false)
		expect(saved.topK).toBe(8)
		expect(saved.chunkSize).toBe(1500)
		expect("enabled" in saved).toBe(false)
	})

	it("measures in the unit the splitter uses", () => {
		state.libraryEnabled = true
		state.librarySettings = JSON.stringify({ splitter: "tokens" })
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		expect(screen.getByText("Passage size (tokens)")).toBeTruthy()
		expect(screen.getByText("Overlap (tokens)")).toBeTruthy()
	})
})
