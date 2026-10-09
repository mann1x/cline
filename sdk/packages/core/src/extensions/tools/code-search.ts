/**
 * Search of a workspace's code by meaning, as `search_codebase` uses it.
 *
 * The index is the user's choice per folder (Settings > Library): building it
 * sends every source file in the folder to the embedding model. Where the
 * folder is opted in and an embedding model is set, this is the executor a
 * host hands to the tools; the index is brought up to date in the background,
 * and a search made before that is done says so instead of waiting.
 */

import { isCodeIndexWorkspace, type LibrarySettings } from "@cline/shared";
import {
	type CodeIndex,
	type CodeSearchResult,
	codeCollectionName,
	sharedCodeIndex,
} from "../../services/retrieval/code-index";
import type { RetrievalEndpoint } from "../../services/retrieval/embedding-client";
import type { SemanticSearchExecutor } from "./types";

export interface CodeSearchConfig {
	settings: LibrarySettings;
	/** The embedding model, when the user has set one. */
	embedding?: RetrievalEndpoint;
	/** The reranking model, when the user has set one. */
	reranker?: RetrievalEndpoint;
}

export interface CodeIndexProgress {
	/** What the refresh is doing now. */
	phase: "reading" | "embedding";
	done: number;
	total: number;
}

export interface CodeIndexRefreshState {
	running: boolean;
	progress?: CodeIndexProgress;
	/** Why the last refresh stopped short, when it did. */
	problem?: string;
	/** When the last refresh finished, in epoch milliseconds. */
	finishedAt?: number;
}

export interface CreateCodeSearchOptions {
	/** Read on every call: the settings can change mid-session. */
	getConfig: () => CodeSearchConfig;
	/** @default the shared code index of the data folder */
	index?: CodeIndex;
	/**
	 * Download LanceDB, which holds the vectors, when it is not installed. For
	 * a host with no panel to offer the download from. @default false
	 */
	install?: boolean;
	log?: (message: string) => void;
}

export interface CodeSearch extends SemanticSearchExecutor {
	/**
	 * Bring a folder's index up to date: read what changed, then embed what has
	 * no vectors. One at a time per folder; a second call joins the first.
	 * Resolves when it is done and never rejects: the state says what happened.
	 */
	refresh(root: string): Promise<void>;
	state(root: string): CodeIndexRefreshState;
}

/** Whether a folder is searched by meaning: opted in, with a model to embed with. */
export function codeSearchAvailable(
	config: CodeSearchConfig,
	root: string,
): boolean {
	return (
		config.embedding !== undefined &&
		isCodeIndexWorkspace(config.settings, root)
	);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The hits as the model reads them: where each passage is, then the passage. */
export function formatCodeHits(result: CodeSearchResult): string {
	const lines: string[] = [];
	for (const hit of result.hits) {
		const where =
			hit.startLine !== undefined
				? `${hit.path}:${hit.startLine}-${hit.endLine ?? hit.startLine}`
				: `${hit.path} (changed since it was indexed; read the file for the lines)`;
		lines.push(where, hit.text.trimEnd(), "");
	}
	return lines.join("\n").trimEnd();
}

export function createCodeSearch(options: CreateCodeSearchOptions): CodeSearch {
	const index = () => options.index ?? sharedCodeIndex();
	const running = new Map<string, Promise<void>>();
	const states = new Map<string, CodeIndexRefreshState>();

	const state = (root: string): CodeIndexRefreshState =>
		states.get(codeCollectionName(root)) ?? { running: false };

	const refresh = (root: string): Promise<void> => {
		const key = codeCollectionName(root);
		const inFlight = running.get(key);
		if (inFlight) return inFlight;
		const config = options.getConfig();
		if (!codeSearchAvailable(config, root) || !config.embedding) {
			return Promise.resolve();
		}
		const embedding = config.embedding;
		const set = (next: CodeIndexRefreshState) => states.set(key, next);
		set({ running: true });
		const run = (async () => {
			let problem: string | undefined;
			try {
				const synced = await index().sync(root, {
					settings: config.settings,
					onProgress: (done, total) =>
						set({ running: true, progress: { phase: "reading", done, total } }),
				});
				options.log?.(
					`code index ${root}: ${synced.files} files (${synced.added} added, ${synced.updated} updated, ${synced.removed} removed, ${synced.skipped} skipped${synced.truncated ? `, ${synced.truncated} over the limit` : ""})`,
				);
				const embedded = await index().embed(root, {
					embedding,
					settings: config.settings,
					...(options.install ? { install: true } : {}),
					onProgress: (done, total) =>
						set({
							running: true,
							progress: { phase: "embedding", done, total },
						}),
				});
				if (embedded.skipped) problem = embedded.skipped;
				options.log?.(
					`code index ${root}: embedded ${embedded.chunks} passages of ${embedded.documents} files${embedded.skipped ? ` (${embedded.skipped})` : ""}`,
				);
			} catch (error) {
				problem = describe(error);
				options.log?.(`code index ${root}: refresh failed: ${problem}`);
			} finally {
				running.delete(key);
				set({
					running: false,
					finishedAt: Date.now(),
					...(problem ? { problem } : {}),
				});
			}
		})();
		running.set(key, run);
		return run;
	};

	return {
		available: (cwd) => codeSearchAvailable(options.getConfig(), cwd),
		refresh,
		state,
		async search(query, cwd, _context, searchOptions) {
			const config = options.getConfig();
			if (!codeSearchAvailable(config, cwd)) {
				throw new Error(
					"this folder's code index was turned off in Settings > Library",
				);
			}
			const result = await index().search(cwd, query, {
				settings: config.settings,
				embedding: config.embedding,
				reranker: config.reranker,
				...(searchOptions?.readFile
					? { readFile: searchOptions.readFile }
					: {}),
			});
			const current = state(cwd);
			const notes = [...result.notes];
			if (current.running) {
				const progress = current.progress;
				notes.push(
					progress && progress.total > 0
						? `The index is still being built (${progress.phase} ${progress.done} of ${progress.total} files), so files may be missing from these results.`
						: "The index is still being built, so files may be missing from these results.",
				);
			} else if (current.problem) {
				notes.push(`The index is not up to date: ${current.problem}`);
			}
			const body =
				result.hits.length > 0
					? formatCodeHits(result)
					: "No passages matched. Try other words, or search with a regex.";
			return notes.length > 0
				? `${body}\n\n${notes.map((note) => `Note: ${note}`).join("\n")}`
				: body;
		},
	};
}

/**
 * The lead's code search as a delegated agent uses it.
 *
 * An agent is built without the lead's executors, so that none of them points
 * its file tools at the real workspace. This one only reads, and what it reads
 * for line numbers goes through the agent's own copy of the folder: a passage
 * in a file the agent has edited is given the lines it is on there.
 */
export function semanticSearchForAgent(
	lead: SemanticSearchExecutor | undefined,
	overlay: { read(path: string): Promise<Buffer> } | undefined,
): SemanticSearchExecutor | undefined {
	if (!lead) return undefined;
	if (!overlay) return lead;
	return {
		available: (cwd) => lead.available(cwd),
		search: (query, cwd, context) =>
			lead.search(query, cwd, context, {
				readFile: async (absolutePath) =>
					(await overlay.read(absolutePath)).toString("utf8"),
			}),
	};
}
