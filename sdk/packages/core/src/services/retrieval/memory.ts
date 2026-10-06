/**
 * Memory: short notes the model keeps between tasks.
 *
 * A memory is a fact worth having next time: a decision and its reason, how
 * this project is built and tested, a preference of the user, a trap that
 * cost an hour. It is kept by the retrieval core the Library uses, in a
 * store of its own, so it is searched the same way: by keyword always, and
 * by meaning when an embedding model is set.
 *
 * Notes belong to a project (the workspace they were made in) or to
 * everything (`global`). A recall in a project sees both.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	DEFAULT_LIBRARY_SETTINGS,
	DEFAULT_MEMORY_SETTINGS,
	type MemorySettings,
} from "@cline/shared";
import { resolveClineDataDir } from "@cline/shared/storage";
import type { RetrievalEndpoint } from "./embedding-client";
import { Library, type LibraryOptions } from "./library";
import type { LibraryDocument } from "./library-store";

export type MemoryScope = "project" | "global";

export interface MemoryItem {
	/** `m12`: what `forget` takes. */
	id: string;
	text: string;
	scope: MemoryScope;
	/** The project it belongs to, for a project memory. */
	project?: string;
	tags: string[];
	createdAt: string;
}

export interface RecalledMemory extends MemoryItem {
	/** The reranker's score, 0 to 1, when there was one. */
	relevance?: number;
	/** Cosine similarity to the query, when the note was found by meaning. */
	similarity?: number;
}

export interface MemoryEndpoints {
	embedding?: RetrievalEndpoint;
	reranker?: RetrievalEndpoint;
}

/** A memory is a note, not a document: longer than this belongs in the Library. */
export const MEMORY_MAX_CHARS = 4000;

const GLOBAL = "global";
const projectCollection = (project: string) => `project:${project}`;

export function resolveMemoryDirectory(): string {
	return join(resolveClineDataDir(), "memory");
}

/** Kept whole: a note is not cut into passages. */
const NOTE_SETTINGS = {
	...DEFAULT_LIBRARY_SETTINGS,
	enabled: true,
	chunkSize: MEMORY_MAX_CHARS * 2,
	chunkOverlap: 0,
	markdownHeaders: false,
};

export class Memory {
	private readonly library: Library;

	constructor(options: LibraryOptions = {}) {
		this.library = new Library({
			...options,
			directory: options.directory ?? resolveMemoryDirectory(),
		});
	}

	private toItem(document: LibraryDocument, collection: string): MemoryItem {
		const text = this.library.store
			.documentChunks(document.id)
			.map((chunk) => chunk.text)
			.join("\n");
		const project = collection.startsWith("project:")
			? collection.slice("project:".length)
			: undefined;
		return {
			id: `m${document.id}`,
			text,
			scope: project === undefined ? "global" : "project",
			...(project === undefined ? {} : { project }),
			tags: Array.isArray(document.metadata.tags)
				? (document.metadata.tags as unknown[]).map(String)
				: [],
			createdAt: document.addedAt,
		};
	}

	private collections(
		project: string | undefined,
		scope: MemoryScope | "all",
	): { id: number; name: string }[] {
		const wanted = new Set<string>();
		if (scope !== "project") wanted.add(GLOBAL);
		if (scope !== "global" && project) wanted.add(projectCollection(project));
		return this.library.store
			.listCollections()
			.filter((collection) => wanted.has(collection.name));
	}

	/** Keep a note. The same text in the same place is kept once. */
	async remember(input: {
		text: string;
		scope: MemoryScope;
		/** The workspace, for a project memory. */
		project?: string;
		tags?: readonly string[];
		endpoints?: MemoryEndpoints;
		signal?: AbortSignal;
	}): Promise<{
		item: MemoryItem;
		outcome: "added" | "unchanged";
		note?: string;
	}> {
		const text = input.text.trim();
		if (!text) {
			throw new Error("There is nothing to remember: the text is empty.");
		}
		if (text.length > MEMORY_MAX_CHARS) {
			throw new Error(
				`That is ${text.length} characters; a memory is a note of at most ${MEMORY_MAX_CHARS}. Keep the fact, or put the document in the Library.`,
			);
		}
		if (input.scope === "project" && !input.project) {
			throw new Error("A project memory needs the project it belongs to.");
		}
		const collection =
			input.scope === "project"
				? projectCollection(input.project as string)
				: GLOBAL;
		const tags = [
			...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
		];
		const result = await this.library.addDocument(
			collection,
			{
				source: `memory:${createHash("sha256").update(text).digest("hex").slice(0, 24)}`,
				text,
				metadata: { tags },
			},
			NOTE_SETTINGS,
		);
		let note: string | undefined;
		if (result.outcome !== "unchanged" && input.endpoints?.embedding) {
			// Embedded now, so the next recall finds it by meaning. A failure
			// here loses nothing: it is embedded with the next note.
			try {
				const embedded = await this.library.embedPending({
					embedding: input.endpoints.embedding,
					settings: NOTE_SETTINGS,
					signal: input.signal,
				});
				note = embedded.skipped;
			} catch (error) {
				note = error instanceof Error ? error.message : String(error);
			}
		}
		return {
			item: this.toItem(result.document, collection),
			outcome: result.outcome === "unchanged" ? "unchanged" : "added",
			...(note ? { note } : {}),
		};
	}

	/** The notes that best match, best first. */
	async recall(
		query: string,
		options: {
			project?: string;
			scope?: MemoryScope | "all";
			settings?: MemorySettings;
			endpoints?: MemoryEndpoints;
			limit?: number;
			signal?: AbortSignal;
		} = {},
	): Promise<{ items: RecalledMemory[]; notes: string[] }> {
		const settings = options.settings ?? DEFAULT_MEMORY_SETTINGS;
		const collections = this.collections(
			options.project,
			options.scope ?? "all",
		);
		if (collections.length === 0) {
			return { items: [], notes: [] };
		}
		const limit = Math.max(1, options.limit ?? settings.recallCount);
		const result = await this.library.search(query, {
			settings: {
				...NOTE_SETTINGS,
				topK: Math.max(limit * 2, 10),
				topKReranker: limit,
				relevanceThreshold: settings.relevanceThreshold,
			},
			collectionIds: collections.map((collection) => collection.id),
			embedding: options.endpoints?.embedding,
			reranker: options.endpoints?.reranker,
			signal: options.signal,
		});
		const names = new Map(
			collections.map((collection) => [collection.id, collection.name]),
		);
		const seen = new Set<number>();
		const items: RecalledMemory[] = [];
		for (const hit of result.hits) {
			if (seen.has(hit.documentId) || items.length >= limit) continue;
			seen.add(hit.documentId);
			const document = this.library.store.getDocument(hit.documentId);
			if (!document) continue;
			items.push({
				...this.toItem(document, names.get(hit.collectionId) ?? GLOBAL),
				...(hit.rerankScore !== undefined
					? { relevance: hit.rerankScore }
					: {}),
				...(hit.similarity !== undefined ? { similarity: hit.similarity } : {}),
			});
		}
		return { items, notes: result.notes };
	}

	/** Every note in reach, newest first. */
	list(
		options: { project?: string; scope?: MemoryScope | "all" } = {},
	): MemoryItem[] {
		return this.collections(options.project, options.scope ?? "all")
			.flatMap((collection) =>
				this.library.store
					.listDocuments(collection.id)
					.map((document) => this.toItem(document, collection.name)),
			)
			.sort(
				(a, b) =>
					b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
			);
	}

	/** Remove a note. False when there is none with that id in reach. */
	async forget(
		id: string,
		options: { project?: string } = {},
	): Promise<boolean> {
		const documentId = Number(id.trim().replace(/^m/i, ""));
		if (!Number.isInteger(documentId)) return false;
		const document = this.library.store.getDocument(documentId);
		// A project's notes are not reachable from another project.
		const reach = new Set(
			this.collections(options.project, "all").map(
				(collection) => collection.id,
			),
		);
		if (!document || !reach.has(document.collectionId)) return false;
		await this.library.removeDocument(documentId);
		return true;
	}

	async close(): Promise<void> {
		await this.library.close();
	}
}

const shared = new Map<string, Memory>();

/** The one Memory of a folder in this process. */
export function sharedMemory(options: LibraryOptions = {}): Memory {
	const directory = options.directory ?? resolveMemoryDirectory();
	let memory = shared.get(directory);
	if (!memory) {
		memory = new Memory({ ...options, directory });
		shared.set(directory, memory);
	}
	return memory;
}
