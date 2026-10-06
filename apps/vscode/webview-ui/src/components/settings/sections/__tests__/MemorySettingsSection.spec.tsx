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
let respond: (action: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true })
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

const header = () => <div>Memory</div>

describe("the Memory panel", () => {
	beforeEach(() => {
		state.memoryEnabled = false
		state.memorySettings = ""
		state.embeddingEnabled = false
		state.retrievalEndpoints = ""
		state.apiConfigurationProfiles = ""
		updateSettings.mockClear()
		status = baseStatus()
		actions.length = 0
		respond = () => ({ ok: true })
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

	const saved = () => JSON.parse(String(updateSettings.mock.calls.at(-1)?.[0].memorySettings))

	it("lists the memories with the main one searched and stored to, and counts the notes", async () => {
		state.memoryEnabled = true
		render(<MemorySettingsSection renderSectionHeader={header} />)
		expect(await screen.findByText("2 notes in 1 memory")).toBeTruthy()
		expect(screen.getByText("the memory every workspace starts on")).toBeTruthy()
		expect((screen.getByLabelText("Recall from main") as HTMLInputElement).checked).toBe(true)
		expect((screen.getByLabelText("Store to main") as HTMLInputElement).checked).toBe(true)
		// The main memory can be exported, never deleted.
		expect(screen.getByText("Export")).toBeTruthy()
		expect(screen.queryByText("Delete")).toBeNull()
	})

	it("files this workspace's choice under the workspace, one memory to store and any number to recall", async () => {
		state.memoryEnabled = true
		status.memory.memories.push(
			{ name: "acme", main: false, notes: 5, createdAt: "", workspace: "c:/dev/acme" },
			{ name: "tally", main: false, notes: 0, createdAt: "", workspace: "c:/dev/tally" },
		)
		render(<MemorySettingsSection renderSectionHeader={header} />)
		expect(await screen.findByText("made for c:/dev/acme")).toBeTruthy()
		expect(screen.getByText("made for this workspace")).toBeTruthy()
		// A workspace that has its own memory is not offered another.
		expect(screen.queryByText(/Create a memory for this workspace/)).toBeNull()

		fireEvent.click(screen.getByLabelText("Recall from acme"))
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		expect(saved().selections).toEqual({ "c:/dev/tally": { store: "main", recall: ["main", "acme"] } })

		fireEvent.click(screen.getByLabelText("Store to tally"))
		await waitFor(() => expect(saved().selections["c:/dev/tally"].store).toBe("tally"))
	})

	it("shows another workspace's choice untouched, and warns when nothing is searched", async () => {
		state.memoryEnabled = true
		state.memorySettings = JSON.stringify({
			selections: { "/elsewhere": { store: "x", recall: ["x"] }, "c:/dev/tally": { store: "main", recall: [] } },
		})
		render(<MemorySettingsSection renderSectionHeader={header} />)
		expect(await screen.findByText(/No memory is ticked for recall/)).toBeTruthy()
		fireEvent.click(screen.getByLabelText("Recall from main"))
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		expect(saved().selections).toEqual({
			"/elsewhere": { store: "x", recall: ["x"] },
			"c:/dev/tally": { store: "main", recall: ["main"] },
		})
	})

	it("offers a memory for a workspace that has none, and ticks it for recall only", async () => {
		state.memoryEnabled = true
		respond = (action) => {
			if (action.action === "createMemory") {
				status.memory.memories.push({ name: "tally", main: false, notes: 0, createdAt: "", workspace: "c:/dev/tally" })
				return { ok: true, message: 'Made the memory "tally".' }
			}
			return { ok: true }
		}
		render(<MemorySettingsSection renderSectionHeader={header} />)
		fireEvent.click(await screen.findByText("Create a memory for this workspace (tally)"))
		await waitFor(() => expect(actions).toContainEqual({ action: "createMemory", name: "tally", forWorkspace: true }))
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		expect(saved().selections["c:/dev/tally"]).toEqual({ store: "main", recall: ["main", "tally"] })
		expect(await screen.findByText('Made the memory "tally".')).toBeTruthy()
	})

	it("ticks a memory made by name for recall too", async () => {
		state.memoryEnabled = true
		respond = (action) => {
			if (action.action === "createMemory") {
				status.memory.memories.push({ name: String(action.name), main: false, notes: 0, createdAt: "" })
			}
			return { ok: true }
		}
		render(<MemorySettingsSection renderSectionHeader={header} />)
		const field = await screen.findByPlaceholderText("A name, e.g. a client or a topic")
		fireEvent.change(field, { target: { value: "acme" } })
		fireEvent.input(field, { target: { value: "acme" } })
		await waitFor(() => {
			fireEvent.click(screen.getByText("Create"))
			expect(actions).toContainEqual({ action: "createMemory", name: "acme" })
		})
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		expect(saved().selections["c:/dev/tally"]).toEqual({ store: "main", recall: ["main", "acme"] })
	})

	it("renames a memory and carries the new name into every workspace's choice", async () => {
		state.memoryEnabled = true
		status.memory.memories.push({ name: "acme", main: false, notes: 5, createdAt: "" })
		state.memorySettings = JSON.stringify({
			selections: {
				"c:/dev/tally": { store: "acme", recall: ["main", "acme"] },
				"/elsewhere": { store: "main", recall: ["acme"] },
			},
		})
		respond = (action) => {
			if (action.action === "renameMemory") {
				status.memory.memories = status.memory.memories.map((memory) =>
					memory.name === "acme" ? { ...memory, name: "Acme Corp" } : memory,
				)
				return { ok: true, message: 'Renamed "acme" to "Acme Corp".' }
			}
			return { ok: true }
		}
		render(<MemorySettingsSection renderSectionHeader={header} />)
		// Main has no Rename: there is one button, the other memory's.
		fireEvent.click(await screen.findByText("Rename"))
		fireEvent.change(screen.getByLabelText("New name for acme"), { target: { value: "Acme Corp" } })
		fireEvent.click(screen.getByText("Save"))
		await waitFor(() => expect(actions).toContainEqual({ action: "renameMemory", name: "acme", to: "Acme Corp" }))
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		expect(saved().selections).toEqual({
			"c:/dev/tally": { store: "Acme Corp", recall: ["main", "Acme Corp"] },
			"/elsewhere": { store: "main", recall: ["Acme Corp"] },
		})
	})

	it("deletes a memory only after a second click that says how many notes go, and moves the choice off it", async () => {
		state.memoryEnabled = true
		status.memory.memories.push({ name: "acme", main: false, notes: 5, createdAt: "" })
		state.memorySettings = JSON.stringify({
			selections: { "c:/dev/tally": { store: "acme", recall: ["main", "acme"] } },
		})
		respond = (action) => {
			if (action.action === "deleteMemory") {
				status.memory.memories = status.memory.memories.filter((memory) => memory.name !== "acme")
			}
			return { ok: true }
		}
		render(<MemorySettingsSection renderSectionHeader={header} />)
		fireEvent.click(await screen.findByText("Delete"))
		expect(actions.some((action) => action.action === "deleteMemory")).toBe(false)
		fireEvent.click(screen.getByText("Delete 5 notes"))
		await waitFor(() => expect(actions).toContainEqual({ action: "deleteMemory", name: "acme" }))
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		expect(saved().selections["c:/dev/tally"]).toEqual({ store: "main", recall: ["main"] })
	})

	it("exports and imports through the host, and shows why an import failed", async () => {
		state.memoryEnabled = true
		respond = (action) =>
			action.action === "importMemory" ? { ok: false, error: "notes.json is not a JSON file." } : { ok: true }
		render(<MemorySettingsSection renderSectionHeader={header} />)
		fireEvent.click(await screen.findByText("Export"))
		await waitFor(() => expect(actions).toContainEqual({ action: "exportMemory", name: "main" }))
		fireEvent.click(screen.getByText("Import…"))
		expect(await screen.findByText("notes.json is not a JSON file.")).toBeTruthy()
	})
})
