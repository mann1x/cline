/**
 * The Library: documents kept for retrieval.
 *
 * It ties the pieces together. Text goes in as chunks in SQLite, where it is
 * searchable by keyword at once; vectors are a second pass that needs an
 * embedding model and LanceDB, and can be run later, resumed, or never.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LIBRARY_SETTINGS, type LibrarySettings } from "@cline/shared";
import { resolveClineDataDir } from "@cline/shared/storage";
import { Catalogue } from "./catalogue";
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
	type AddDocumentResult,
	type LibraryDocument,
	LibraryStore,
} from "./library-store";
import { type RetrieveResult, retrieve } from "./retrieve";
import { VectorIndex, vectorTableName } from "./vector-index";

/** The text a model is asked to embed to learn its size and tell it apart. */
const MODEL_PROBE_TEXT = "size";
/**
 * The same model gives the same vector for the same text, to rounding:
 * batching on a GPU moves the last digits. A re-pulled model does not.
 */
const SAME_MODEL_COSINE = 0.999;

function cosine(a: readonly number[], b: readonly number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let at = 0; at < a.length; at++) {
		dot += a[at] * b[at];
		na += a[at] * a[at];
		nb += b[at] * b[at];
	}
	return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

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
	/**
	 * Ask the model for one vector first, to learn the size it returns now.
	 * For a run the user asked for: without it, a model that changed size
	 * since everything was embedded looks finished until the next search.
	 */
	probe?: boolean;
	signal?: AbortSignal;
}

export interface EmbedPendingResult {
	documents: number;
	chunks: number;
	dimension?: number;
	/** Why nothing was embedded, when that is so. */
	skipped?: string;
}

export interface LibraryVectorSet {
	/** What `deleteVectorSet` takes. */
	table: string;
	model: string;
	dimension: number;
	vectors: number;
	/** Documents recorded as embedded with it. */
	documents: number;
	bytes: number;
	/** The set the embedding model now set writes to and searches. */
	current: boolean;
}

function directoryBytes(path: string): number {
	let total = 0;
	try {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			total += entry.isDirectory()
				? directoryBytes(child)
				: statSync(child).size;
		}
	} catch {
		// Not there, or not readable: nothing to count.
	}
	return total;
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
	/** Where this Library is kept. */
	readonly directory: string;
	private readonly runtimeDirectory: string;
	private readonly fetch?: typeof fetch;
	private index?: Promise<VectorIndex>;
	private shelves?: Catalogue;
	/** Documents a run is embedding now, by model: another run leaves them to it. */
	private readonly embedding = new Set<string>();
	/** Models whose probe was checked by this process. */
	private readonly probed = new Set<string>();
	/**
	 * The last write to the vectors. Writes take turns: two runs creating or
	 * compacting a table at once, LanceDB refuses the second. The requests
	 * to the embedding model, the slow part, still run side by side.
	 */
	private writing: Promise<unknown> = Promise.resolve();

	constructor(options: LibraryOptions = {}) {
		this.directory = options.directory ?? resolveLibraryDirectory();
		this.runtimeDirectory =
			options.runtimeDirectory ?? resolveLanceDbRuntimeDirectory();
		this.fetch = options.fetch;
		mkdirSync(this.directory, { recursive: true });
		this.store = new LibraryStore(join(this.directory, "library.db"));
	}

	/**
	 * The sections, shelves and books. Made on first use: Memory keeps its
	 * notes in a store of the same kind and has no shelves.
	 */
	get catalogue(): Catalogue {
		this.shelves ??= new Catalogue(this);
		return this.shelves;
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
		if (index) await this.exclusive(() => index.deleteDocuments(documentIds));
	}

	async removeDocument(documentId: number): Promise<void> {
		this.store.deleteDocument(documentId);
		await this.dropVectors([documentId]);
	}

	async removeCollection(collectionId: number): Promise<void> {
		this.store.deleteCollection(collectionId);
		const index = await this.vectors().catch(() => undefined);
		if (index) await this.exclusive(() => index.deleteCollection(collectionId));
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
		if (options.probe) {
			await this.checkModel(options.embedding, settings, options.signal);
		}
		let pending = this.store.documentsWithoutEmbedding(
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
		let documentsDone = 0;
		let dimension: number | undefined;
		for (let at = 0; at < pending.length; at += 1) {
			const document = pending[at];
			options.signal?.throwIfAborted();
			// Two runs at once (a book added while the rest catch up) would
			// both write its vectors; the second leaves it to the first.
			// Held until the document is marked, and a document another run
			// finished since this list was made is not done twice.
			const claim = `${model}\n${document.id}`;
			if (
				this.embedding.has(claim) ||
				this.store.isEmbedded(document.id, model)
			) {
				continue;
			}
			this.embedding.add(claim);
			let resized: boolean;
			let chunks: ReturnType<LibraryStore["documentChunks"]>;
			try {
				chunks = this.store.documentChunks(document.id);
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
				// The model answers with another size than it last did: a re-pulled
				// tag, a truncated variant. Everything counted as embedded was
				// embedded at the old size, so the list of what is left is made
				// again, against the size it returns now.
				resized = this.store.noteDimension(model, embedded.dimension);
				// What an earlier, unfinished run wrote for this document, in this
				// model's own set only: its vectors for other models stay.
				const written = chunks;
				await this.exclusive(async () => {
					await index.deleteDocumentsIn(model, embedded.dimension, [
						document.id,
					]);
					await index.add(
						model,
						written.map((chunk, n) => ({
							chunkId: chunk.chunkId,
							collectionId: chunk.collectionId,
							documentId: chunk.documentId,
							vector: embedded.vectors[n],
						})),
					);
				});
				this.store.markEmbedded(document.id, model, embedded.dimension);
			} finally {
				this.embedding.delete(claim);
			}
			chunksDone += chunks.length;
			documentsDone += 1;
			if (resized) {
				pending = this.store.documentsWithoutEmbedding(
					model,
					options.collectionIds,
					dimension,
				);
				at = -1;
			}
			options.onProgress?.({
				document,
				documentIndex: documentsDone - 1,
				documentCount: resized
					? documentsDone + pending.length
					: Math.max(pending.length, documentsDone),
				chunksDone,
			});
		}
		if (dimension !== undefined) {
			await this.optimize(index, model, dimension);
		}
		return { documents: documentsDone, chunks: chunksDone, dimension };
	}

	/** Run one write to the vectors when the one before it is done. */
	private exclusive<T>(write: () => Promise<T>): Promise<T> {
		const run = this.writing.then(write);
		this.writing = run.catch(() => {});
		return run;
	}

	/**
	 * Compact a set of vectors after a run. A conflict can still come from a
	 * writer outside this process; it is tried once more. It is
	 * housekeeping: the vectors are written either way.
	 */
	private optimize(
		index: VectorIndex,
		model: string,
		dimension: number,
	): Promise<void> {
		return this.exclusive(async () => {
			try {
				await index.optimize(model, dimension);
			} catch (error) {
				if (!/commit conflict/i.test(String(error))) throw error;
				await index.optimize(model, dimension);
			}
		});
	}

	/**
	 * Ask the model for the vector of a fixed text and hold it against the
	 * one it gave last time. The size tells a truncated variant apart; this
	 * tells a model re-pulled under the same name and size, whose vectors no
	 * longer compare with the ones kept. Those are then dropped, and every
	 * document is embedded again. True when that happened.
	 */
	async checkModel(
		embedding: RetrievalEndpoint,
		settings: LibrarySettings = DEFAULT_LIBRARY_SETTINGS,
		signal?: AbortSignal,
	): Promise<boolean> {
		const model = embedding.model;
		const probed = await embedTexts(embedding, [MODEL_PROBE_TEXT], {
			prefix: settings.embeddingDocumentPrefix || undefined,
			signal,
			fetch: this.fetch,
		});
		this.probed.add(model);
		const vector = Array.from(probed.vectors[0]);
		const before = this.store.knownProbe(model);
		const sameSize = this.store.knownDimension(model) === vector.length;
		this.store.noteProbe(model, vector);
		if (!before || !sameSize || before.length !== vector.length) return false;
		if (cosine(before, vector) >= SAME_MODEL_COSINE) return false;
		const index = await this.vectors().catch(() => undefined);
		if (index) {
			await this.exclusive(() =>
				index.dropSet(vectorTableName(model, vector.length)),
			);
		}
		this.store.forgetEmbeddings(model, vector.length);
		return true;
	}

	/**
	 * Embed whatever has no vectors for this model, in every collection, and
	 * check the model once per process first. For after something was
	 * added: a model changed since covers more than the one book.
	 */
	catchUpEmbeddings(
		options: Omit<EmbedPendingOptions, "collectionIds" | "probe">,
	): Promise<EmbedPendingResult> {
		return this.embedPending({
			...options,
			probe: !this.probed.has(options.embedding.model),
		});
	}

	/**
	 * The sets of vectors on disk: one per embedding model and vector size.
	 * A change of model starts a new set and keeps the old one, so going back
	 * costs nothing -- and so they add up until one is deleted.
	 */
	async vectorSets(current?: string): Promise<LibraryVectorSet[]> {
		const index = await this.vectors().catch(() => undefined);
		if (!index) return [];
		const recorded = this.store.embeddingSets();
		const inUse = current
			? vectorTableName(current, this.store.knownDimension(current) ?? -1)
			: undefined;
		const sets: LibraryVectorSet[] = [];
		for (const set of await index.sets()) {
			const known = recorded.filter(
				(entry) => vectorTableName(entry.model, entry.dimension) === set.table,
			);
			sets.push({
				table: set.table,
				// The model's own name, when the store still has it; the table
				// only keeps a simplified spelling.
				model: known[0]?.model ?? set.table.replace(/^vectors_/, ""),
				dimension: set.dimension,
				vectors: set.rows,
				documents: known.reduce((sum, entry) => sum + entry.documents, 0),
				bytes: directoryBytes(
					join(this.directory, "vectors", `${set.table}.lance`),
				),
				current: set.table === inUse,
			});
		}
		return sets;
	}

	/** Delete one set of vectors, and forget that its documents were embedded with it. */
	async deleteVectorSet(table: string): Promise<boolean> {
		const index = await this.vectors().catch(() => undefined);
		if (!index || !(await this.exclusive(() => index.dropSet(table)))) {
			return false;
		}
		for (const entry of this.store.embeddingSets()) {
			if (vectorTableName(entry.model, entry.dimension) === table) {
				this.store.forgetEmbeddings(entry.model, entry.dimension);
			}
		}
		return true;
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
		if (options.embedding && !index && notes.length === 0) {
			// Without this the search is keywords alone and nothing says so:
			// "nothing by meaning" and "never searched by meaning" read the same.
			const unsupported = lanceDbUnsupportedReason();
			notes.push(
				`Semantic search did not run (${unsupported ?? "LanceDB is not installed yet"}); searched by keyword.`,
			);
		}
		const result = await retrieve(query, {
			store: this.store,
			collectionIds: options.collectionIds,
			// The query's vector says what size the model returns now, which
			// is how a change of size is noticed without a request of its own.
			vectors: index && {
				search: (model, vector, searchOptions) => {
					this.store.noteDimension(model, vector.length);
					return index.search(model, vector, searchOptions);
				},
			},
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

const shared = new Map<string, Library>();

/**
 * Closes every Library this process opened. For shutdown: the SQLite file is
 * checkpointed and released, and the next `sharedLibrary()` opens it afresh.
 */
export async function closeSharedLibraries(): Promise<void> {
	const open = [...shared.values()];
	shared.clear();
	await Promise.all(open.map((library) => library.close().catch(() => {})));
}

/** The one Library of a folder in this process: SQLite and LanceDB are opened once. */
export function sharedLibrary(options: LibraryOptions = {}): Library {
	const directory = options.directory ?? resolveLibraryDirectory();
	let library = shared.get(directory);
	if (!library) {
		library = new Library({ ...options, directory });
		shared.set(directory, library);
	}
	return library;
}
