import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
	settings: {} as Record<string, unknown>,
	secrets: {} as Record<string, string>,
	api: {} as Record<string, unknown>,
}))

vi.mock("@/core/storage/StateManager", () => ({
	StateManager: {
		get: () => ({
			getGlobalSettingsKey: (key: string) => state.settings[key],
			getSecretKey: (key: string) => state.secrets[key],
			getApiConfiguration: () => state.api,
		}),
	},
}))

const imageSupport = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock("./image-support", () => ({ resolveImageSupport: imageSupport.resolve }))

import { DEFAULT_LIBRARY_SETTINGS } from "@cline/core"
import { embeddingEndpointConfigured, parseRetrievalEndpoints, rerankingEndpointConfigured } from "@/shared/retrieval-endpoints"
import {
	readEmbeddingEndpoint,
	readLibraryImageDescriber,
	readLibrarySettings,
	readLibraryToolsConfig,
	readMemorySettings,
	readMemoryToolsConfig,
	readRerankingEndpoint,
} from "./library-config"

const store = (value: unknown) => {
	state.settings.retrievalEndpoints = JSON.stringify(value)
}

describe("the Embedding tab's record", () => {
	it("reads an empty or broken record as an empty tab", () => {
		for (const raw of [undefined, "", "not json", "[1,2]", "null"]) {
			expect(parseRetrievalEndpoints(raw)).toEqual({
				embedding: { baseUrl: "", model: "" },
				reranking: { baseUrl: "", model: "" },
			})
		}
	})

	it("needs a model, and either the session's provider or an address", () => {
		const configured = (value: unknown) => embeddingEndpointConfigured(parseRetrievalEndpoints(JSON.stringify(value)))
		expect(configured({ useProvider: true })).toBe(false)
		expect(configured({ useProvider: true, embedding: { model: "m" } })).toBe(true)
		expect(configured({ embedding: { model: "m" } })).toBe(false)
		expect(configured({ embedding: { model: " m ", baseUrl: " http://h " } })).toBe(true)
	})

	it("reranks only when its box is ticked and it is fully named", () => {
		const configured = (value: unknown) => rerankingEndpointConfigured(parseRetrievalEndpoints(JSON.stringify(value)))
		expect(configured({ reranking: { baseUrl: "http://h", model: "m" } })).toBe(false)
		expect(configured({ reranking: { baseUrl: "http://h", model: "m", enabled: true } })).toBe(true)
		expect(configured({ reranking: { model: "m", enabled: true } })).toBe(false)
	})
})

describe("the Library's configuration", () => {
	beforeEach(() => {
		state.settings = { libraryEnabled: true, embeddingEnabled: true }
		state.secrets = {}
		state.api = {}
	})

	it("is off until the Library is turned on", () => {
		state.settings = {}
		expect(readLibraryToolsConfig()).toBeUndefined()
		expect(readLibrarySettings()).toEqual(DEFAULT_LIBRARY_SETTINGS)
	})

	it("takes the switch from its own setting, whatever the record says", () => {
		state.settings = { librarySettings: JSON.stringify({ enabled: true, topK: 9 }) }
		expect(readLibrarySettings().enabled).toBe(false)
		expect(readLibrarySettings().topK).toBe(9)
		state.settings.libraryEnabled = true
		expect(readLibraryToolsConfig()?.settings).toMatchObject({ enabled: true, topK: 9, chunkSize: 1500 })
	})

	it("reads broken settings as the defaults", () => {
		state.settings.librarySettings = "{not json"
		expect(readLibrarySettings()).toEqual({ ...DEFAULT_LIBRARY_SETTINGS, enabled: true })
	})

	it("works on keywords alone when no model is named", () => {
		const config = readLibraryToolsConfig()
		expect(config?.embedding).toBeUndefined()
		expect(config?.reranker).toBeUndefined()
		expect(config?.documentReader).toEqual({ ocr: "tesseract", ocrLanguages: ["eng"] })
	})

	it("embeds at the typed endpoint, with its key", () => {
		store({ embedding: { baseUrl: "127.0.0.1:11434", model: "snowflake-arctic-embed2" } })
		state.secrets.embeddingApiKey = " sk-embed "
		expect(readEmbeddingEndpoint()).toEqual({
			baseUrl: "http://127.0.0.1:11434",
			model: "snowflake-arctic-embed2",
			apiKey: "sk-embed",
		})
	})

	it("embeds nowhere while the box is unticked, though the tab is filled in", () => {
		store({
			embedding: { baseUrl: "http://h", model: "m" },
			reranking: { baseUrl: "http://r", model: "rr", enabled: true },
		})
		state.settings.embeddingEnabled = false
		expect(readEmbeddingEndpoint()).toBeUndefined()
		expect(readRerankingEndpoint()).toBeUndefined()
		expect(readLibraryToolsConfig()?.settings.enabled).toBe(true)
	})

	it("falls back to the typed endpoint when the session's provider has no address", () => {
		store({ useProvider: true, embedding: { baseUrl: "http://typed:1", model: "m" } })
		expect(readEmbeddingEndpoint()).toEqual({ baseUrl: "http://typed:1", model: "m" })
		store({ useProvider: true, embedding: { model: "m" } })
		expect(readEmbeddingEndpoint()).toBeUndefined()
	})

	it("reranks at its own endpoint, with its own key", () => {
		store({
			embedding: { baseUrl: "http://h", model: "m" },
			reranking: { baseUrl: "http://127.0.0.1:38197", model: "bge-reranker-v2-m3", enabled: true },
		})
		state.secrets.embeddingApiKey = "sk-embed"
		state.secrets.rerankingApiKey = "sk-rerank"
		expect(readRerankingEndpoint()).toEqual({
			baseUrl: "http://127.0.0.1:38197",
			model: "bge-reranker-v2-m3",
			apiKey: "sk-rerank",
		})
	})

	it("reads a book with tesseract even when pages go to the vision model in a task", () => {
		state.settings.extractDocumentOcr = "vision"
		state.settings.extractDocumentOcrLanguages = "eng+deu"
		expect(readLibraryToolsConfig()?.documentReader).toEqual({ ocr: "tesseract", ocrLanguages: ["eng", "deu"] })
		state.settings.extractDocumentOcr = "off"
		expect(readLibraryToolsConfig()?.documentReader?.ocr).toBe("off")
	})
})

describe("Memory's configuration", () => {
	beforeEach(() => {
		state.settings = {}
		state.secrets = {}
		state.api = {}
	})

	it("is off until Memory is turned on, whatever the Library is", () => {
		state.settings = { libraryEnabled: true }
		expect(readMemoryToolsConfig()).toBeUndefined()
		expect(readMemorySettings()).toMatchObject({ enabled: false, recallCount: 5, selections: {} })
	})

	it("takes its own settings and the Embedding tab's models", () => {
		state.settings = {
			memoryEnabled: true,
			memorySettings: JSON.stringify({
				recallCount: 8,
				selections: { "C:\\Dev\\App": { store: "app", recall: ["app", "main"] } },
				enabled: false,
				hyde: true,
				hydeProfile: " cheap cloud ",
			}),
			embeddingEnabled: true,
			retrievalEndpoints: JSON.stringify({
				embedding: { baseUrl: "http://h:1", model: "bge-m3" },
				reranking: { baseUrl: "http://r:2", model: "rr", enabled: true },
			}),
		}
		expect(readMemoryToolsConfig()).toEqual({
			settings: {
				enabled: true,
				recallCount: 8,
				relevanceThreshold: 0,
				selections: { "c:/dev/app": { store: "app", recall: ["app", "main"] } },
				autoRecall: true,
				hyde: true,
				hydeProfile: "cheap cloud",
			},
			embedding: { baseUrl: "http://h:1", model: "bge-m3" },
			reranker: { baseUrl: "http://r:2", model: "rr" },
		})
	})

	it("works on keywords alone with no embedding model", () => {
		state.settings = { memoryEnabled: true }
		expect(readMemoryToolsConfig()).toEqual({
			settings: {
				enabled: true,
				recallCount: 5,
				relevanceThreshold: 0,
				selections: {},
				autoRecall: true,
				hyde: false,
				hydeProfile: "",
			},
		})
	})
})

// Measured on pandorum: a session on `deepseek-v4.1-flash:cloud`, which Ollama
// reports as `vision`, was told no vision model was set.
describe("the model that describes a book's pictures", () => {
	beforeEach(() => {
		state.settings = {}
		state.api = {
			actModeApiProvider: "ollama",
			actModeOllamaModelId: "deepseek-v4.1-flash:cloud",
			ollamaBaseUrl: "http://192.168.178.25:11434",
		}
		imageSupport.resolve.mockReset()
	})

	it("is the session's own model when nothing else is named and its server says it reads images", async () => {
		imageSupport.resolve.mockResolvedValue("yes")

		expect(await readLibraryImageDescriber()).toBeTypeOf("function")
		expect(imageSupport.resolve).toHaveBeenCalledWith("ollama", "http://192.168.178.25:11434", "deepseek-v4.1-flash:cloud")
	})

	it.each(["no", "unknown"])("is nobody when the session's model answers %s", async (answer) => {
		imageSupport.resolve.mockResolvedValue(answer)

		expect(await readLibraryImageDescriber()).toBeUndefined()
	})
})
