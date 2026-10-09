import { type CodeSearch, type CodeSearchConfig, createCodeSearch, sharedCodeIndex } from "@cline/core"
import { isCodeIndexWorkspace } from "@cline/shared"
import type { RetrievalCodeIndexStatus } from "@shared/retrieval-status"
import { Logger } from "@/shared/services/Logger"
import { readEmbeddingEndpoint, readLibrarySettings, readRerankingEndpoint } from "./library-config"

/**
 * The workspace's code searched by meaning: `search_codebase`'s
 * `mode: "semantic"`.
 *
 * Off until the user ticks it for a folder in Settings > Library, because
 * building the index sends every source file of the folder to the embedding
 * model. It uses the Embedding tab's model and the Library's search settings,
 * and is its own store: the Library does not have to be on.
 */

function readCodeSearchConfig(): CodeSearchConfig {
	const embedding = readEmbeddingEndpoint()
	const reranker = readRerankingEndpoint()
	return {
		settings: readLibrarySettings(),
		...(embedding ? { embedding } : {}),
		...(reranker ? { reranker } : {}),
	}
}

let search: CodeSearch | undefined

/** One for the extension host: every session's search and the panel's status share its runs. */
export function vscodeCodeSearch(): CodeSearch {
	search ??= createCodeSearch({
		getConfig: readCodeSearchConfig,
		log: (message) => Logger.log(`[CodeIndex] ${message}`),
	})
	return search
}

/**
 * Bring a folder's index up to date when it is opted in, without waiting:
 * called as a task starts, so the index follows the work between tasks.
 */
export function refreshCodeIndexInBackground(root: string): void {
	const codeSearch = vscodeCodeSearch()
	if (codeSearch.available(root)) {
		void codeSearch.refresh(root)
	}
}

/** The folder's index as the Library panel shows it. */
export function readCodeIndexStatus(root: string): RetrievalCodeIndexStatus {
	// Ticked, whether or not there is a model to embed with yet: the panel
	// says which of the two is missing.
	const enabled = isCodeIndexWorkspace(readLibrarySettings(), root)
	const state = vscodeCodeSearch().state(root)
	let files = 0
	let passages = 0
	try {
		const status = sharedCodeIndex().status(root)
		files = status.files
		passages = status.chunks
	} catch (error) {
		Logger.warn(`[CodeIndex] status could not be read: ${error instanceof Error ? error.message : String(error)}`)
	}
	return {
		enabled,
		files,
		passages,
		running: state.running,
		...(state.progress ? { progress: state.progress } : {}),
		...(state.problem ? { problem: state.problem } : {}),
		...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
	}
}
