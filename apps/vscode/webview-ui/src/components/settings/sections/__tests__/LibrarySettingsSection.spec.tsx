import { DEFAULT_LIBRARY_SETTINGS } from "@cline/shared"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import LibrarySettingsSection, { parseLibrarySettings } from "../LibrarySettingsSection"

const state = {
	libraryEnabled: false,
	librarySettings: "",
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
	library: {
		enabled: true,
		collections: 1,
		documents: 3,
		passages: 40,
		embeddedDocuments: 0,
		vectorSets: [] as Array<Record<string, unknown>>,
	},
	memory: {
		enabled: true,
		memories: [{ name: "main", main: true, notes: 2, createdAt: "2026-10-06T00:00:00.000Z" }] as Array<
			Record<string, unknown>
		>,
		notes: 2,
		embeddedNotes: 0,
		vectorSets: [] as Array<Record<string, unknown>>,
	},
	embedJobs: {} as Record<string, Record<string, unknown>>,
	workspace: { path: "C:\\Dev\\tally", key: "c:/dev/tally", name: "tally" },
	catalogue: {
		sections: [] as Array<Record<string, unknown>>,
		books: 0,
		trash: 0,
		problems: [] as string[],
		librarian: false,
		trashDays: 30,
	},
	scrape: { enabled: false, allowed: false, baseUrl: "", maxPages: 100, maxDepth: 3, keySet: false } as Record<string, unknown>,
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
		state.apiConfigurationProfiles = ""
		status = baseStatus()
		actions.length = 0
		respond = () => ({ ok: true })
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

	const working = () => {
		status = baseStatus()
		status.lancedb = { ...status.lancedb, installed: true, working: true }
		status.embeddingModel = "bge-m3"
		actions.length = 0
		state.libraryEnabled = true
	}

	it("offers to embed what has no vectors for the model now set, and says what that costs meanwhile", async () => {
		working()
		status.library.embeddedDocuments = 1
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		fireEvent.click(await screen.findByText(/Embed 2 documents now/))
		await waitFor(() => expect(actions).toContainEqual({ action: "embedNow", target: "library" }))
		expect(screen.getByText(/2 of 3 documents have no vectors for bge-m3 and are found by keyword only\./)).toBeTruthy()
	})

	it("shows a run's progress in place of the button, and how the last one ended", async () => {
		working()
		status.embedJobs = { library: { target: "library", running: true, done: 1, total: 3 } }
		const { unmount } = render(<LibrarySettingsSection renderSectionHeader={header} />)
		expect(await screen.findByText("Embedding with bge-m3: 1 of 3 documents…")).toBeTruthy()
		expect(screen.queryByText(/documents now/)).toBeNull()
		unmount()

		working()
		status.library.embeddedDocuments = 1
		status.embedJobs = {
			library: { target: "library", running: false, done: 1, total: 3, error: "Embedding stopped after 1 document: 503." },
		}
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		expect(await screen.findByText("Embedding stopped after 1 document: 503.")).toBeTruthy()
		expect(screen.getByText(/Embed 2 documents now/)).toBeTruthy()
	})

	it("lists the sets of vectors on disk, and deletes one not in use after a second click", async () => {
		working()
		status.library.embeddedDocuments = 3
		status.library.vectorSets = [
			{
				table: "vectors_bge_m3_1024",
				model: "bge-m3",
				dimension: 1024,
				vectors: 40,
				documents: 3,
				bytes: 3 * 1024 * 1024,
				current: true,
			},
			{
				table: "vectors_old_768",
				model: "old-embed",
				dimension: 768,
				vectors: 38,
				documents: 3,
				bytes: 2048,
				current: false,
			},
		]
		render(<LibrarySettingsSection renderSectionHeader={header} />)
		expect(await screen.findByText("bge-m3, 1024 dimensions, 40 vectors, 3 MB (in use)")).toBeTruthy()
		expect(screen.getByText("old-embed, 768 dimensions, 38 vectors, 2 KB")).toBeTruthy()
		// Only the set not in use can be deleted.
		expect(screen.getAllByText("Delete")).toHaveLength(1)
		fireEvent.click(screen.getByText("Delete"))
		expect(actions.some((action) => action.action === "deleteVectors")).toBe(false)
		fireEvent.click(screen.getByText("Delete 38 vectors"))
		await waitFor(() =>
			expect(actions).toContainEqual({ action: "deleteVectors", target: "library", table: "vectors_old_768" }),
		)
	})

	describe("the shelves", () => {
		const shelved = () => {
			status.catalogue = {
				sections: [
					{
						id: 1,
						name: "Game development",
						description: "",
						shelves: [
							{ id: 10, sectionId: 1, name: "Godot", description: "", books: 1, passages: 40 },
							{ id: 11, sectionId: 1, name: "Unity", description: "", books: 0, passages: 0 },
						],
					},
				],
				books: 1,
				trash: 1,
				problems: ['"Empty" has no sources'],
				librarian: false,
				trashDays: 30,
			}
			const book = {
				id: 5,
				title: "Godot Tilemaps",
				description: "How tilemaps work.",
				shelfId: 10,
				authors: ["A. Writer"],
				edition: "2nd",
				sources: 2,
				passages: 40,
				web: false,
				updatedAt: "",
			}
			respond = (action) =>
				action.action === "libraryBooks"
					? { ok: true, books: action.shelfId === 10 ? [book] : [] }
					: action.action === "libraryTrash"
						? {
								ok: true,
								books: [
									{
										...book,
										id: 6,
										title: "Old Notes",
										shelfId: undefined,
										trashedAt: "2026-10-01T00:00:00.000Z",
										trashedFrom: "Game development / Godot",
										purgedOn: "2026-10-31",
									},
								],
							}
						: action.action === "libraryBook"
							? {
									ok: true,
									book: {
										...book,
										directory: "C:/data/library/books/abc",
										metadata: {},
										pictures: 3,
										describedPictures: 2,
										sourceList: [
											{ id: 7, kind: "file", name: "tilemaps.epub", bytes: 2_500_000, addedAt: "" },
											{
												id: 8,
												kind: "web",
												name: "Recipes",
												url: "https://example.com/r",
												bytes: 900,
												addedAt: "",
												removedAt: "2026-10-02",
											},
										],
									},
								}
							: { ok: true, message: "Done." }
		}
		const open = async () => {
			state.libraryEnabled = true
			shelved()
			render(<LibrarySettingsSection renderSectionHeader={header} />)
			await screen.findByText("Game development")
		}
		const sent = (name: string) => actions.filter((action) => action.action === name)

		it("says nothing is on the shelves yet, and offers the librarian", async () => {
			state.libraryEnabled = true
			render(<LibrarySettingsSection renderSectionHeader={header} />)
			expect(await screen.findByText(/Nothing on the shelves yet/)).toBeTruthy()
			expect(screen.getByText("0 sections, 0 shelves, 0 books")).toBeTruthy()
			fireEvent.click(screen.getByText("Let the model act as librarian"))
			await waitFor(() => expect(sent("setLibrarian")).toEqual([{ action: "setLibrarian", enabled: true }]))
		})

		it("lists sections and shelves with their counts, and what is wrong", async () => {
			await open()
			expect(screen.getByText("1 section, 2 shelves, 1 book")).toBeTruthy()
			expect(screen.getByText("· 1 book")).toBeTruthy()
			expect(screen.getByText("· 0 books")).toBeTruthy()
			expect(screen.getByText('"Empty" has no sources')).toBeTruthy()
			expect(screen.getByText(/1 book, each kept 30 days/)).toBeTruthy()
		})

		it("opens a shelf to its books, and a book to what it was made from", async () => {
			await open()
			fireEvent.click(screen.getByText("Godot"))
			expect(await screen.findByText("Godot Tilemaps")).toBeTruthy()
			expect(screen.getByText("(2nd)")).toBeTruthy()
			expect(screen.getByText(/A\. Writer · 2 sources, 40 passages/)).toBeTruthy()
			fireEvent.click(screen.getByText("Details"))
			expect(await screen.findByText("How tilemaps work.")).toBeTruthy()
			expect(screen.getByText("C:/data/library/books/abc")).toBeTruthy()
			expect(screen.getByText(/3 pictures, 2 described/)).toBeTruthy()
			expect(screen.getByText(/tilemaps\.epub/)).toBeTruthy()
			// A source taken out is shown struck through, with the way back.
			fireEvent.click(screen.getByText("Restore"))
			await waitFor(() => expect(sent("librarySource")).toEqual([{ action: "librarySource", op: "restore", sourceId: 8 }]))
		})

		it("makes a section and a shelf by name", async () => {
			await open()
			fireEvent.click(screen.getByText("New section"))
			const field = screen.getByLabelText("Name of the new section")
			fireEvent.change(field, { target: { value: "Cooking" } })
			fireEvent.keyDown(field, { key: "Enter" })
			await waitFor(() =>
				expect(sent("librarySection")).toEqual([{ action: "librarySection", op: "create", name: "Cooking" }]),
			)
			fireEvent.click(screen.getByText("New shelf"))
			fireEvent.change(screen.getByLabelText("Name of the new shelf in Game development"), {
				target: { value: "Unreal" },
			})
			fireEvent.click(screen.getByText("Save"))
			await waitFor(() =>
				expect(sent("libraryShelf")).toEqual([{ action: "libraryShelf", op: "create", sectionId: 1, name: "Unreal" }]),
			)
			expect(await screen.findByText("Done.")).toBeTruthy()
		})

		it("renames and moves a book, and deletes it only after a second click", async () => {
			await open()
			fireEvent.click(screen.getByText("Godot"))
			await screen.findByText("Godot Tilemaps")
			fireEvent.change(screen.getByLabelText("Shelf of Godot Tilemaps"), { target: { value: "11" } })
			await waitFor(() => expect(sent("libraryBookEdit")).toEqual([{ action: "libraryBookEdit", bookId: 5, shelfId: 11 }]))
			const row = screen.getByText("Godot Tilemaps").closest("div.py-1") as HTMLElement
			fireEvent.click(Array.from(row.querySelectorAll("vscode-button")).find((b) => b.textContent === "Delete") as Element)
			expect(sent("libraryBookDelete")).toEqual([])
			fireEvent.click(screen.getByText("Move to trash"))
			await waitFor(() => expect(sent("libraryBookDelete")).toEqual([{ action: "libraryBookDelete", bookId: 5 }]))
		})

		it("shows the trash with the day each book goes, restores, and empties after a second click", async () => {
			await open()
			fireEvent.click(screen.getByText("Trash"))
			expect(await screen.findByText("Old Notes")).toBeTruthy()
			expect(screen.getByText(/was on Game development \/ Godot · deleted for good on 2026-10-31/)).toBeTruthy()
			fireEvent.click(screen.getByText("Restore"))
			await waitFor(() => expect(sent("libraryBookRestore")).toEqual([{ action: "libraryBookRestore", bookId: 6 }]))
			fireEvent.click(screen.getByText("Empty"))
			expect(sent("libraryEmptyTrash")).toEqual([])
			fireEvent.click(screen.getByText("Delete 1 book for good"))
			await waitFor(() => expect(sent("libraryEmptyTrash")).toHaveLength(1))
		})

		it("imports, and exports the Library, a section or a shelf", async () => {
			await open()
			fireEvent.click(screen.getByText("Import…"))
			fireEvent.click(screen.getByText("Export all…"))
			await waitFor(() => expect(sent("libraryExport")).toEqual([{ action: "libraryExport" }]))
			expect(sent("libraryImport")).toEqual([{ action: "libraryImport" }])
			const exports = screen.getAllByText("Export")
			fireEvent.click(exports[0])
			fireEvent.click(exports[1])
			await waitFor(() =>
				expect(sent("libraryExport").slice(1)).toEqual([
					{ action: "libraryExport", sectionId: 1 },
					{ action: "libraryExport", shelfId: 10 },
				]),
			)
		})
	})

	describe("pictures", () => {
		it("describes pictures with the Vision tab's model until a profile is picked", async () => {
			state.libraryEnabled = true
			state.apiConfigurationProfiles = JSON.stringify([{ name: "cheap vision", snapshot: {} }])
			render(<LibrarySettingsSection renderSectionHeader={header} />)
			expect(screen.getByText(/With no profile picked, the model on the Vision tab/)).toBeTruthy()
			const dropdown = document.getElementById("library-image-profile") as HTMLSelectElement
			dropdown.value = "cheap vision"
			fireEvent.change(dropdown)
			await waitFor(() => expect(updateSettings).toHaveBeenCalled())
			expect(lastSaved().imageProfile).toBe("cheap vision")
		})

		it("shows a deleted profile as deleted, and hides the choice when describing is off", () => {
			state.libraryEnabled = true
			state.librarySettings = JSON.stringify({ imageProfile: "gone" })
			const { unmount } = render(<LibrarySettingsSection renderSectionHeader={header} />)
			expect(screen.getByText("gone (deleted)")).toBeTruthy()
			unmount()
			state.librarySettings = JSON.stringify({ describeImages: false })
			render(<LibrarySettingsSection renderSectionHeader={header} />)
			expect(document.getElementById("library-image-profile")).toBeNull()
		})
	})
})
