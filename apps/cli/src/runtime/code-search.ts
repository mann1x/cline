import type { SemanticSearchExecutor } from "@cline/core";

/**
 * `--code-index` (or `CLINE_CODE_INDEX=1`): the folder's code searched by
 * meaning, the extension's "Index the code of this folder" switch.
 *
 * `search_codebase` gains `mode: "semantic"` for the run's folder. The
 * embedding model is named by environment (`CLINE_EMBEDDING_BASE_URL`,
 * `CLINE_EMBEDDING_MODEL`), as there is no Embedding tab here, and without one
 * the switch does nothing but say so: an index nothing can embed into would
 * offer the model a search that only ever matches keywords.
 *
 * Kept here, not on the session config: the config is data that can cross to
 * a hub, and this is a function the local runtime calls.
 */
let codeSearch: SemanticSearchExecutor | undefined;

export function getCliCodeSearch(): SemanticSearchExecutor | undefined {
	return codeSearch;
}

export interface CliCodeSearchInput {
	cwd: string;
	embeddingBaseUrl?: string;
	embeddingModel?: string;
	embeddingApiKey?: string;
	warn: (message: string) => void;
	log?: (message: string) => void;
}

/**
 * Turn the code search on for this run's folder and start bringing its index
 * up to date. Returns false, having said why, when there is no embedding model.
 */
export async function enableCliCodeSearch(
	input: CliCodeSearchInput,
): Promise<boolean> {
	if (!input.embeddingBaseUrl || !input.embeddingModel) {
		input.warn(
			"--code-index needs an embedding model: set CLINE_EMBEDDING_BASE_URL and CLINE_EMBEDDING_MODEL. The code index is off for this run.",
		);
		return false;
	}
	const { createCodeSearch, DEFAULT_LIBRARY_SETTINGS } = await import(
		"@cline/core"
	);
	const embedding = {
		baseUrl: input.embeddingBaseUrl,
		model: input.embeddingModel,
		...(input.embeddingApiKey ? { apiKey: input.embeddingApiKey } : {}),
	};
	const search = createCodeSearch({
		getConfig: () => ({
			settings: {
				...DEFAULT_LIBRARY_SETTINGS,
				codeIndexWorkspaces: [input.cwd],
			},
			embedding,
		}),
		// There is no panel here to offer the download from, and the flag
		// is the user asking for it.
		install: true,
		...(input.log ? { log: input.log } : {}),
	});
	codeSearch = search;
	// Not awaited: a first index takes minutes, and a search made meanwhile
	// says that files may be missing.
	void search.refresh(input.cwd);
	return true;
}

/** For tests. */
export function resetCliCodeSearch(): void {
	codeSearch = undefined;
}
