/**
 * The Library: documents kept for retrieval.
 *
 * It ties the pieces together. Text goes in as chunks in SQLite, where it is
 * searchable by keyword at once; vectors are a second pass that needs an
 * embedding model and LanceDB, and can be run later, resumed, or never.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveClineDataDir } from "@cline/shared/storage";
import { chunkText } from "./chunker";
import { embedTexts, type RetrievalEndpoint } from "./embedding-client";
import {
	ensureLanceDb,
	isLanceDbInstalled,
	type LanceDbInstallProgress,
	lanceDbUnsupportedReason,
	loadLanceDb,
} from "./lancedb-runtime";
import {
	DEFAULT_LIBRARY_SETTINGS,
	type LibrarySettings,
} from "./library-settings";
import {
	type AddDocumentResult,
	type LibraryDocument,
	LibraryStore,
} from "./library-store";
import { type RetrieveResult, retrieve } from "./retrieve";
import { VectorIndex } from "./vector-index";

export function resolveLibraryDirectory(): string {
	return join(resolveClineDataDir(), "library");
}

export function resolveLanceDbRuntimeDirectory(): string {
	return join(resolveClineDataDir(), "runtimes", "lancedb");
}

export interface LibraryOptions {
	/** Where the Library is kept. @default <data dir>/library */
	directory?: string;
	/** Where LanceDB is installed. @default <data dir>/runtimes/lancedb */
	runtimeDirectory?: string;
	fetch?: typeof fetch;
}

export interface LibraryDocumentText {
	source: string;
	title?: string;
	/** The document as text or markdown. */
	text: string;
	bytes?: number;
	metadata?: Record<string, unknown>;
}

export interface EmbedProgress {
	document: LibraryDocument;
	documentIndex: number;
	documentCount: number;
	chunksDone: number;
}

export interface EmbedPendingOptions {
	embedding: RetrievalEndpoint;
	settings?: LibrarySettings;
	collectionIds?: readonly number[];
	/**
	 * Download LanceDB when it is not installed. Off, a Library with no
	 * LanceDB embeds nothing and says why.
	 */
	install?: boolean;
	onInstallProgress?: (progress: LanceDbInstallProgress) => void;
	onProgress?: (progress: EmbedProgress) => void;
	signal?: AbortSignal;
}

export interface EmbedPendingResult {
	documents: number;
	chunks: number;
	dimension?: number;
	/** Why nothing was embedded, when that is so. */
	skipped?: string;
}

export interface LibrarySearchOptions {
	settings?: LibrarySettings;
	collectionIds?: readonly number[];
	embedding?: RetrievalEndpoint;
	reranker?: RetrievalEndpoint;
	signal?: AbortSignal;
}

export class Library {
	readonly store: LibraryStore;
	private readonly directory: string;
	private readonly runtimeDirectory: string;
	private readonly fetch?: typeof fetch;
	private index?: Promise<VectorIndex>;

	constructor(options: LibraryOptions = {}) {
		this.directory = options.directory ?? resolveLibraryDirectory();
		this.runtimeDirectory =
			options.runtimeDirectory ?? resolveLanceDbRuntimeDirectory();
		this.fetch = options.fetch;
		mkdirSync(this.directory, { recursive: true });
		this.store = new LibraryStore(join(this.directory, "library.db"));
	}

	/** Whether vectors can be used here now, and if not, why. */
	vectorState(): { installed: boolean; unsupported?: string } {
		return {
			installed: isLanceDbInstalled({ directory: this.runtimeDirectory }),
			unsupported: lanceDbUnsupportedReason(),
		};
	}

	/** The vector index, when LanceDB is installed (or `install` asks for it). */
	async vectors(
		options: {
			install?: boolean;
			onInstallProgress?: (progress: LanceDbInstallProgress) => void;
			signal?: AbortSignal;
		} = {},
	): Promise<VectorIndex | undefined> {
		if (!this.index) {
			const runtime = { directory: this.runtimeDirectory };
			if (!isLanceDbInstalled(runtime) && !options.install) {
				return undefined;
			}
			const opening = (async () =>
				VectorIndex.open(
					options.install
						? await ensureLanceDb({
								...runtime,
								fetch: this.fetch,
								onProgress: options.onInstallProgress,
								signal: options.signal,
							})
						: loadLanceDb(runtime),
					join(this.directory, "vectors"),
				))();
			this.index = opening;
			// A failed open is not remembered: the next call tries again.
			opening.catch(() => {
				if (this.index === opening) this.index = undefined;
			});
		}
		return this.index;
	}

	/**
	 * Add a document's text to a collection. It is searchable by keyword as
	 * soon as this returns; `embedPending` gives it vectors.
	 */
	async addDocument(
		collection: string,
		document: LibraryDocumentText,
		settings: LibrarySettings = DEFAULT_LIBRARY_SETTINGS,
	): Promise<AddDocumentResult> {
		const { id } = this.store.ensureCollection(collection);
		const chunks = chunkText(document.text, {
			size: settings.chunkSize,
			overlap: settings.chunkOverlap,
			minSize: settings.chunkMinSize,
			unit: settings.splitter,
			markdownHeaders: settings.markdownHeaders,
		});
		const result = this.store.addDocument(
			id,
			{
				source: document.source,
				title: document.title,
				// The chunking is part of what was stored: new settings re-chunk.
				contentHash: createHash("sha256")
					.update(
						`${settings.splitter}:${settings.chunkSize}:${settings.chunkOverlap}:${settings.chunkMinSize}:${settings.markdownHeaders}\n`,
					)
					.update(document.text)
					.digest("hex"),
				bytes: document.bytes ?? Buffer.byteLength(document.text),
				metadata: document.metadata,
			},
			chunks,
		);
		if (result.replacedDocumentId !== undefined) {
			await this.dropVectors([result.replacedDocumentId]);
		}
		return result;
	}

	private async dropVectors(documentIds: readonly number[]): Promise<void> {
		const index = await this.vectors().catch(() => undefined);
		await index?.deleteDocuments(documentIds);
	}

	async removeDocument(documentId: number): Promise<void> {
		this.store.deleteDocument(documentId);
		await this.dropVectors([documentId]);
	}

	async removeCollection(collectionId: number): Promise<void> {
		this.store.deleteCollection(collectionId);
		const index = await this.vectors().catch(() => undefined);
		await index?.deleteCollection(collectionId);
	}

	/**
	 * Give vectors to every document that has none for this embedding model.
	 * A document is marked done only when all of its vectors are written, so
	 * a run that is stopped or fails is picked up where it left off.
	 */
	async embedPending(
		options: EmbedPendingOptions,
	): Promise<EmbedPendingResult> {
		const settings = options.settings ?? DEFAULT_LIBRARY_SETTINGS;
		const model = options.embedding.model;
		const pending = this.store.documentsWithoutEmbedding(
			model,
			options.collectionIds,
		);
		if (pending.length === 0) {
			return { documents: 0, chunks: 0 };
		}
		const unsupported = lanceDbUnsupportedReason();
		if (unsupported) {
			return { documents: 0, chunks: 0, skipped: unsupported };
		}
		const index = await this.vectors({
			install: options.install,
			onInstallProgress: options.onInstallProgress,
			signal: options.signal,
		});
		if (!index) {
			return {
				documents: 0,
				chunks: 0,
				skipped: "LanceDB is not installed yet.",
			};
		}
		let chunksDone = 0;
		let dimension: number | undefined;
		for (const [documentIndex, document] of pending.entries()) {
			options.signal?.throwIfAborted();
			const chunks = this.store.documentChunks(document.id);
			const embedded = await embedTexts(
				options.embedding,
				chunks.map((chunk) => chunk.text),
				{
					batchSize: settings.embeddingBatchSize,
					concurrency: settings.embeddingConcurrency,
					prefix: settings.embeddingDocumentPrefix || undefined,
					signal: options.signal,
					fetch: this.fetch,
				},
			);
			dimension = embedded.dimension;
			// What an earlier, unfinished run wrote for this document.
			await index.deleteDocuments([document.id]);
			await index.add(
				model,
				chunks.map((chunk, at) => ({
					chunkId: chunk.chunkId,
					collectionId: chunk.collectionId,
					documentId: chunk.documentId,
					vector: embedded.vectors[at],
				})),
			);
			this.store.markEmbedded(document.id, model, embedded.dimension);
			chunksDone += chunks.length;
			options.onProgress?.({
				document,
				documentIndex,
				documentCount: pending.length,
				chunksDone,
			});
		}
		if (dimension !== undefined) {
			await index.optimize(model, dimension);
		}
		return { documents: pending.length, chunks: chunksDone, dimension };
	}

	async search(
		query: string,
		options: LibrarySearchOptions = {},
	): Promise<RetrieveResult> {
		const settings = options.settings ?? DEFAULT_LIBRARY_SETTINGS;
		const notes: string[] = [];
		const index = options.embedding
			? await this.vectors().catch((error) => {
					notes.push(
						`Semantic search did not run (${error instanceof Error ? error.message : String(error)}); searched by keyword.`,
					);
					return undefined;
				})
			: undefined;
		const result = await retrieve(query, {
			store: this.store,
			collectionIds: options.collectionIds,
			vectors: index,
			embedding: options.embedding && {
				...options.embedding,
				queryPrefix: settings.embeddingQueryPrefix || undefined,
			},
			reranker: options.reranker && {
				...options.reranker,
				batchSize: settings.rerankingBatchSize,
			},
			hybrid: settings.hybridSearch,
			enrich: settings.enrichHybridText,
			bm25Weight: settings.bm25Weight,
			topK: settings.topK,
			topKReranker: settings.topKReranker,
			relevanceThreshold: settings.relevanceThreshold,
			signal: options.signal,
			fetch: this.fetch,
		});
		return { ...result, notes: [...notes, ...result.notes] };
	}

	async close(): Promise<void> {
		const index = await this.index?.catch(() => undefined);
		index?.close();
		this.index = undefined;
		this.store.close();
	}
}
