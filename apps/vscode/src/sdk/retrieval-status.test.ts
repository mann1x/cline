import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const host = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	cwd: "C:\\Dev\\tally",
	savePath: undefined as string | undefined,
	openPath: undefined as string | undefined,
}))

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalSettingsKey: (key: string) => host.settings[key],
			getSecretKey: () => undefined,
			getApiConfiguration: () => ({}),
		}),
	},
}))
vi.mock("@utils/path", () => ({ getCwd: async () => host.cwd }))
vi.mock("@/hosts/host-provider", () => ({
	HostProvider: {
		window: {
			showMessage: async () => ({}),
			showSaveDialog: async () => ({ selectedPath: host.savePath }),
			showOpenDialogue: async () => ({ paths: host.openPath ? [host.openPath] : [] }),
		},
	},
}))

import { sharedLibrary, sharedMemory } from "@cline/core"
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

	it("answers a request it cannot read with the status and the reason", async () => {
		const result = await runRetrievalAction("{broken")
		expect(result.ok).toBe(false)
		expect(result.status.memory.memories).toHaveLength(1)
		expect((await act({ action: "nonsense" })).error).toBe("Unknown action.")
	})
})
