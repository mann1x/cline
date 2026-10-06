import { embedTexts, type RetrievalEndpoint, rerankDocuments, resolveRetrievalBaseUrl } from "@cline/core"
import type { RetrievalEmbeddingModels, RetrievalEmbeddingState, RetrievalEndpointCheck } from "@shared/retrieval-status"
import axios from "axios"
import { StateManager } from "@/core/storage/StateManager"
import { getAxiosSettings } from "@/shared/net"
import { parseRetrievalEndpoints, rerankingEndpointConfigured } from "@/shared/retrieval-endpoints"
import { ensureBaseUrlScheme } from "./cline-session-factory"
import { readRerankingEndpoint } from "./library-config"
import { readLeadMediaProvider } from "./media-endpoint-config"

/**
 * The embedding endpoint as the Embedding tab has it, with what is missing
 * said in words: which model, at which address, taken from where, and when
 * it cannot be used, the one thing that stops it.
 *
 * `readEmbeddingEndpoint` answers "can I embed" with an endpoint or nothing;
 * a panel needs the reason behind the nothing.
 */
export function describeEmbeddingEndpoint(): RetrievalEmbeddingState {
	const state = StateManager.get()
	const enabled = state.getGlobalSettingsKey("embeddingEnabled") === true
	const stored = parseRetrievalEndpoints(state.getGlobalSettingsKey("retrievalEndpoints"))
	const useProvider = stored.useProvider === true
	const provider = useProvider ? readLeadMediaProvider() : undefined
	const typed = stored.embedding.baseUrl
	const baseUrl = provider?.baseUrl ? ensureBaseUrlScheme(provider.baseUrl) : typed ? ensureBaseUrlScheme(typed) : undefined
	const source = provider?.baseUrl ? "provider" : typed ? "typed" : undefined
	const model = stored.embedding.model
	const problem = !enabled
		? "“Use an embedding model” is not ticked in the API configuration."
		: !baseUrl
			? useProvider
				? `The session's provider${provider?.providerId ? ` (${provider.providerId})` : ""} has no address of its own, and no embedding endpoint is typed.`
				: "No embedding endpoint is typed on the Embedding tab."
			: !model
				? "No embedding model is named on the Embedding tab: the field is empty."
				: undefined
	return {
		enabled,
		useProvider,
		model,
		...(baseUrl ? { baseUrl } : {}),
		...(source ? { source } : {}),
		...(provider?.providerId ? { providerId: provider.providerId } : {}),
		...(problem ? { problem } : {}),
	}
}

function embeddingApiKey(): string | undefined {
	const typedKey = StateManager.get().getSecretKey("embeddingApiKey")?.trim() || undefined
	const stored = parseRetrievalEndpoints(StateManager.get().getGlobalSettingsKey("retrievalEndpoints"))
	return typedKey ?? (stored.useProvider ? readLeadMediaProvider()?.apiKey : undefined)
}

const MODEL_LIST_TIMEOUT_MS = 6000
const SHOW_CONCURRENCY = 8
/** A name that says "embedding model" when the server does not. */
const EMBEDDING_NAME = /embed|bge|e5-|minilm|arctic|gte-|nomic|mxbai|jina/i

/** The server's root, without the `/v1` an OpenAI-style address ends in. */
const serverRoot = (baseUrl: string) => baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")

const lists = new Map<string, { at: number; list: Promise<RetrievalEmbeddingModels> }>()
const LIST_TTL_MS = 30_000

/**
 * The embedding models a server has.
 *
 * Ollama (and xOllama, which speaks the same API) says which of its models
 * embed: `/api/show` lists a model's capabilities. Any other server lists
 * its models with nothing to tell a chat model from an embedding one, so
 * that list comes back whole and is marked as such.
 */
export function listEmbeddingModels(baseUrl: string, apiKey: string | undefined): Promise<RetrievalEmbeddingModels> {
	const key = `${baseUrl}\u0000${apiKey ?? ""}`
	const held = lists.get(key)
	if (held && Date.now() - held.at < LIST_TTL_MS) {
		return held.list
	}
	const list = fetchEmbeddingModels(baseUrl, apiKey)
	lists.set(key, { at: Date.now(), list })
	return list
}

async function fetchEmbeddingModels(baseUrl: string, apiKey: string | undefined): Promise<RetrievalEmbeddingModels> {
	const root = serverRoot(baseUrl)
	const settings = {
		...getAxiosSettings(),
		timeout: MODEL_LIST_TIMEOUT_MS,
		...(apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : {}),
	}
	try {
		const tags = await axios.get(`${root}/api/tags`, settings)
		const models: Array<{ name: string; details?: { family?: string; families?: string[] } }> = Array.isArray(
			tags.data?.models,
		)
			? tags.data.models
			: []
		const names = models.map((model) => model.name).filter((name) => typeof name === "string")
		const capable: string[] = []
		let reported = 0
		let next = 0
		const worker = async () => {
			while (next < names.length) {
				const name = names[next++]
				try {
					const show = await axios.post(`${root}/api/show`, { model: name }, settings)
					if (Array.isArray(show.data?.capabilities)) {
						reported += 1
						if (show.data.capabilities.includes("embedding")) {
							capable.push(name)
						}
					}
				} catch {
					// A model that cannot be shown is not offered.
				}
			}
		}
		await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, names.length) }, worker))
		if (reported > 0) {
			return { kind: "ollama", filtered: true, models: capable.sort(), baseUrl }
		}
		// An older server that reports no capabilities: go by family and name.
		const guessed = models
			.filter(
				(model) =>
					EMBEDDING_NAME.test(model.name) ||
					[model.details?.family, ...(model.details?.families ?? [])].includes("bert"),
			)
			.map((model) => model.name)
		return { kind: "ollama", filtered: true, models: guessed.sort(), baseUrl }
	} catch {
		// Not an Ollama: ask it the OpenAI way.
	}
	try {
		const response = await axios.get(`${resolveRetrievalBaseUrl(baseUrl)}/models`, settings)
		const data: Array<{ id?: unknown }> = Array.isArray(response.data?.data) ? response.data.data : []
		const models = data.map((entry) => entry.id).filter((id): id is string => typeof id === "string")
		return { kind: "openai", filtered: false, models: models.sort(), baseUrl }
	} catch (error) {
		return {
			kind: "unknown",
			filtered: false,
			models: [],
			baseUrl,
			error: `${baseUrl} did not list its models (${error instanceof Error ? error.message : String(error)}).`,
		}
	}
}

/** The embedding models of the endpoint the tab points at, or why there is no list. */
export async function listConfiguredEmbeddingModels(): Promise<RetrievalEmbeddingModels> {
	const described = describeEmbeddingEndpoint()
	if (!described.baseUrl) {
		return { kind: "unknown", filtered: false, models: [], error: described.problem ?? "There is no endpoint to ask." }
	}
	return listEmbeddingModels(described.baseUrl, embeddingApiKey())
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Embed one short text and say what came back. The only check that answers
 * "does this provider embed with this model": a server can list a model, be
 * reachable, and still refuse the request.
 */
export async function checkEmbeddingEndpoint(): Promise<RetrievalEndpointCheck> {
	const described = describeEmbeddingEndpoint()
	// Checked even while the box is unticked: the user is deciding whether to tick it.
	if (!described.baseUrl || !described.model) {
		return {
			ok: false,
			detail: !described.baseUrl
				? (described.problem ?? "There is no endpoint to ask.")
				: "No embedding model is named: the field is empty.",
		}
	}
	const apiKey = embeddingApiKey()
	const endpoint: RetrievalEndpoint = { baseUrl: described.baseUrl, model: described.model, ...(apiKey ? { apiKey } : {}) }
	const started = Date.now()
	try {
		const result = await embedTexts(endpoint, ["Cerebriline checks that this model embeds."], { maxAttempts: 1 })
		const where = described.source === "provider" ? "the session's provider" : "the typed endpoint"
		return {
			ok: true,
			detail: `${described.model} embeds on ${where} (${described.baseUrl}): ${result.dimension}-dimension vectors, ${Date.now() - started} ms.`,
		}
	} catch (error) {
		return { ok: false, detail: `${described.model} did not embed at ${described.baseUrl}: ${message(error)}` }
	}
}

/** Rerank two passages against a question and say whether the right one came first. */
export async function checkRerankingEndpoint(): Promise<RetrievalEndpointCheck> {
	const state = StateManager.get()
	const stored = parseRetrievalEndpoints(state.getGlobalSettingsKey("retrievalEndpoints"))
	if (!rerankingEndpointConfigured(stored)) {
		return { ok: false, detail: "Name a reranking model and its endpoint first." }
	}
	const apiKey = state.getSecretKey("rerankingApiKey")?.trim() || undefined
	const endpoint = readRerankingEndpoint() ?? {
		baseUrl: ensureBaseUrlScheme(stored.reranking.baseUrl),
		model: stored.reranking.model,
		...(apiKey ? { apiKey } : {}),
	}
	const started = Date.now()
	try {
		const scores = await rerankDocuments(
			endpoint,
			"How is the coolant pump removed?",
			["The annual report was filed in March.", "Undo the four bolts and pull the coolant pump off its shaft."],
			{ maxAttempts: 1 },
		)
		const right = scores[1] > scores[0]
		return {
			ok: right,
			detail: right
				? `${endpoint.model} reranks at ${endpoint.baseUrl}: it put the right passage first, ${Date.now() - started} ms.`
				: `${endpoint.model} answered at ${endpoint.baseUrl} but scored the unrelated passage higher (${scores.map((score) => score.toFixed(2)).join(" vs ")}): it may not be a reranking model.`,
		}
	} catch (error) {
		return {
			ok: false,
			detail: `${endpoint.model} did not rerank at ${endpoint.baseUrl}: ${message(error)}. Ollama has no rerank route; use llama.cpp (llama-server --reranking) or opencoti.`,
		}
	}
}
