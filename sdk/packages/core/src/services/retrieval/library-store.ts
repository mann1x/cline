/**
 * The Library's text store: collections, their documents, and the chunks
 * each document was cut into, in one SQLite file with a full-text index.
 *
 * This is the part of the Library that needs no model. Keyword search works
 * from the moment a document is added; vectors, when an embedding model is
 * set, are kept elsewhere and refer to a chunk by the id it has here.
 *
 * The index is FTS5's external-content form, so the text of a library of
 * books is stored once, in `chunks`, and not a second time in the index.
 */

import { loadSqliteDb, type SqliteDb } from "@cline/shared/db";
import type { TextChunk } from "./chunker";

export interface LibraryCollection {
	id: number;
	name: string;
	createdAt: string;
	documents: number;
	chunks: number;
}

export interface LibraryDocumentInput {
	/** Where it came from: a path or a URL. One document per source in a collection. */
	source: string;
	title?: string;
	/** A hash of the content. A source added again with the same hash is left alone. */
	contentHash: string;
	bytes?: number;
	/** Anything else worth keeping: author, language, pages. */
	metadata?: Record<string, unknown>;
}

export interface LibraryDocument {
	id: number;
	collectionId: number;
	source: string;
	title?: string;
	contentHash: string;
	bytes?: number;
	chunks: number;
	addedAt: string;
	metadata: Record<string, unknown>;
}

export interface AddDocumentResult {
	document: LibraryDocument;
	/** "unchanged" when the same content was already there and nothing was written. */
	outcome: "added" | "replaced" | "unchanged";
	/** The ids given to the chunks, in order. Empty for "unchanged". */
	chunkIds: number[];
	/**
	 * For "replaced": the id the document had before. Its chunks are gone, and
	 * whatever else was kept under that id (its vectors) is the caller's to remove.
	 */
	replacedDocumentId?: number;
}

export interface KeywordSearchOptions {
	/** Collections to search. All of them when left out. */
	collectionIds?: readonly number[];
	/** Hits returned. Default 10. */
	limit?: number;
	/**
	 * Also match the document's file name, title and section headers, at this
	 * weight against the text's 1. 0 searches the text alone. Default 0.5.
	 */
	contextWeight?: number;
}

export interface LibraryHit {
	chunkId: number;
	documentId: number;
	collectionId: number;
	/** Higher is better. BM25 for keyword hits; not comparable across queries. */
	score: number;
	text: string;
	start: number;
	end: number;
	headings: string[];
	source: string;
	title?: string;
}

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS collections (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS documents (
		id INTEGER PRIMARY KEY,
		collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
		source TEXT NOT NULL,
		title TEXT,
		content_hash TEXT NOT NULL,
		bytes INTEGER,
		chunk_count INTEGER NOT NULL DEFAULT 0,
		added_at TEXT NOT NULL,
		metadata TEXT NOT NULL DEFAULT '{}',
		UNIQUE (collection_id, source)
	)`,
	`CREATE TABLE IF NOT EXISTS chunks (
		id INTEGER PRIMARY KEY,
		document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
		collection_id INTEGER NOT NULL,
		ord INTEGER NOT NULL,
		text TEXT NOT NULL,
		context TEXT NOT NULL DEFAULT '',
		start_offset INTEGER NOT NULL,
		end_offset INTEGER NOT NULL,
		headings TEXT NOT NULL DEFAULT '[]'
	)`,
	"CREATE INDEX IF NOT EXISTS chunks_by_document ON chunks(document_id, ord)",
	// Which documents have their vectors written, per embedding model. The
	// vectors themselves are elsewhere; a row here is written only after all
	// of a document's vectors are, so an interrupted run is simply resumed.
	`CREATE TABLE IF NOT EXISTS document_embeddings (
		document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
		model TEXT NOT NULL,
		dimension INTEGER NOT NULL,
		embedded_at TEXT NOT NULL,
		PRIMARY KEY (document_id, model)
	)`,
	// unicode61 and no stemmer: a library is not all in one language.
	`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
		text, context,
		content='chunks', content_rowid='id',
		tokenize="unicode61 remove_diacritics 2"
	)`,
	`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vocab USING fts5vocab(chunks_fts, 'row')`,
	`CREATE TRIGGER IF NOT EXISTS chunks_fts_insert AFTER INSERT ON chunks BEGIN
		INSERT INTO chunks_fts(rowid, text, context) VALUES (new.id, new.text, new.context);
	END`,
	`CREATE TRIGGER IF NOT EXISTS chunks_fts_delete AFTER DELETE ON chunks BEGIN
		INSERT INTO chunks_fts(chunks_fts, rowid, text, context) VALUES ('delete', old.id, old.text, old.context);
	END`,
];

/**
 * A query term found in more than this share of all chunks says nothing
 * about which chunk is wanted, and makes the search read most of the index.
 */
const COMMON_TERM_SHARE = 0.2;
/** Below this many chunks every term is kept: shares mean nothing yet. */
const COMMON_TERM_MIN_CHUNKS = 200;

/** The words of a query, as the index's tokenizer would see them. */
export function queryTerms(query: string): string[] {
	const seen = new Set<string>();
	for (const match of query
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.matchAll(/[\p{L}\p{N}]+/gu)) {
		seen.add(match[0]);
	}
	return [...seen];
}

/** What the index also matches on for a chunk: file name, title, headers. */
export function chunkContext(
	document: Pick<LibraryDocumentInput, "source" | "title">,
	headings: readonly string[],
): string {
	const name = document.source.split(/[\\/]/).pop() ?? document.source;
	return [name.replace(/[._-]+/g, " "), document.title ?? "", ...headings]
		.map((part) => part.trim())
		.filter(Boolean)
		.join(" | ");
}

function parseJson<T>(value: unknown, fallback: T): T {
	try {
		return typeof value === "string" ? (JSON.parse(value) as T) : fallback;
	} catch {
		return fallback;
	}
}

export class LibraryStore {
	private readonly db: SqliteDb;

	constructor(filePath: string) {
		this.db = loadSqliteDb(filePath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.db.exec("PRAGMA foreign_keys = ON;");
		for (const statement of SCHEMA) {
			this.db.exec(statement);
		}
	}

	close(): void {
		this.db.close?.();
	}

	private transaction<T>(run: () => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const result = run();
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}

	/** The collection of that name, created if it is not there. */
	ensureCollection(name: string): LibraryCollection {
		const trimmed = name.trim();
		if (!trimmed) {
			throw new Error("A collection needs a name.");
		}
		this.db
			.prepare(
				"INSERT INTO collections(name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING",
			)
			.run(trimmed, new Date().toISOString());
		const found = this.listCollections().find(
			(collection) => collection.name === trimmed,
		);
		if (!found) {
			throw new Error(`Collection '${trimmed}' could not be created.`);
		}
		return found;
	}

	/** Give a collection another name. The documents and vectors stay as they are. */
	renameCollection(collectionId: number, name: string): void {
		const trimmed = name.trim();
		if (!trimmed) {
			throw new Error("A collection needs a name.");
		}
		this.db
			.prepare("UPDATE collections SET name = ? WHERE id = ?")
			.run(trimmed, collectionId);
	}

	listCollections(): LibraryCollection[] {
		return this.db
			.prepare(
				`SELECT c.id, c.name, c.created_at,
					(SELECT COUNT(*) FROM documents d WHERE d.collection_id = c.id) AS documents,
					(SELECT COALESCE(SUM(d.chunk_count), 0) FROM documents d WHERE d.collection_id = c.id) AS chunks
				FROM collections c ORDER BY c.name`,
			)
			.all()
			.map((row) => ({
				id: Number(row.id),
				name: String(row.name),
				createdAt: String(row.created_at),
				documents: Number(row.documents),
				chunks: Number(row.chunks),
			}));
	}

	/** Removes the collection with its documents and chunks. */
	deleteCollection(collectionId: number): void {
		this.transaction(() => {
			// Chunks first and by statement: the index is kept by a trigger on
			// `chunks`, and a cascade's deletes fire it only with recursive
			// triggers on.
			this.db
				.prepare("DELETE FROM chunks WHERE collection_id = ?")
				.run(collectionId);
			this.db.prepare("DELETE FROM collections WHERE id = ?").run(collectionId);
		});
	}

	private toDocument(row: Record<string, unknown>): LibraryDocument {
		return {
			id: Number(row.id),
			collectionId: Number(row.collection_id),
			source: String(row.source),
			title: typeof row.title === "string" ? row.title : undefined,
			contentHash: String(row.content_hash),
			bytes: typeof row.bytes === "number" ? row.bytes : undefined,
			chunks: Number(row.chunk_count),
			addedAt: String(row.added_at),
			metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
		};
	}

	listDocuments(collectionId: number): LibraryDocument[] {
		return this.db
			.prepare(
				"SELECT * FROM documents WHERE collection_id = ? ORDER BY source",
			)
			.all(collectionId)
			.map((row) => this.toDocument(row));
	}

	findDocument(
		collectionId: number,
		source: string,
	): LibraryDocument | undefined {
		const row = this.db
			.prepare("SELECT * FROM documents WHERE collection_id = ? AND source = ?")
			.get(collectionId, source);
		return row ? this.toDocument(row) : undefined;
	}

	/**
	 * Adds a document with its chunks, in one transaction. The same source
	 * with the same content is left as it is; with different content, the old
	 * chunks are replaced.
	 */
	addDocument(
		collectionId: number,
		input: LibraryDocumentInput,
		chunks: readonly TextChunk[],
	): AddDocumentResult {
		return this.transaction(() => {
			const existing = this.findDocument(collectionId, input.source);
			if (existing && existing.contentHash === input.contentHash) {
				return { document: existing, outcome: "unchanged", chunkIds: [] };
			}
			if (existing) {
				this.db
					.prepare("DELETE FROM chunks WHERE document_id = ?")
					.run(existing.id);
				this.db.prepare("DELETE FROM documents WHERE id = ?").run(existing.id);
			}
			const inserted = this.db
				.prepare(
					`INSERT INTO documents(collection_id, source, title, content_hash, bytes, chunk_count, added_at, metadata)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					collectionId,
					input.source,
					input.title ?? null,
					input.contentHash,
					input.bytes ?? null,
					chunks.length,
					new Date().toISOString(),
					JSON.stringify(input.metadata ?? {}),
				);
			const documentId = Number(inserted.lastInsertRowid);
			const insertChunk = this.db.prepare(
				`INSERT INTO chunks(document_id, collection_id, ord, text, context, start_offset, end_offset, headings)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			const chunkIds = chunks.map((chunk) =>
				Number(
					insertChunk.run(
						documentId,
						collectionId,
						chunk.index,
						chunk.text,
						chunkContext(input, chunk.headings),
						chunk.start,
						chunk.end,
						JSON.stringify(chunk.headings),
					).lastInsertRowid,
				),
			);
			const document = this.findDocument(collectionId, input.source);
			if (!document) {
				throw new Error(`Document '${input.source}' was not stored.`);
			}
			return {
				document,
				outcome: existing ? "replaced" : "added",
				chunkIds,
				replacedDocumentId: existing?.id,
			};
		});
	}

	deleteDocument(documentId: number): void {
		this.transaction(() => {
			this.db
				.prepare("DELETE FROM chunks WHERE document_id = ?")
				.run(documentId);
			this.db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
		});
	}

	getDocument(documentId: number): LibraryDocument | undefined {
		const row = this.db
			.prepare("SELECT * FROM documents WHERE id = ?")
			.get(documentId);
		return row ? this.toDocument(row) : undefined;
	}

	/** A document's chunks, in order: what is embedded. */
	documentChunks(documentId: number): LibraryHit[] {
		return this.db
			.prepare(
				`SELECT k.*, d.source, d.title FROM chunks k JOIN documents d ON d.id = k.document_id
				WHERE k.document_id = ? ORDER BY k.ord`,
			)
			.all(documentId)
			.map((row) => this.toHit(row, 0));
	}

	/** Documents with chunks and no vectors yet for this model, oldest first. */
	documentsWithoutEmbedding(
		model: string,
		collectionIds: readonly number[] = [],
	): LibraryDocument[] {
		return this.db
			.prepare(
				`SELECT d.* FROM documents d
				WHERE d.chunk_count > 0
				AND NOT EXISTS (SELECT 1 FROM document_embeddings e WHERE e.document_id = d.id AND e.model = ?)
				${collectionIds.length > 0 ? `AND d.collection_id IN (${collectionIds.map(() => "?").join(",")})` : ""}
				ORDER BY d.id`,
			)
			.all(model, ...collectionIds)
			.map((row) => this.toDocument(row));
	}

	markEmbedded(documentId: number, model: string, dimension: number): void {
		this.db
			.prepare(
				`INSERT INTO document_embeddings(document_id, model, dimension, embedded_at) VALUES (?, ?, ?, ?)
				ON CONFLICT(document_id, model) DO UPDATE SET dimension = excluded.dimension, embedded_at = excluded.embedded_at`,
			)
			.run(documentId, model, dimension, new Date().toISOString());
	}

	/** Totals, and how many documents have vectors for this model. */
	counts(model?: string): {
		collections: number;
		documents: number;
		chunks: number;
		embeddedDocuments: number;
	} {
		const one = (sql: string, ...args: unknown[]) =>
			Number(this.db.prepare(sql).get(...args)?.n ?? 0);
		return {
			collections: one("SELECT COUNT(*) AS n FROM collections"),
			documents: one("SELECT COUNT(*) AS n FROM documents"),
			chunks: one("SELECT COUNT(*) AS n FROM chunks"),
			embeddedDocuments: model
				? one(
						"SELECT COUNT(*) AS n FROM document_embeddings WHERE model = ?",
						model,
					)
				: 0,
		};
	}

	private toHit(row: Record<string, unknown>, score: number): LibraryHit {
		return {
			chunkId: Number(row.id),
			documentId: Number(row.document_id),
			collectionId: Number(row.collection_id),
			score,
			text: String(row.text),
			start: Number(row.start_offset),
			end: Number(row.end_offset),
			headings: parseJson<string[]>(row.headings, []),
			source: String(row.source),
			title: typeof row.title === "string" ? row.title : undefined,
		};
	}

	/** Chunks by id, in the order asked for. Unknown ids are left out. */
	getChunks(chunkIds: readonly number[]): LibraryHit[] {
		if (chunkIds.length === 0) {
			return [];
		}
		const rows = this.db
			.prepare(
				`SELECT k.*, d.source, d.title FROM chunks k JOIN documents d ON d.id = k.document_id
				WHERE k.id IN (${chunkIds.map(() => "?").join(",")})`,
			)
			.all(...chunkIds);
		const byId = new Map(rows.map((row) => [Number(row.id), row]));
		return chunkIds.flatMap((id) => {
			const row = byId.get(id);
			return row ? [this.toHit(row, 0)] : [];
		});
	}

	/**
	 * The query's terms worth searching for: those that are not in a large
	 * share of all chunks. If that leaves none, all of them are kept.
	 */
	private selectiveTerms(terms: string[]): string[] {
		const total = Number(
			this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get()?.n ?? 0,
		);
		if (total < COMMON_TERM_MIN_CHUNKS || terms.length < 2) {
			return terms;
		}
		const lookup = this.db.prepare(
			"SELECT doc FROM chunks_vocab WHERE term = ?",
		);
		const kept = terms.filter(
			(term) => Number(lookup.get(term)?.doc ?? 0) / total <= COMMON_TERM_SHARE,
		);
		return kept.length > 0 ? kept : terms;
	}

	/**
	 * Keyword search, ranked by BM25. A chunk matches when it holds any of
	 * the query's terms; the more of them and the rarer they are, the higher.
	 */
	searchKeywords(
		query: string,
		options: KeywordSearchOptions = {},
	): LibraryHit[] {
		const terms = this.selectiveTerms(queryTerms(query));
		if (terms.length === 0) {
			return [];
		}
		const contextWeight = Math.max(0, options.contextWeight ?? 0.5);
		const quoted = terms.map((term) => `"${term}"`).join(" OR ");
		const match = contextWeight > 0 ? quoted : `text : (${quoted})`;
		const collections = options.collectionIds ?? [];
		const rows = this.db
			.prepare(
				`SELECT k.*, d.source, d.title, bm25(chunks_fts, 1.0, ?) AS rank
				FROM chunks_fts
				JOIN chunks k ON k.id = chunks_fts.rowid
				JOIN documents d ON d.id = k.document_id
				WHERE chunks_fts MATCH ?
				${collections.length > 0 ? `AND k.collection_id IN (${collections.map(() => "?").join(",")})` : ""}
				ORDER BY rank LIMIT ?`,
			)
			.all(
				contextWeight,
				match,
				...collections,
				Math.max(1, options.limit ?? 10),
			);
		// bm25() is smaller for a better match; turn it round.
		return rows.map((row) => this.toHit(row, -Number(row.rank)));
	}
}
