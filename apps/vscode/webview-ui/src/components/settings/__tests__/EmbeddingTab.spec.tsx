import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import EmbeddingTab from "../EmbeddingTab"

const state = { retrievalEndpoints: "", embeddingApiKeySet: false, rerankingApiKeySet: false }

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ ...state }),
}))

const updateSettings = vi.fn(async (_request: Record<string, unknown>) => ({}))
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { updateSettings: (request: Record<string, unknown>) => updateSettings(request) },
}))

const lastSaved = () => JSON.parse(String(updateSettings.mock.calls.at(-1)?.[0].retrievalEndpoints))

describe("the Embedding tab", () => {
	beforeEach(() => {
		state.retrievalEndpoints = ""
		state.embeddingApiKeySet = false
		state.rerankingApiKeySet = false
		updateSettings.mockClear()
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
})
