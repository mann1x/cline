import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

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

import {
	checkEmbeddingEndpoint,
	checkRerankingEndpoint,
	describeEmbeddingEndpoint,
	listConfiguredEmbeddingModels,
	listEmbeddingModels,
} from "./embedding-endpoint"

type Handler = (request: IncomingMessage, body: string, response: ServerResponse) => void

function serve(handler: Handler): Promise<{ server: Server; url: string }> {
	return new Promise((resolve) => {
		const server = createServer((request, response) => {
			let body = ""
			request.on("data", (chunk) => {
				body += chunk
			})
			request.on("end", () => handler(request, body, response))
		})
		server.listen(0, "127.0.0.1", () => {
			resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })
		})
	})
}

const json = (response: ServerResponse, status: number, data: unknown) => {
	response.writeHead(status, { "content-type": "application/json" })
	response.end(JSON.stringify(data))
}

/** An Ollama: three models, one of which embeds, and it says which. */
const ollama: Handler = (request, body, response) => {
	if (request.url === "/api/tags") {
		return json(response, 200, {
			models: [{ name: "qwen3.5:9b" }, { name: "snowflake-arctic-embed2:latest" }, { name: "gemma4:e4b" }],
		})
	}
	if (request.url === "/api/show") {
		const model = JSON.parse(body).model as string
		return json(response, 200, { capabilities: model.includes("embed") ? ["embedding"] : ["completion", "tools"] })
	}
	if (request.url === "/v1/embeddings") {
		const { model, input } = JSON.parse(body)
		if (!String(model).includes("embed")) {
			return json(response, 400, { error: { message: `"${model}" does not support embeddings` } })
		}
		return json(response, 200, {
			model,
			data: (input as string[]).map((_text, index) => ({ index, embedding: [0.1, 0.2, 0.3, 0.4] })),
		})
	}
	if (request.url === "/v1/rerank") {
		return json(response, 404, { error: "404 page not found" })
	}
	json(response, 404, {})
}

/** A llama.cpp: no /api/tags, an OpenAI model list, and a rerank route. */
const llamacpp: Handler = (request, body, response) => {
	if (request.url === "/v1/models") {
		return json(response, 200, { data: [{ id: "bge-reranker-v2-m3" }, { id: "some-chat-model" }] })
	}
	if (request.url === "/v1/rerank") {
		const { documents } = JSON.parse(body) as { documents: string[] }
		return json(response, 200, {
			results: documents.map((text, index) => ({ index, relevance_score: text.includes("coolant") ? 4.2 : -6.1 })),
		})
	}
	json(response, 404, {})
}

describe("the embedding endpoint, as a panel needs to know it", () => {
	let a: { server: Server; url: string }
	let b: { server: Server; url: string }

	beforeAll(async () => {
		a = await serve(ollama)
		b = await serve(llamacpp)
	})
	afterAll(() => {
		a.server.close()
		b.server.close()
	})
	beforeEach(() => {
		state.settings = {}
		state.secrets = {}
		state.api = {}
	})

	const tab = (value: Record<string, unknown>) => {
		state.settings.retrievalEndpoints = JSON.stringify(value)
	}
	const onProvider = (model: string) => {
		state.settings.embeddingEnabled = true
		state.api = { actModeApiProvider: "ollama", ollamaBaseUrl: a.url }
		tab({ useProvider: true, embedding: { baseUrl: "http://127.0.0.1:11434", model } })
	}

	it("names the one thing that stops it: the box, the address, or the empty model field", () => {
		expect(describeEmbeddingEndpoint().problem).toContain("is not ticked")

		state.settings.embeddingEnabled = true
		tab({ embedding: { baseUrl: "", model: "bge-m3" } })
		expect(describeEmbeddingEndpoint().problem).toBe("No embedding endpoint is typed on the Embedding tab.")

		// What a user had: both boxes ticked, the provider's address found, the model never typed.
		onProvider("")
		expect(describeEmbeddingEndpoint()).toEqual({
			enabled: true,
			useProvider: true,
			model: "",
			baseUrl: a.url,
			source: "provider",
			providerId: "ollama",
			problem: "No embedding model is named on the Embedding tab: the field is empty.",
		})

		onProvider("snowflake-arctic-embed2")
		expect(describeEmbeddingEndpoint().problem).toBeUndefined()
	})

	it("uses the session provider's address over the typed one, and the typed one when the provider has none", () => {
		onProvider("m")
		expect(describeEmbeddingEndpoint()).toMatchObject({ baseUrl: a.url, source: "provider" })
		state.api = { actModeApiProvider: "anthropic" }
		expect(describeEmbeddingEndpoint()).toMatchObject({ baseUrl: "http://127.0.0.1:11434", source: "typed" })
	})

	it("lists only the models an Ollama says can embed", async () => {
		onProvider("")
		expect(await listConfiguredEmbeddingModels()).toEqual({
			kind: "ollama",
			filtered: true,
			models: ["snowflake-arctic-embed2:latest"],
			baseUrl: a.url,
		})
	})

	it("lists every model of a server that cannot say which embed, and says so", async () => {
		expect(await listEmbeddingModels(`${b.url}/v1`, undefined)).toEqual({
			kind: "openai",
			filtered: false,
			models: ["bge-reranker-v2-m3", "some-chat-model"],
			baseUrl: `${b.url}/v1`,
		})
	})

	it("says why there is no list when nothing answers, or nothing is set", async () => {
		const dead = await listEmbeddingModels("http://127.0.0.1:1", undefined)
		expect(dead.models).toEqual([])
		expect(dead.error).toContain("did not list its models")
		expect((await listConfiguredEmbeddingModels()).error).toContain("is not ticked")
	})

	it("checks by embedding: a model that embeds, a model that does not, and a field left empty", async () => {
		onProvider("snowflake-arctic-embed2")
		const good = await checkEmbeddingEndpoint()
		expect(good.ok).toBe(true)
		expect(good.detail).toMatch(
			new RegExp(
				`^snowflake-arctic-embed2 embeds on the session's provider \\(${a.url}\\): 4-dimension vectors, \\d+ ms\\.$`,
			),
		)

		onProvider("qwen3.5:9b")
		const bad = await checkEmbeddingEndpoint()
		expect(bad.ok).toBe(false)
		expect(bad.detail).toContain("did not embed")
		expect(bad.detail).toContain("does not support embeddings")

		onProvider("")
		expect(await checkEmbeddingEndpoint()).toEqual({ ok: false, detail: "No embedding model is named: the field is empty." })
	})

	it("checks a reranker by reranking, and says what to use when the server is an Ollama", async () => {
		state.settings.embeddingEnabled = true
		tab({ embedding: { baseUrl: "", model: "" }, reranking: { baseUrl: b.url, model: "bge-reranker-v2-m3", enabled: true } })
		const good = await checkRerankingEndpoint()
		expect(good.ok).toBe(true)
		expect(good.detail).toContain("put the right passage first")

		tab({ embedding: { baseUrl: "", model: "" }, reranking: { baseUrl: a.url, model: "bge-reranker-v2-m3", enabled: true } })
		const onOllama = await checkRerankingEndpoint()
		expect(onOllama.ok).toBe(false)
		expect(onOllama.detail).toContain("Ollama has no rerank route")

		tab({ embedding: { baseUrl: "", model: "" }, reranking: { baseUrl: "", model: "", enabled: true } })
		expect((await checkRerankingEndpoint()).detail).toBe("Name a reranking model and its endpoint first.")
	})
})
