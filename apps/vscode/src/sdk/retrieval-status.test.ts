import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	secrets: {} as Record<string, string | undefined>,
	cwd: "C:\\Dev\\tally",
	savePath: undefined as string | undefined,
	/** The file name the save dialog was opened with. */
	offeredName: undefined as string | undefined,
	openPath: undefined as string | undefined,
}))

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalSettingsKey: (key: string) => host.settings[key],
			getSecretKey: (key: string) => host.secrets[key],
			getApiConfiguration: () => ({}),
			setGlobalState: (key: string, value: unknown) => {
				host.settings[key] = value
			},
			setSecret: (key: string, value: string | undefined) => {
				host.secrets[key] = value
			},
		}),
	},
}))
vi.mock("@utils/path", () => ({ getCwd: async () => host.cwd }))
vi.mock("@/hosts/host-provider", () => ({
	HostProvider: {
		window: {
			showMessage: async () => ({}),
			showSaveDialog: async (request: { options?: { defaultPath?: string } }) => {
				host.offeredName = request.options?.defaultPath
				return { selectedPath: host.savePath }
			},
			showOpenDialogue: async () => ({ paths: host.openPath ? [host.openPath] : [] }),
		},
	},
}))

import { closeSharedCodeIndex, sharedLibrary, sharedMemory } from "@cline/core"
import { readRetrievalStatus, runRetrievalAction } from "./retrieval-status"

describe("what the Library and Memory panels ask of the host", () => {
	let root: string
	const act = (action: Record<string, unknown>) => runRetrievalAction(JSON.stringify(action))

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "retrieval-status-"))
		process.env.CEREBRILINE_DATA_DIR = join(root, "data")
	})
	afterAll(async () => {
		// Both stores, before their folder goes: Windows will not delete a
		// database that is open, and the status opens the Library's as well.
		await sharedMemory().close()
		await sharedLibrary().close()
		await closeSharedCodeIndex()
		delete process.env.CEREBRILINE_DATA_DIR
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
	})

	it("reports LanceDB as not downloaded, the stores as empty, and the workspace by its key", async () => {
		const status = await readRetrievalStatus()
		expect(status.lancedb).toMatchObject({ version: "0.39.0", installed: false, working: false, installing: false })
		expect(status.embeddingModel).toBeUndefined()
		expect(status.library).toEqual({
			enabled: false,
			collections: 0,
			documents: 0,
			passages: 0,
			embeddedDocuments: 0,
			vectorSets: [],
		})
		expect(status.embedJobs).toEqual({})
		expect(status.memory).toMatchObject({ enabled: false, notes: 0, memories: [{ name: "main", main: true, notes: 0 }] })
		expect(status.workspace).toEqual({ path: "C:\\Dev\\tally", key: "c:/dev/tally", name: "tally" })
	})

	it("makes a memory for the workspace, refuses the name twice, and answers with the status after", async () => {
		const made = await act({ action: "createMemory", name: "tally", forWorkspace: true })
		expect(made).toMatchObject({ ok: true, message: 'Made the memory "tally".' })
		expect(made.status.memory.memories).toMatchObject([{ name: "main" }, { name: "tally", workspace: "c:/dev/tally" }])
		const again = await act({ action: "createMemory", name: "tally" })
		expect(again.ok).toBe(false)
		expect(again.error).toContain("already a memory")
		expect(again.status.memory.memories).toHaveLength(2)
	})

	it("writes a memory to the file the user chose and reads it back into another", async () => {
		await sharedMemory().remember({ text: "Tests use node --test.", memory: "tally", tags: ["testing"] })
		// A cancelled dialog writes nothing and says nothing.
		host.savePath = undefined
		expect((await act({ action: "exportMemory", name: "tally" })).message).toBeUndefined()

		host.savePath = join(root, "tally.memory.json")
		const exported = await act({ action: "exportMemory", name: "tally" })
		expect(exported.message).toBe(`Wrote 1 note of "tally" to ${host.savePath}.`)
		expect(JSON.parse(readFileSync(host.savePath, "utf8"))).toMatchObject({
			format: "cerebriline-memory",
			name: "tally",
			notes: [{ text: "Tests use node --test.", tags: ["testing"] }],
		})

		host.openPath = host.savePath
		const imported = await act({ action: "importMemory", into: "main" })
		expect(imported.message).toBe('Read tally.memory.json into "main": 1 added, 0 already there.')
		expect(imported.status.memory.notes).toBe(2)

		host.openPath = join(root, "broken.json")
		writeFileSync(host.openPath, "{not json")
		expect((await act({ action: "importMemory" })).error).toBe("broken.json is not a JSON file.")
		writeFileSync(host.openPath, JSON.stringify({ hello: 1 }))
		expect((await act({ action: "importMemory" })).error).toContain("not an exported memory")
	})

	it("renames a memory and says what it is called now", async () => {
		const renamed = await act({ action: "renameMemory", name: "tally", to: " Tally  app " })
		expect(renamed).toMatchObject({ ok: true, message: 'Renamed "tally" to "Tally app".' })
		expect(renamed.status.memory.memories).toMatchObject([{ name: "main" }, { name: "Tally app", workspace: "c:/dev/tally" }])
		expect((await act({ action: "renameMemory", name: "main", to: "x" })).error).toContain("cannot be renamed")
		await act({ action: "renameMemory", name: "Tally app", to: "tally" })
	})

	it("deletes a memory and its notes, never the main one", async () => {
		const deleted = await act({ action: "deleteMemory", name: "tally" })
		expect(deleted.message).toBe('Deleted the memory "tally" and its 1 note.')
		expect(deleted.status.memory.memories.map((memory) => memory.name)).toEqual(["main"])
		expect((await act({ action: "deleteMemory", name: "main" })).error).toContain("cannot be deleted")
	})

	it("will not start embedding with no embedding model, and says which thing is missing", async () => {
		const result = await act({ action: "embedNow", target: "library" })
		expect(result.ok).toBe(false)
		expect(result.error).toContain("is not ticked")
		expect(result.status.embedJobs).toEqual({})
		expect((await act({ action: "deleteVectors", target: "memory", table: "vectors_x_3" })).error).toBe(
			"There is no such set of vectors.",
		)
	})

	it("builds the open folder's code index only once it is ticked and a model is set", async () => {
		const before = { cwd: host.cwd, settings: { ...host.settings } }
		const folder = mkdtempSync(join(tmpdir(), "retrieval-status-code-"))
		writeFileSync(
			join(folder, "invoice.ts"),
			"export const invoiceTotal = (lines: number[]) => lines.reduce((a, b) => a + b, 0)\n",
		)
		host.cwd = folder
		try {
			expect((await readRetrievalStatus()).codeIndex).toEqual({ enabled: false, files: 0, passages: 0, running: false })
			// Not ticked: nothing is read, whatever is asked.
			const refused = await act({ action: "codeIndexRefresh" })
			expect(refused.ok).toBe(false)
			expect(refused.status.codeIndex.files).toBe(0)

			// Ticked with no embedding model: still nothing, and the reason is the model.
			host.settings.librarySettings = JSON.stringify({ codeIndexWorkspaces: [`${folder}/`] })
			const noModel = await act({ action: "codeIndexRefresh" })
			expect(noModel.error).toContain("is not ticked")
			expect(noModel.status.codeIndex).toMatchObject({ enabled: true, files: 0 })

			host.settings.embeddingEnabled = true
			host.settings.retrievalEndpoints = JSON.stringify({
				useProvider: false,
				embedding: { baseUrl: "http://127.0.0.1:9", model: "embed-test" },
			})
			expect((await act({ action: "codeIndexRefresh" })).ok).toBe(true)
			// Followed through the status, as the panel does.
			let status = (await readRetrievalStatus()).codeIndex
			for (let tries = 0; status.running && tries < 200; tries++) {
				await new Promise((resolve) => setTimeout(resolve, 25))
				status = (await readRetrievalStatus()).codeIndex
			}
			expect(status).toMatchObject({ enabled: true, files: 1, running: false })
			expect(status.passages).toBeGreaterThan(0)
			// LanceDB is not downloaded here, and the panel is told so.
			expect(status.problem).toContain("LanceDB")

			// Unticked, the index is kept until it is deleted.
			host.settings.librarySettings = JSON.stringify({ codeIndexWorkspaces: [] })
			expect((await readRetrievalStatus()).codeIndex).toMatchObject({ enabled: false, files: 1 })
			const deleted = await act({ action: "codeIndexDelete" })
			expect(deleted.message).toBe("Deleted this folder's code index.")
			expect(deleted.status.codeIndex.files).toBe(0)
		} finally {
			host.cwd = before.cwd
			host.settings = before.settings
			rmSync(folder, { recursive: true, force: true })
		}
	})

	it("answers a request it cannot read with the status and the reason", async () => {
		const result = await runRetrievalAction("{broken")
		expect(result.ok).toBe(false)
		expect(result.status.memory.memories).toHaveLength(1)
		expect((await act({ action: "nonsense" })).error).toBe("Unknown action.")
	})
	describe("the Library's shelves", () => {
		const PROSE = Array.from({ length: 60 }, (_unused, n) => `Sentence ${n} about tilemap layers and their cells.`).join(" ")

		it("starts with no shelves, no trash, and the librarian off", async () => {
			const { catalogue, scrape } = await readRetrievalStatus()
			expect(catalogue).toEqual({ sections: [], books: 0, trash: 0, problems: [], librarian: false, trashDays: 30 })
			expect(scrape).toEqual({
				enabled: false,
				allowed: false,
				baseUrl: "",
				maxPages: 100,
				maxDepth: 3,
				librarianOnly: true,
				maxFiles: 2000,
				maxFileMb: 25,
				maxTotalMb: 300,
				keySet: false,
			})
		})

		it("makes sections and shelves, lists a shelf's books, and edits and moves a book", async () => {
			const made = await act({ action: "librarySection", op: "create", name: "Game development" })
			const section = made.status.catalogue.sections[0]
			await act({ action: "libraryShelf", op: "create", sectionId: section.id, name: "Godot" })
			const other = await act({ action: "libraryShelf", op: "create", sectionId: section.id, name: "Unity" })
			const [godot, unity] = other.status.catalogue.sections[0].shelves
			const catalogue = sharedLibrary().catalogue
			const book = catalogue.createBook({ shelfId: godot.id, title: "Tilemaps", metadata: { authors: ["A. Writer"] } })
			await catalogue.addSource(book.id, { kind: "text", name: "notes", text: PROSE })

			const listed = await act({ action: "libraryBooks", shelfId: godot.id })
			expect(listed.books).toMatchObject([{ title: "Tilemaps", authors: ["A. Writer"], sources: 1, web: false }])
			expect(listed.status.catalogue).toMatchObject({ books: 1, trash: 0 })

			await act({ action: "libraryBookEdit", bookId: book.id, title: "Godot Tilemaps", shelfId: unity.id })
			expect((await act({ action: "libraryBooks", shelfId: unity.id })).books).toMatchObject([{ title: "Godot Tilemaps" }])
			const details = await act({ action: "libraryBook", bookId: book.id })
			expect(details.book).toMatchObject({
				title: "Godot Tilemaps",
				pictures: 0,
				sourceList: [{ kind: "text", name: "notes" }],
			})
			expect(details.book?.directory).toContain(join("library", "books"))

			const renamed = await act({ action: "libraryShelf", op: "update", id: unity.id, name: "Engines" })
			expect(renamed.status.catalogue.sections[0].shelves.map((shelf) => shelf.name)).toEqual(["Engines", "Godot"])
			expect((await act({ action: "librarySection", op: "create", name: " " })).error).toContain("needs a name")
		})

		it("sends a deleted book to the trash, and deletes for good only from there", async () => {
			const [book] = sharedLibrary().catalogue.books()
			expect((await act({ action: "libraryBookPurge", bookId: book.id })).error).toContain("Only a book in the trash")
			const deleted = await act({ action: "libraryBookDelete", bookId: book.id })
			expect(deleted.message).toContain("is in the trash for 30 days")
			expect(deleted.status.catalogue).toMatchObject({ books: 0, trash: 1 })
			const trash = await act({ action: "libraryTrash" })
			expect(trash.books).toMatchObject([{ title: "Godot Tilemaps", trashedFrom: "Game development / Engines" }])
			expect(trash.books?.[0].purgedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
			const restored = await act({ action: "libraryBookRestore", bookId: book.id })
			expect(restored.message).toContain("is back on Game development / Engines")
			expect(restored.status.catalogue).toMatchObject({ books: 1, trash: 0 })
		})

		it("exports a shelf to the file chosen and reads it back in", async () => {
			const [book] = sharedLibrary().catalogue.books()
			host.savePath = join(root, "engines.library.tar.gz")
			const exported = await act({ action: "libraryExport", shelfId: book.shelfId })
			expect(exported.message).toContain("Wrote 1 book")
			host.openPath = host.savePath
			expect((await act({ action: "libraryImport" })).message).toContain('left out "Godot Tilemaps" (it is already here)')
			const copied = await act({ action: "libraryImport", existing: "copy" })
			expect(copied.message).toBe("Imported 1 book.")
			expect(copied.status.catalogue.books).toBe(2)
			host.savePath = undefined
			expect((await act({ action: "libraryExport" })).message).toBeUndefined()
			expect(host.offeredName).toBe("library.library.tar.gz")

			// What is ticked: one thing names the file, several are a "selection".
			const shelfId = book.shelfId as number
			host.savePath = join(root, "picked.library.tar.gz")
			const one = await act({ action: "libraryExport", selection: { bookIds: [book.id] } })
			expect(one.message).toContain("Wrote 1 book")
			expect(host.offeredName).toBe("Godot-Tilemaps.library.tar.gz")
			const both = await act({ action: "libraryExport", selection: { shelfIds: [shelfId], bookIds: [book.id] } })
			expect(both.message).toContain("Wrote 2 books")
			expect(host.offeredName).toBe("selection.library.tar.gz")
			// Nothing ticked is the whole Library.
			await act({ action: "libraryExport", selection: {} })
			expect(host.offeredName).toBe("library.library.tar.gz")
		})

		it("empties the trash when asked to", async () => {
			const books = sharedLibrary().catalogue.books()
			await act({ action: "libraryBookDelete", bookId: books[1].id })
			const emptied = await act({ action: "libraryEmptyTrash" })
			expect(emptied.message).toBe("The trash is empty: 1 book deleted.")
			expect(emptied.status.catalogue).toMatchObject({ books: 1, trash: 0 })
		})

		it("turns the librarian on and off", async () => {
			expect((await act({ action: "setLibrarian", enabled: true })).status.catalogue.librarian).toBe(true)
			expect((await act({ action: "setLibrarian", enabled: false })).status.catalogue.librarian).toBe(false)
		})

		it("keeps the scraper's settings, never its key, and says what stops it", async () => {
			const set = await act({
				action: "setScrape",
				enabled: true,
				baseUrl: "192.168.178.2:3002",
				maxPages: 50,
				apiKey: " k ",
			})
			expect(set.status.scrape).toEqual({
				enabled: true,
				allowed: false,
				baseUrl: "192.168.178.2:3002",
				maxPages: 50,
				maxDepth: 3,
				librarianOnly: true,
				maxFiles: 2000,
				maxFileMb: 25,
				maxTotalMb: 300,
				keySet: true,
				problem: "Not allowed yet: tick “Allow web scraping” in the API configuration.",
			})
			expect(JSON.stringify(set)).not.toContain('"k"')
			expect(host.secrets.scrapeApiKey).toBe("k")
			const allowed = await act({ action: "setScrape", allowed: true })
			expect(allowed.status.scrape.problem).toBeUndefined()
			expect(allowed.status.scrape.maxPages).toBe(50)
			// Offered to every task only once the user says so, and it stays said.
			const general = await act({ action: "setScrape", librarianOnly: false })
			expect(general.status.scrape.librarianOnly).toBe(false)
			expect((await act({ action: "setScrape", maxDepth: 2 })).status.scrape).toMatchObject({
				librarianOnly: false,
				maxDepth: 2,
			})
			// What a site crawl may fetch, kept like the rest.
			expect(
				(await act({ action: "setScrape", maxFiles: 500, maxFileMb: 10, maxTotalMb: 100 })).status.scrape,
			).toMatchObject({ maxFiles: 500, maxFileMb: 10, maxTotalMb: 100, maxDepth: 2 })
		})

		it("checks the scraping endpoint with one real request", async () => {
			const seen: { url: string; key: string }[] = []
			const realFetch = globalThis.fetch
			globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
				seen.push({ url: String(input), key: (init?.headers as Record<string, string>).Authorization })
				return Response.json({
					success: true,
					data: {
						html: "<h1>Example Domain</h1>",
						metadata: { sourceURL: "https://example.com/", title: "Example Domain" },
					},
				})
			}) as typeof fetch
			try {
				const checked = await act({ action: "checkScrape" })
				expect(checked.check).toEqual({
					ok: true,
					detail: "Read https://example.com/ (“Example Domain”): 16 characters.",
				})
				expect(seen).toEqual([{ url: "http://192.168.178.2:3002/v2/scrape", key: "Bearer k" }])
				globalThis.fetch = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch
				expect((await act({ action: "checkScrape" })).check).toMatchObject({ ok: false })
			} finally {
				globalThis.fetch = realFetch
			}
		})
	})
})
