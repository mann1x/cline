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

const baseStatus = () => ({
	lancedb: {
		version: "0.39.0",
		platform: "win32-x64",
		installed: false,
		working: false,
		installBytes: 209 * 1024 * 1024,
		root: "C:/data/runtimes/lancedb/0.39.0",
		installing: false,
	} as Record<string, unknown>,
	embeddingModel: undefined as string | undefined,
	embedding: {
		enabled: true,
		useProvider: true,
		model: "",
		problem: "No embedding model is named on the Embedding tab: the field is empty.",
	} as Record<string, unknown>,
	library: { enabled: true, collections: 1, documents: 3, passages: 40, embeddedDocuments: 0 },
	memory: {
		enabled: true,
		memories: [{ name: "main", main: true, notes: 2, createdAt: "2026-10-06T00:00:00.000Z" }] as Array<
			Record<string, unknown>
		>,
		notes: 2,
		embeddedNotes: 0,
	},
	workspace: { path: "C:\\Dev\\tally", key: "c:/dev/tally", name: "tally" },
})
let status = baseStatus()
const actions: Array<Record<string, unknown>> = []
const respond: (action: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true })
const retrievalAction = vi.fn(async (request: { value: string }) => {
	const action = JSON.parse(request.value)
	actions.push(action)
	return { value: JSON.stringify({ ...respond(action), status }) }
})
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: {
		updateSettings: (request: Record<string, unknown>) => updateSettings(request),
		retrievalAction: (request: { value: string }) => retrievalAction(request),
	},
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

	it("says where search by meaning stands and offers the download", async () => {
		status = baseStatus()
		actions.length = 0
		state.libraryEnabled = true
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		expect(await screen.findByText("LanceDB 0.39.0 is not downloaded")).toBeTruthy()
		expect(screen.getByText("3 documents in 1 collection, 40 passages")).toBeTruthy()
		// What stops embedding is said, not a general pointer at the settings.
		expect(
			screen.getByText("none in use. No embedding model is named on the Embedding tab: the field is empty."),
		).toBeTruthy()
		fireEvent.click(screen.getByText("Download LanceDB (about 209 MB)"))
		await waitFor(() => expect(actions).toContainEqual({ action: "installVectors" }))
	})

	it("says so when LanceDB is there and working, and how much has vectors", async () => {
		status = baseStatus()
		status.lancedb = { ...status.lancedb, installed: true, working: true }
		status.embeddingModel = "bge-m3"
		status.library.embeddedDocuments = 2
		state.libraryEnabled = true
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		expect(await screen.findByText("LanceDB 0.39.0 is downloaded and working")).toBeTruthy()
		expect(screen.getByText("bge-m3, 2 of 3 documents have vectors")).toBeTruthy()
		expect(screen.queryByText(/Download LanceDB/)).toBeNull()
	})

	it("shows why LanceDB did not load, and that a download is running", async () => {
		status = baseStatus()
		status.lancedb = { ...status.lancedb, installed: true, working: false, error: "invalid ELF header" }
		state.libraryEnabled = true
		const { unmount } = render(<LibrarySettingsSection renderSectionHeader={header} />)
		expect(await screen.findByText("LanceDB 0.39.0 is downloaded but did not load: invalid ELF header")).toBeTruthy()
		unmount()
		status = baseStatus()
		status.lancedb = { ...status.lancedb, installing: true, progress: { packageIndex: 4, packageCount: 27 } }
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		expect(await screen.findByText("Downloading LanceDB 0.39.0: package 5 of 27")).toBeTruthy()
		expect(screen.queryByText(/^Download LanceDB/)).toBeNull()
	})
})
