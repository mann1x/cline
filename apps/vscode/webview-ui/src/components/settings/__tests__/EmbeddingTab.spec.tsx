import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import EmbeddingTab from "../EmbeddingTab"

const state = { retrievalEndpoints: "", embeddingApiKeySet: false, rerankingApiKeySet: false }

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ ...state }),
}))

const updateSettings = vi.fn(async (_request: Record<string, unknown>) => ({}))

/** What the host answers the tab's questions with. */
const host = {
	models: undefined as Record<string, unknown> | undefined,
	check: undefined as Record<string, unknown> | undefined,
	embedding: { enabled: true, useProvider: false, model: "" } as Record<string, unknown>,
	actions: [] as string[],
	// As the host always sends them: both stores, empty.
	stores: {
		library: { documents: 0, embeddedDocuments: 0, vectorSets: [] },
		memory: { notes: 0, embeddedNotes: 0, vectorSets: [] },
	} as Record<string, unknown>,
}
const retrievalAction = vi.fn(async (request: { value: string }) => {
	const { action } = JSON.parse(request.value)
	host.actions.push(action)
	return {
		value: JSON.stringify({
			ok: true,
			...(action === "embeddingModels" && host.models ? { models: host.models } : {}),
			...(action.startsWith("check") && host.check ? { check: host.check } : {}),
			status: { lancedb: { installing: false }, embedding: host.embedding, embedJobs: {}, ...host.stores },
		}),
	}
})
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: {
		updateSettings: (request: Record<string, unknown>) => updateSettings(request),
		retrievalAction: (request: { value: string }) => retrievalAction(request),
	},
}))

const lastSaved = () => JSON.parse(String(updateSettings.mock.calls.at(-1)?.[0].retrievalEndpoints))

describe("the Embedding tab", () => {
	// Said outright: a render left behind by one test is found by the next.
	afterEach(() => cleanup())

	beforeEach(() => {
		state.retrievalEndpoints = ""
		state.embeddingApiKeySet = false
		state.rerankingApiKeySet = false
		updateSettings.mockClear()
		host.models = undefined
		host.check = undefined
		host.embedding = { enabled: true, useProvider: false, model: "" }
		host.actions = []
		host.stores = {
			library: { documents: 0, embeddedDocuments: 0, vectorSets: [] },
			memory: { notes: 0, embeddedNotes: 0, vectorSets: [] },
		}
	})

	it("shows the embedding fields, and the reranker's only once it is ticked", () => {
		render(<EmbeddingTab />)
		expect(screen.getByText("Embedding model")).toBeTruthy()
		expect(screen.getByText("Embedding endpoint")).toBeTruthy()
		expect(screen.getByText("Use a reranking model")).toBeTruthy()
		expect(screen.queryByText("Reranking endpoint")).toBeNull()
	})

	it("keeps what is stored when one box is ticked", async () => {
		state.retrievalEndpoints = JSON.stringify({ embedding: { baseUrl: "http://h", model: "m" } })
		render(<EmbeddingTab />)
		fireEvent.click(screen.getByText("Use a reranking model"))
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		expect(lastSaved()).toEqual({
			embedding: { baseUrl: "http://h", model: "m" },
			reranking: { baseUrl: "", model: "", enabled: true },
		})
	})

	it("shows the reranker's fields and the note about Ollama when it is on", () => {
		state.retrievalEndpoints = JSON.stringify({ reranking: { baseUrl: "http://r", model: "rr", enabled: true } })
		render(<EmbeddingTab />)
		expect(screen.getByText("Reranking model")).toBeTruthy()
		expect(screen.getByText("Reranking endpoint")).toBeTruthy()
		expect(screen.getByText(/Ollama\s+has no rerank route/)).toBeTruthy()
	})

	it("says the typed endpoint is the fallback when the session's provider embeds", async () => {
		render(<EmbeddingTab />)
		expect(screen.queryByText(/Used when the session's provider has no address/)).toBeNull()
		fireEvent.click(screen.getByText("Embed on the session's provider"))
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		expect(lastSaved().useProvider).toBe(true)
	})

	it("says nothing is embedded while the model field is empty", () => {
		render(<EmbeddingTab />)
		expect(screen.getByText(/No model is named yet/)).toBeTruthy()
	})

	it("offers the server's embedding models in a list, and saves the one picked", async () => {
		state.retrievalEndpoints = JSON.stringify({ useProvider: true, embedding: { baseUrl: "", model: "" } })
		host.models = { kind: "ollama", filtered: true, models: ["bge-m3", "snowflake-arctic-embed2"], baseUrl: "http://o:11434" }
		const { container } = render(<EmbeddingTab />)
		expect(await screen.findByText("The 2 embedding models on http://o:11434.")).toBeTruthy()
		// Also named in the hint under the field, so there is more than one.
		expect(screen.getAllByText("snowflake-arctic-embed2").length).toBeGreaterThan(1)
		expect(screen.getAllByText("Type a name…").length).toBeGreaterThan(0)
		// Assigned rather than passed as `target`: the custom element is not
		// upgraded under jsdom, so it has no `value` setter for fireEvent to find.
		const dropdown = container.querySelector("#embedding-model") as HTMLElement & { value: string }
		dropdown.value = "bge-m3"
		fireEvent.change(dropdown)
		await waitFor(() => expect(updateSettings).toHaveBeenCalled())
		expect(lastSaved().embedding.model).toBe("bge-m3")
	})

	it("keeps a stored model that the server does not have, marked as such", async () => {
		state.retrievalEndpoints = JSON.stringify({ embedding: { baseUrl: "http://o", model: "gone-embed" } })
		host.models = { kind: "ollama", filtered: true, models: ["bge-m3"], baseUrl: "http://o" }
		render(<EmbeddingTab />)
		expect(await screen.findByText("gone-embed (not on this server)")).toBeTruthy()
	})

	it("says a server lists every model when it cannot tell which embed", async () => {
		state.retrievalEndpoints = JSON.stringify({ embedding: { baseUrl: "http://l/v1", model: "" } })
		host.models = { kind: "openai", filtered: false, models: ["a", "b"], baseUrl: "http://l/v1" }
		render(<EmbeddingTab />)
		expect(
			await screen.findByText(/Every model on http:\/\/l\/v1: this server does not say which of them embed\./),
		).toBeTruthy()
	})

	it("keeps the typed field when there is no list, and says when an Ollama has no embedding model", async () => {
		state.retrievalEndpoints = JSON.stringify({ embedding: { baseUrl: "http://o", model: "" } })
		host.models = { kind: "ollama", filtered: true, models: [], baseUrl: "http://o" }
		render(<EmbeddingTab />)
		expect(await screen.findByText(/http:\/\/o has no embedding model\. Pull one there/)).toBeTruthy()
		expect(screen.getAllByPlaceholderText("e.g. snowflake-arctic-embed2").length).toBeGreaterThan(0)
	})

	it("checks the embedding model with a real request and shows what came back", async () => {
		state.retrievalEndpoints = JSON.stringify({ useProvider: true, embedding: { baseUrl: "", model: "qwen3.5:9b" } })
		host.embedding = { enabled: true, useProvider: true, model: "qwen3.5:9b", baseUrl: "http://o:11434", source: "provider" }
		host.check = { ok: false, detail: "qwen3.5:9b did not embed at http://o:11434: does not support embeddings" }
		render(<EmbeddingTab />)
		expect(await screen.findByText(/at http:\/\/o:11434, the session's provider/)).toBeTruthy()
		fireEvent.click(screen.getByText("Check the embedding model"))
		expect(await screen.findByText(/Does not work\. qwen3\.5:9b did not embed/)).toBeTruthy()
		expect(host.actions).toContain("checkEmbedding")
	})

	it("checks the reranker the same way", async () => {
		state.retrievalEndpoints = JSON.stringify({
			embedding: { baseUrl: "", model: "" },
			reranking: { baseUrl: "http://r:8081", model: "bge-reranker-v2-m3", enabled: true },
		})
		host.check = { ok: true, detail: "bge-reranker-v2-m3 reranks at http://r:8081: it put the right passage first, 40 ms." }
		render(<EmbeddingTab />)
		fireEvent.click(screen.getByText("Check the reranking model"))
		expect(await screen.findByText(/Works\. bge-reranker-v2-m3 reranks/)).toBeTruthy()
		expect(host.actions).toContain("checkReranking")
	})

	it("says what a change of model leaves to embed, and that the old vectors are kept", async () => {
		state.retrievalEndpoints = JSON.stringify({ embedding: { baseUrl: "http://o", model: "bge-m3" } })
		host.stores = {
			embeddingModel: "bge-m3",
			library: { documents: 12, embeddedDocuments: 0, vectorSets: [{ table: "vectors_old_768", current: false }] },
			memory: { notes: 1, embeddedNotes: 0, vectorSets: [] },
		}
		render(<EmbeddingTab />)
		expect(
			await screen.findByText(
				"12 documents and 1 note have no vectors for bge-m3 yet and are found by keyword only. Embed them from Settings > Library and Settings > Memory. The vectors made with the model used before are kept, so going back to it needs nothing.",
			),
		).toBeTruthy()
	})

	it("says nothing about embedding when everything has vectors", async () => {
		state.retrievalEndpoints = JSON.stringify({ embedding: { baseUrl: "http://o", model: "bge-m3" } })
		host.stores = {
			embeddingModel: "bge-m3",
			library: { documents: 12, embeddedDocuments: 12, vectorSets: [] },
			memory: { notes: 1, embeddedNotes: 1, vectorSets: [] },
		}
		render(<EmbeddingTab />)
		await waitFor(() => expect(host.actions).toContain("status"))
		expect(screen.queryByText(/found by keyword only/)).toBeNull()
	})
})
