import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { parseRetrievalEndpoints, type RetrievalEndpoints } from "@shared/retrieval-endpoints"
import type { RetrievalEmbeddingModels, RetrievalEndpointCheck } from "@shared/retrieval-status"
import { VSCodeButton, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { StateServiceClient } from "@/services/grpc-client"
import { DebouncedTextField } from "./common/DebouncedTextField"
import { SettingsCheckbox } from "./common/SettingsCheckbox"
import { useRetrievalStatus } from "./utils/useRetrievalStatus"

/** The dropdown's entry for "none of these: let me type it". */
const TYPE_A_NAME = "\u0000type"

const CheckResult = ({ check }: { check: RetrievalEndpointCheck | undefined }) =>
	check ? (
		<p className={`text-xs ${check.ok ? "text-(--vscode-testing-iconPassed)" : "text-(--vscode-errorForeground)"}`}>
			{check.ok ? "Works. " : "Does not work. "}
			{check.detail}
		</p>
	) : null

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

	const retrieval = useRetrievalStatus()
	const [models, setModels] = useState<RetrievalEmbeddingModels>()
	const [typing, setTyping] = useState(false)
	const [embeddingCheck, setEmbeddingCheck] = useState<RetrievalEndpointCheck>()
	const [rerankingCheck, setRerankingCheck] = useState<RetrievalEndpointCheck>()
	const [checking, setChecking] = useState<"embedding" | "reranking">()
	const run = retrieval.run

	/** Ask the endpoint the tab now points at for its embedding models. */
	const refreshModels = useCallback(async () => {
		const result = await run({ action: "embeddingModels" })
		setModels(result?.models)
	}, [run])

	const save = useCallback(
		async (next: RetrievalEndpoints) => {
			try {
				await StateServiceClient.updateSettings(
					UpdateSettingsRequest.create({ retrievalEndpoints: JSON.stringify(next) }),
				)
				// What was checked is no longer what is set.
				setEmbeddingCheck(undefined)
				setRerankingCheck(undefined)
				await refreshModels()
			} catch (error) {
				console.error("Failed to save the embedding endpoints:", error)
			}
		},
		[refreshModels],
	)
	useEffect(() => {
		void refreshModels()
	}, [refreshModels])

	const check = async (which: "embedding" | "reranking") => {
		setChecking(which)
		const result = await run({ action: which === "embedding" ? "checkEmbedding" : "checkReranking" })
		if (which === "embedding") setEmbeddingCheck(result?.check)
		else setRerankingCheck(result?.check)
		setChecking(undefined)
	}
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
	const embeddingState = retrieval.status?.embedding
	// A list worth a dropdown: the server answered with at least one model.
	const listed = models !== undefined && models.models.length > 0
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

			{listed && !typing ? (
				<div>
					<label className="font-medium text-sm block mb-1" htmlFor="embedding-model">
						Embedding model
					</label>
					<VSCodeDropdown
						className="w-full"
						id="embedding-model"
						onChange={(event: any) => {
							const value = String(event.target.value ?? "")
							if (value === TYPE_A_NAME) setTyping(true)
							else saveEmbedding({ model: value })
						}}
						value={stored.embedding.model}>
						<VSCodeOption value="">Choose a model</VSCodeOption>
						{stored.embedding.model && !models.models.includes(stored.embedding.model) ? (
							<VSCodeOption value={stored.embedding.model}>
								{stored.embedding.model} (not on this server)
							</VSCodeOption>
						) : null}
						{models.models.map((name) => (
							<VSCodeOption key={name} value={name}>
								{name}
							</VSCodeOption>
						))}
						<VSCodeOption value={TYPE_A_NAME}>Type a name…</VSCodeOption>
					</VSCodeDropdown>
					<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
						{models.filtered
							? `The ${models.models.length} embedding model${models.models.length === 1 ? "" : "s"} on ${models.baseUrl}.`
							: `Every model on ${models.baseUrl}: this server does not say which of them embed.`}
					</p>
				</div>
			) : (
				<div>
					<DebouncedTextField
						className="w-full"
						initialValue={stored.embedding.model}
						onChange={(value) => saveEmbedding({ model: value.trim() })}
						placeholder="e.g. snowflake-arctic-embed2">
						<span className="font-medium">Embedding model</span>
					</DebouncedTextField>
					{listed ? (
						<VSCodeButton appearance="icon" onClick={() => setTyping(false)}>
							Pick from the server's list
						</VSCodeButton>
					) : models?.kind === "ollama" ? (
						<p className="text-xs mt-1 text-(--vscode-errorForeground)">
							{models.baseUrl} has no embedding model. Pull one there, for instance{" "}
							<code>ollama pull snowflake-arctic-embed2</code>.
						</p>
					) : models?.error ? (
						<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">{models.error}</p>
					) : null}
				</div>
			)}
			{stored.embedding.model === "" ? (
				<p className="text-xs -mt-2 text-(--vscode-errorForeground)">
					No model is named yet, so nothing is embedded and search stays on keywords.
				</p>
			) : null}
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

			<div>
				<VSCodeButton
					appearance="secondary"
					disabled={checking !== undefined || stored.embedding.model === ""}
					onClick={() => void check("embedding")}>
					{checking === "embedding" ? "Checking…" : "Check the embedding model"}
				</VSCodeButton>
				<p className="text-xs mt-1 text-(--vscode-descriptionForeground)">
					Embeds one sentence with the model
					{embeddingState?.baseUrl
						? ` at ${embeddingState.baseUrl}${embeddingState.source === "provider" ? ", the session's provider" : ""}`
						: ""}
					. The only way to know that a server embeds with a model: it can list one and still refuse.
				</p>
				<CheckResult check={embeddingCheck} />
			</div>

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
					<div>
						<VSCodeButton
							appearance="secondary"
							disabled={checking !== undefined || stored.reranking.model === "" || stored.reranking.baseUrl === ""}
							onClick={() => void check("reranking")}>
							{checking === "reranking" ? "Checking…" : "Check the reranking model"}
						</VSCodeButton>
						<CheckResult check={rerankingCheck} />
					</div>
					<p className="text-xs text-(--vscode-descriptionForeground)">
						Each key is sent as <code>Authorization: Bearer</code> to its own endpoint only, and kept in the editor's
						secret storage — which is why the fields look empty even when a key is stored.
					</p>
				</>
			) : null}
		</div>
	)
}

export default EmbeddingTab
