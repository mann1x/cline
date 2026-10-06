import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { parseRetrievalEndpoints, type RetrievalEndpoints } from "@shared/retrieval-endpoints"
import { useCallback, useMemo } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "./common/DebouncedTextField"
import { SettingsCheckbox } from "./common/SettingsCheckbox"

/**
 * The embedding model, and the reranking model beside it.
 *
 * Two endpoints on one tab because they are two halves of one search: the
 * embedding model finds passages by meaning, the reranking model reads the
 * best of them against the question and puts them in order. Like the Images
 * and Audio tabs this is not a `ScopedModelTab`: what is configured is an
 * endpoint, not a second model in the conversation.
 *
 * The models are typed, not picked: a server lists its chat and embedding
 * models together, and nothing in the list says which is which.
 */
const EmbeddingTab = () => {
	const { retrievalEndpoints, embeddingApiKeySet, rerankingApiKeySet } = useExtensionState()
	const stored = useMemo(() => parseRetrievalEndpoints(retrievalEndpoints), [retrievalEndpoints])

	const save = useCallback(async (next: RetrievalEndpoints) => {
		try {
			await StateServiceClient.updateSettings(UpdateSettingsRequest.create({ retrievalEndpoints: JSON.stringify(next) }))
		} catch (error) {
			console.error("Failed to save the embedding endpoints:", error)
		}
	}, [])
	const saveEmbedding = (patch: Partial<RetrievalEndpoints["embedding"]>) =>
		void save({ ...stored, embedding: { ...stored.embedding, ...patch } })
	const saveReranking = (patch: Partial<RetrievalEndpoints["reranking"]>) =>
		void save({ ...stored, reranking: { ...stored.reranking, ...patch } })

	const saveKey = useCallback(async (key: "embeddingApiKey" | "rerankingApiKey", value: string) => {
		try {
			await StateServiceClient.updateSettings(
				UpdateSettingsRequest.create(key === "embeddingApiKey" ? { embeddingApiKey: value } : { rerankingApiKey: value }),
			)
		} catch (error) {
			console.error("Failed to save the key:", error)
		}
	}, [])

	const useProvider = stored.useProvider === true
	const rerankingOn = stored.reranking.enabled === true

	return (
		<div className="flex flex-col gap-3">
			<p className="text-xs text-(--vscode-descriptionForeground)">
				With an embedding model the Library is searched by meaning as well as by keyword: a question finds the passage
				that answers it even when the two share no words. Without one, the Library still works on keywords. The first time
				this is turned on, LanceDB — where the vectors are kept — is downloaded once (200 to 390 MB, depending on the
				platform).
			</p>

			<div>
				<SettingsCheckbox checked={useProvider} onChange={(checked) => void save({ ...stored, useProvider: checked })}>
					Embed on the session's provider
				</SettingsCheckbox>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					Ollama, opencoti, llama.cpp, LM Studio and most OpenAI-compatible servers embed as well as chat. With this
					ticked, the model named below is asked for at the address the session's own provider is on, and the endpoint
					below is used only when that provider has no address of its own.
				</p>
			</div>

			<DebouncedTextField
				className="w-full"
				initialValue={stored.embedding.model}
				onChange={(value) => saveEmbedding({ model: value.trim() })}
				placeholder="snowflake-arctic-embed2">
				<span className="font-medium">Embedding model</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Its name on the server, sent as given — for instance <code>snowflake-arctic-embed2</code>,{" "}
				<code>qwen3-embedding:0.6b</code>, <code>bge-m3</code> or <code>nomic-embed-text</code> on Ollama. Changing it
				keeps the vectors already made and starts a new set: vectors from two models cannot be compared.
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue={stored.embedding.baseUrl}
				onChange={(value) => saveEmbedding({ baseUrl: value.trim() })}
				placeholder="http://127.0.0.1:11434">
				<span className="font-medium">Embedding endpoint</span>
			</DebouncedTextField>
			<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
				Any server that speaks the OpenAI embeddings API. Cerebriline calls <code>POST &lt;endpoint&gt;/embeddings</code>{" "}
				and adds the <code>/v1</code> if you leave it off.
				{useProvider ? " Used when the session's provider has no address." : ""}
			</p>

			<DebouncedTextField
				className="w-full"
				initialValue=""
				onChange={(value) => void saveKey("embeddingApiKey", value)}
				placeholder={
					embeddingApiKeySet ? "Stored — type to replace, clear to remove" : "Leave empty if the server needs none"
				}
				type="password">
				<span className="font-medium">API key</span>
			</DebouncedTextField>

			<div className="mt-2 pt-3 border-t border-(--vscode-panel-border)">
				<SettingsCheckbox checked={rerankingOn} onChange={(checked) => saveReranking({ enabled: checked })}>
					Use a reranking model
				</SettingsCheckbox>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					A reranker reads each of the best passages together with the question and scores how well it answers. It is
					slower than the search and far better at ordering, so it is given only the top few. It also works without an
					embedding model, over the keyword results.
				</p>
			</div>

			{rerankingOn ? (
				<>
					<DebouncedTextField
						className="w-full"
						initialValue={stored.reranking.model}
						onChange={(value) => saveReranking({ model: value.trim() })}
						placeholder="bge-reranker-v2-m3">
						<span className="font-medium">Reranking model</span>
					</DebouncedTextField>

					<DebouncedTextField
						className="w-full"
						initialValue={stored.reranking.baseUrl}
						onChange={(value) => saveReranking({ baseUrl: value.trim() })}
						placeholder="http://127.0.0.1:8081">
						<span className="font-medium">Reranking endpoint</span>
					</DebouncedTextField>
					<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
						Cerebriline calls <code>POST &lt;endpoint&gt;/rerank</code>, the route llama.cpp (
						<code>llama-server --reranking</code>), opencoti, Jina, Cohere and text-embeddings-inference serve. Ollama
						has no rerank route, so a reranker pulled with Ollama has to be served by one of those. With llama.cpp,
						start it with a batch as large as its context (<code>-ub 8192</code>): its default of 512 tokens is
						smaller than a passage, and longer passages are then read only in part.
					</p>

					<DebouncedTextField
						className="w-full"
						initialValue=""
						onChange={(value) => void saveKey("rerankingApiKey", value)}
						placeholder={
							rerankingApiKeySet
								? "Stored — type to replace, clear to remove"
								: "Leave empty if the server needs none"
						}
						type="password">
						<span className="font-medium">API key</span>
					</DebouncedTextField>
					<p className="text-xs -mt-2 text-(--vscode-descriptionForeground)">
						Each key is sent as <code>Authorization: Bearer</code> to its own endpoint only, and kept in the editor's
						secret storage — which is why the fields look empty even when a key is stored.
					</p>
				</>
			) : null}
		</div>
	)
}

export default EmbeddingTab
