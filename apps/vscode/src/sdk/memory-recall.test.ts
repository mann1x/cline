import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	secrets: {} as Record<string, string>,
	built: [] as Array<{ configuration: Record<string, unknown>; options: Record<string, unknown> | undefined }>,
	chunks: [] as Array<Record<string, unknown>>,
	sent: [] as Array<{ system: string; messages: unknown }>,
}))

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalSettingsKey: (key: string) => state.settings[key],
			getSecretKey: (key: string) => state.secrets[key],
			getApiConfiguration: () => ({}),
		}),
	},
}))

vi.mock("./sdk-api-handler", () => ({
	buildApiHandler: (configuration: Record<string, unknown>, _mode: string, options?: Record<string, unknown>) => {
		state.built.push({ configuration, options })
		return {
			setAbortSignal: () => {},
			createMessage: async function* (system: string, messages: unknown) {
				state.sent.push({ system, messages })
				for (const chunk of state.chunks) {
					yield chunk
				}
			},
		}
	},
}))

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { closeSharedMemories, sharedMemory } from "@cline/core"
import { readMemoryQueryExpander, runMemoryMaintenance } from "./memory-recall"

const profile = (name: string) => ({
	name,
	updatedAt: 1,
	snapshot: {
		global: { ollamaBaseUrl: "https://ollama.com" },
		mode: { apiProvider: "ollama", ollamaModelId: "gemma4:31b-cloud" },
		providerConfig: { selectedModelId: "gemma4:31b-cloud", contextWindow: 16384 },
	},
})

const memory = (settings: Record<string, unknown>) => {
	state.settings.memoryEnabled = true
	state.settings.memorySettings = JSON.stringify(settings)
}

describe("the model that writes Memory's expansion", () => {
	beforeEach(() => {
		state.settings = { apiConfigurationProfiles: JSON.stringify([profile("cheap cloud")]) }
		state.built = []
		state.sent = []
		state.chunks = [
			{ type: "reasoning", reasoning: "thinking about it" },
			{ type: "text", text: " Tests run with " },
			{ type: "text", text: "node --test. " },
			{ type: "done", success: true },
		]
	})

	it("is absent until the expansion is on and a profile is named", () => {
		memory({})
		expect(readMemoryQueryExpander({})).toBeUndefined()
		memory({ hyde: true })
		expect(readMemoryQueryExpander({})).toBeUndefined()
		memory({ hyde: false, hydeProfile: "cheap cloud" })
		expect(readMemoryQueryExpander({})).toBeUndefined()
		memory({ hyde: true, hydeProfile: "cheap cloud" })
		expect(readMemoryQueryExpander({})).toBeTypeOf("function")
	})

	it("is absent when the named profile no longer exists", () => {
		memory({ hyde: true, hydeProfile: "deleted" })
		expect(readMemoryQueryExpander({})).toBeUndefined()
	})

	it("asks the profile's model, with the session's keys, and returns the text alone", async () => {
		memory({ hyde: true, hydeProfile: "cheap cloud" })
		const expand = readMemoryQueryExpander({ ollamaApiKey: "k-1" } as never)
		const text = await expand?.({ system: "S", prompt: "P", signal: new AbortController().signal })
		expect(text).toBe("Tests run with node --test.")
		expect(state.sent).toEqual([{ system: "S", messages: [{ role: "user", content: "P" }] }])
		expect(state.built[0].configuration).toMatchObject({
			actModeApiProvider: "ollama",
			actModeOllamaModelId: "gemma4:31b-cloud",
			ollamaApiKey: "k-1",
		})
		// The window and sampler saved with the profile, not the session's.
		expect(state.built[0].options).toEqual({
			visionProviderSettings: { selectedModelId: "gemma4:31b-cloud", contextWindow: 16384 },
		})
	})

	it("throws on a failed stream, which the recall treats as no expansion", async () => {
		memory({ hyde: true, hydeProfile: "cheap cloud" })
		state.chunks = [{ type: "done", success: false, error: "401" }]
		const expand = readMemoryQueryExpander({})
		await expect(expand?.({ system: "S", prompt: "P", signal: new AbortController().signal })).rejects.toThrow("401")
	})
})

describe("expired notes", () => {
	// Memory's own folder, never the user's: sharedMemory() reads the data
	// folder from the environment each time.
	const dataDir = mkdtempSync(join(tmpdir(), "memory-expiry-"))
	process.env.CEREBRILINE_DATA_DIR = dataDir
	afterAll(async () => {
		await closeSharedMemories()
		delete process.env.CEREBRILINE_DATA_DIR
		rmSync(dataDir, { recursive: true, force: true })
	})
	let now = Date.now() + 10 * 86_400_000

	beforeEach(() => {
		state.settings = { apiConfigurationProfiles: JSON.stringify([profile("cheap cloud")]) }
		state.sent = []
		state.chunks = [
			{ type: "text", text: "The cache was tried twice and missed." },
			{ type: "done", success: true },
		]
		// Past the hour each run waits for since the last.
		now += 2 * 60 * 60 * 1000
	})

	it("stay while no profile is named, and are distilled by its model once one is", async () => {
		const store = sharedMemory()
		await store.remember({ text: "Session one tried the cache.", ttlDays: 1 })
		await store.remember({ text: "Session two saw the cache miss.", ttlDays: 1 })
		memory({ noteTtlDays: 1 })
		await runMemoryMaintenance({}, now)
		expect(store.list()).toHaveLength(2)

		memory({ noteTtlDays: 1, hydeProfile: "cheap cloud" })
		await runMemoryMaintenance({}, (now += 2 * 60 * 60 * 1000))
		expect(state.sent[0].system).toContain("distil a project's expired notes")
		expect(store.list().map((note) => note.text)).toEqual(["The cache was tried twice and missed."])
	})

	it("does nothing while notes never expire", async () => {
		memory({ noteTtlDays: 0, hydeProfile: "cheap cloud" })
		await runMemoryMaintenance({}, now)
		expect(state.sent).toEqual([])
	})

	it("merges near-duplicates on its own, once an hour, whether or not notes expire", async () => {
		const store = sharedMemory()
		for (const note of store.list()) await store.forget(note.id)
		const first = await store.remember({ text: "The parser keeps a cache of tokens per file." })
		await store.remember({ text: "The parser keeps a cache of the tokens per file.", allowSimilar: true })
		memory({ noteTtlDays: 0 })
		await runMemoryMaintenance({}, now)
		expect(store.list().map((note) => note.id)).toEqual([first.item.id])

		// Within the hour, a new duplicate waits for the next run.
		await store.remember({ text: "The parser keeps a cache of tokens for each file.", allowSimilar: true })
		await runMemoryMaintenance({}, now + 60_000)
		expect(store.list()).toHaveLength(2)
		await runMemoryMaintenance({}, (now += 2 * 60 * 60 * 1000))
		expect(store.list().map((note) => note.id)).toEqual([first.item.id])
	})

	it("leaves the notes alone while Memory is off", async () => {
		const store = sharedMemory()
		for (const note of store.list()) await store.forget(note.id)
		await store.remember({ text: "Builds run under Bun 1.4.2 on solidPC." })
		await store.remember({ text: "Builds run under Bun 1.4.2 on the solidPC.", allowSimilar: true })
		memory({})
		state.settings.memoryEnabled = false
		await runMemoryMaintenance({}, now)
		expect(store.list()).toHaveLength(2)
	})
})
