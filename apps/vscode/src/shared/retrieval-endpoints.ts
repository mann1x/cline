/**
 * What the Embedding tab stores, as one JSON record round-tripped whole.
 *
 * Shared by the host that reads it and the tab that writes it, so the two
 * cannot disagree about a field. The keys are not in here: they are secrets.
 */
export interface RetrievalEndpointSettings {
	/** Where requests go when the session's provider is not used. */
	baseUrl: string
	model: string
}

export interface RetrievalEndpoints {
	/** Embed on the session's own provider (Ollama, opencoti, any OpenAI-compatible server). */
	useProvider?: boolean
	/** `POST <endpoint>/embeddings`. */
	embedding: RetrievalEndpointSettings
	/** `POST <endpoint>/rerank`. Off unless `enabled`. */
	reranking: RetrievalEndpointSettings & { enabled?: boolean }
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")

function endpoint(raw: unknown): RetrievalEndpointSettings {
	const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>
	return { baseUrl: text(record.baseUrl), model: text(record.model) }
}

/** Unparseable or empty storage is an empty tab, not a reason to throw. */
export function parseRetrievalEndpoints(raw: string | undefined): RetrievalEndpoints {
	let parsed: Record<string, unknown> = {}
	if (raw) {
		try {
			const value = JSON.parse(raw)
			if (typeof value === "object" && value !== null) {
				parsed = value as Record<string, unknown>
			}
		} catch {
			// An empty tab.
		}
	}
	const reranking = (typeof parsed.reranking === "object" && parsed.reranking !== null ? parsed.reranking : {}) as Record<
		string,
		unknown
	>
	return {
		...(parsed.useProvider === true ? { useProvider: true } : {}),
		embedding: endpoint(parsed.embedding),
		reranking: { ...endpoint(parsed.reranking), ...(reranking.enabled === true ? { enabled: true } : {}) },
	}
}

/**
 * Whether the tab names an embedding model and somewhere to send it, for the
 * panel's warning. The model is always typed: a server lists chat and
 * embedding models together and nothing says which is which.
 */
export function embeddingEndpointConfigured(endpoints: RetrievalEndpoints): boolean {
	return endpoints.embedding.model !== "" && (endpoints.useProvider === true || endpoints.embedding.baseUrl !== "")
}

export function rerankingEndpointConfigured(endpoints: RetrievalEndpoints): boolean {
	return endpoints.reranking.enabled === true && endpoints.reranking.model !== "" && endpoints.reranking.baseUrl !== ""
}
