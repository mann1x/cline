/**
 * Search a workspace's code by meaning.
 *
 * `search_codebase` is a regex: it finds a name the model already knows.
 * `ask_lsp` resolves a symbol the model already has. Neither answers "where
 * does this app check a user's password" when no word of the question is in
 * the code. An embedding model does, and the Library already has everything
 * that needs: chunking, a keyword index, vectors, the merge of the two and a
 * reranker.
 *
 * So the code index is a second Library, kept apart from the user's books
 * under `<data dir>/code-index`, with one collection per workspace and one
 * document per source file. Nothing here knows about embeddings beyond what
 * it hands on.
 *
 * It is opt-in per workspace: indexing sends every source file to the
 * embedder, which on a large repository is real work for a GPU.
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_LIBRARY_SETTINGS, type LibrarySettings } from "@cline/shared";
import { resolveClineDataDir } from "@cline/shared/storage";
import { getFileIndex } from "../workspace/file-indexer";
import type { RetrievalEndpoint } from "./embedding-client";
import { type EmbedPendingResult, Library } from "./library";
import type { LibraryDocument } from "./library-store";
import type { RetrieveResult } from "./retrieve";

export function resolveCodeIndexDirectory(): string {
	return join(resolveClineDataDir(), "code-index");
}

/** A source file larger than this is a data file or a bundle, not code to search. */
export const CODE_INDEX_MAX_FILE_BYTES = 256 * 1024;

/** Files indexed per workspace, at most. Past it the rest is left out and said so. */
export const CODE_INDEX_MAX_FILES = 20_000;

/**
 * Names that are text but not worth a vector: generated, and long.
 * Matched against the file's base name, lower-cased.
 */
const SKIPPED_NAMES = new Set([
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lock",
	"bun.lockb",
	"cargo.lock",
	"composer.lock",
	"gemfile.lock",
	"poetry.lock",
	"uv.lock",
	"go.sum",
]);

const SKIPPED_SUFFIXES = [
	".min.js",
	".min.css",
	".map",
	".svg",
	".lock",
	".snap",
	".generated.ts",
	".pb.go",
	"_pb2.py",
];

export function isIndexableCodePath(relativePath: string): boolean {
	const name = relativePath
		.slice(relativePath.lastIndexOf("/") + 1)
		.toLowerCase();
	if (SKIPPED_NAMES.has(name)) return false;
	return !SKIPPED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** A NUL in the first bytes is the usual, cheap sign of a binary file. */
function looksBinary(content: Buffer): boolean {
	const end = Math.min(content.length, 8192);
	for (let index = 0; index < end; index++) {
		if (content[index] === 0) return true;
	}
	return false;
}

/**
 * How code is cut. Not the user's Library chunking: that is tuned for prose
 * and breaks at markdown headers, which in a source file are comments.
 */
function codeSettings(settings: LibrarySettings): LibrarySettings {
	return {
		...settings,
		splitter: "characters",
		markdownHeaders: false,
		chunkSize: 1500,
		chunkOverlap: 150,
		chunkMinSize: 0,
	};
}

export interface CodeIndexOptions {
	/** @default <data dir>/code-index */
	directory?: string;
	/** Where LanceDB is installed. @default the Library's */
	runtimeDirectory?: string;
	fetch?: typeof fetch;
}

export interface CodeSyncOptions {
	settings?: LibrarySettings;
	/** The workspace's files, relative with forward slashes. @default ripgrep's list, which honours .gitignore */
	listFiles?: (root: string) => Promise<Iterable<string>>;
	onProgress?: (done: number, total: number) => void;
	signal?: AbortSignal;
}

export interface CodeSyncResult {
	/** Files in the index after the run. */
	files: number;
	added: number;
	updated: number;
	removed: number;
	/** Files left out: too large, binary, generated, or unreadable. */
	skipped: number;
	/** Set when the workspace has more files than are indexed. */
	truncated?: number;
}

export interface CodeEmbedOptions {
	embedding: RetrievalEndpoint;
	settings?: LibrarySettings;
	/** Download LanceDB when it is not installed. */
	install?: boolean;
	onProgress?: (documentsDone: number, documents: number) => void;
	signal?: AbortSignal;
}

export interface CodeSearchOptions {
	settings?: LibrarySettings;
	embedding?: RetrievalEndpoint;
	reranker?: RetrievalEndpoint;
	/** Passages returned. @default 8 */
	limit?: number;
	/** How the folder's files are read for line numbers. @default from disk */
	readFile?: (absolutePath: string) => Promise<string | undefined>;
	signal?: AbortSignal;
}

export interface CodeHit {
	/** Relative to the workspace, forward slashes. */
	path: string;
	/** 1-based, inclusive. Absent when the file has changed since it was indexed. */
	startLine?: number;
	endLine?: number;
	text: string;
	rerankScore?: number;
	similarity?: number;
}

export interface CodeSearchResult {
	hits: CodeHit[];
	mode: RetrieveResult["mode"];
	reranked: boolean;
	notes: string[];
}

export interface CodeIndexStatus {
	indexed: boolean;
	files: number;
	chunks: number;
}

/** One name for a workspace however its path was spelled. */
export function codeCollectionName(root: string): string {
	const absolute = resolve(root).replace(/\\/g, "/").replace(/\/+$/, "");
	return `code:${process.platform === "win32" ? absolute.toLowerCase() : absolute}`;
}

function lineOf(text: string, offset: number): number {
	let line = 1;
	for (let index = 0; index < offset && index < text.length; index++) {
		if (text.charCodeAt(index) === 10) line++;
	}
	return line;
}

export class CodeIndex {
	readonly library: Library;

	constructor(options: CodeIndexOptions = {}) {
		this.library = new Library({
			directory: options.directory ?? resolveCodeIndexDirectory(),
			...(options.runtimeDirectory
				? { runtimeDirectory: options.runtimeDirectory }
				: {}),
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
	}

	private collection(root: string): { id: number } | undefined {
		const name = codeCollectionName(root);
		return this.library.store
			.listCollections()
			.find((collection) => collection.name === name);
	}

	status(root: string): CodeIndexStatus {
		const collection = this.collection(root);
		if (!collection) return { indexed: false, files: 0, chunks: 0 };
		const documents = this.library.store.listDocuments(collection.id);
		return {
			indexed: true,
			files: documents.length,
			chunks: documents.reduce((total, document) => total + document.chunks, 0),
		};
	}

	/**
	 * Bring the index in line with the files on disk: new and changed files
	 * are read and chunked, files that are gone are dropped. A file whose size
	 * and modification time are what they were is not read again.
	 *
	 * Searchable by keyword when this returns; `embed` adds the vectors.
	 */
	async sync(
		root: string,
		options: CodeSyncOptions = {},
	): Promise<CodeSyncResult> {
		const settings = codeSettings(options.settings ?? DEFAULT_LIBRARY_SETTINGS);
		const name = codeCollectionName(root);
		const listed = [
			...(await (options.listFiles
				? options.listFiles(root)
				: getFileIndex(root, { ttlMs: 0 }))),
		]
			.filter(isIndexableCodePath)
			.sort();
		const wanted = listed.slice(0, CODE_INDEX_MAX_FILES);
		const { id: collectionId } = this.library.store.ensureCollection(name);
		const known = new Map<string, LibraryDocument>(
			this.library.store
				.listDocuments(collectionId)
				.map((document) => [document.source, document]),
		);

		const result: CodeSyncResult = {
			files: 0,
			added: 0,
			updated: 0,
			removed: 0,
			skipped: 0,
			...(listed.length > wanted.length
				? { truncated: listed.length - wanted.length }
				: {}),
		};
		const kept = new Set<string>();
		let done = 0;
		for (const relativePath of wanted) {
			options.signal?.throwIfAborted();
			options.onProgress?.(done++, wanted.length);
			const absolutePath = join(root, relativePath);
			let size: number;
			let mtimeMs: number;
			try {
				const info = await stat(absolutePath);
				if (
					!info.isFile() ||
					info.size === 0 ||
					info.size > CODE_INDEX_MAX_FILE_BYTES
				) {
					result.skipped++;
					continue;
				}
				size = info.size;
				mtimeMs = Math.round(info.mtimeMs);
			} catch {
				result.skipped++;
				continue;
			}
			const before = known.get(relativePath);
			if (
				before &&
				before.metadata.size === size &&
				before.metadata.mtimeMs === mtimeMs
			) {
				kept.add(relativePath);
				continue;
			}
			let content: Buffer;
			try {
				content = await readFile(absolutePath);
			} catch {
				result.skipped++;
				continue;
			}
			if (looksBinary(content)) {
				result.skipped++;
				continue;
			}
			const added = await this.library.addDocument(
				name,
				{
					source: relativePath,
					text: content.toString("utf8"),
					bytes: size,
					metadata: { size, mtimeMs },
				},
				settings,
			);
			kept.add(relativePath);
			if (!before) result.added++;
			// Touched without changing is the same text under a new time: the
			// Library leaves the chunks alone, and so the count does too.
			else if (added.replacedDocumentId !== undefined) result.updated++;
		}
		for (const [source, document] of known) {
			if (!kept.has(source)) {
				await this.library.removeDocument(document.id);
				result.removed++;
			}
		}
		options.onProgress?.(wanted.length, wanted.length);
		result.files = kept.size;
		return result;
	}

	/** Give vectors to every indexed file that has none for this embedding model. */
	async embed(
		root: string,
		options: CodeEmbedOptions,
	): Promise<EmbedPendingResult> {
		const collection = this.collection(root);
		if (!collection) {
			return {
				documents: 0,
				chunks: 0,
				skipped: "This workspace is not indexed.",
			};
		}
		return this.library.embedPending({
			embedding: options.embedding,
			settings: codeSettings(options.settings ?? DEFAULT_LIBRARY_SETTINGS),
			collectionIds: [collection.id],
			install: options.install,
			onProgress: options.onProgress
				? (progress) =>
						options.onProgress?.(progress.documentIndex, progress.documentCount)
				: undefined,
			signal: options.signal,
		});
	}

	async search(
		root: string,
		query: string,
		options: CodeSearchOptions = {},
	): Promise<CodeSearchResult> {
		const collection = this.collection(root);
		if (!collection) {
			return {
				hits: [],
				mode: "keyword",
				reranked: false,
				notes: ["This workspace is not indexed."],
			};
		}
		const limit = Math.max(1, Math.min(30, Math.round(options.limit ?? 8)));
		const base = codeSettings(options.settings ?? DEFAULT_LIBRARY_SETTINGS);
		const result = await this.library.search(query, {
			settings: {
				...base,
				// Candidates for the reranker: more than are returned, so it has
				// something to choose from.
				topK: Math.max(base.topK, limit * 3),
				topKReranker: limit,
			},
			collectionIds: [collection.id],
			embedding: options.embedding,
			reranker: options.reranker,
			signal: options.signal,
		});
		const files = new Map<string, string | undefined>();
		const hits: CodeHit[] = [];
		for (const hit of result.hits.slice(0, limit)) {
			if (!files.has(hit.source)) {
				files.set(
					hit.source,
					await (options.readFile
						? options.readFile(join(root, hit.source))
						: readFile(join(root, hit.source), "utf8")
					).catch(() => undefined),
				);
			}
			const current = files.get(hit.source);
			// The offsets are the file's as it was indexed. They are trusted only
			// where the file still says the same thing there; a chunk that moved
			// is looked for, and one that is gone is given without line numbers.
			let start: number | undefined;
			if (current !== undefined) {
				if (current.slice(hit.start, hit.end) === hit.text) start = hit.start;
				else {
					const found = current.indexOf(hit.text);
					if (found >= 0) start = found;
				}
			}
			hits.push({
				path: hit.source,
				...(start !== undefined && current !== undefined
					? {
							startLine: lineOf(current, start),
							endLine: lineOf(current, start + hit.text.length),
						}
					: {}),
				text: hit.text,
				...(hit.rerankScore !== undefined
					? { rerankScore: hit.rerankScore }
					: {}),
				...(hit.similarity !== undefined ? { similarity: hit.similarity } : {}),
			});
		}
		return {
			hits,
			mode: result.mode,
			reranked: result.reranked,
			notes: result.notes,
		};
	}

	/** Forget a workspace: its files, chunks and vectors. */
	async remove(root: string): Promise<boolean> {
		const collection = this.collection(root);
		if (!collection) return false;
		await this.library.removeCollection(collection.id);
		return true;
	}

	async close(): Promise<void> {
		await this.library.close();
	}
}

let shared: CodeIndex | undefined;

/** The code index of the data folder, opened once. */
export function sharedCodeIndex(): CodeIndex {
	shared ??= new CodeIndex();
	return shared;
}

export async function closeSharedCodeIndex(): Promise<void> {
	const open = shared;
	shared = undefined;
	await open?.close();
}
