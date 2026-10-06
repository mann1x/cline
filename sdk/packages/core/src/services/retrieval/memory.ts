/**
 * Memory: short notes the model keeps between tasks.
 *
 * A note is a fact worth having next time: a decision and its reason, how
 * this project is built and tested, a preference of the user, a trap that
 * cost an hour. It is kept by the retrieval core the Library uses, in a
 * store of its own, so it is searched the same way: by keyword always, and
 * by meaning when an embedding model is set.
 *
 * There are any number of memories, all in the one store: the main one,
 * which every workspace starts on, and whichever others the user makes --
 * one for a workspace, one for a client, one imported from a colleague. A
 * session keeps new notes in exactly one of them and searches as many as
 * the user allows it; which, is the user's choice per workspace and not
 * something the model can widen.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_LIBRARY_SETTINGS,
	DEFAULT_MEMORY_SETTINGS,
	MAIN_MEMORY,
	type MemorySettings,
	memoryWorkspaceKey,
} from "@cline/shared";
import { resolveClineDataDir } from "@cline/shared/storage";
import type { RetrievalEndpoint } from "./embedding-client";
import { Library, type LibraryOptions } from "./library";
import type { LibraryDocument } from "./library-store";

export interface MemoryItem {
	/** `m12`: what `forget` takes. */
	id: string;
	text: string;
	/** The memory it is kept in. */
	memory: string;
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

/** One of the memories, as the settings panel lists it. */
export interface MemoryInfo {
	name: string;
	/** The main memory: always there, never deleted. */
	main: boolean;
	notes: number;
	/** The workspace it was made for, when it was made for one. */
	workspace?: string;
	createdAt: string;
}

/** A memory written to a file, to be read back here or on another machine. */
export interface MemoryExport {
	format: typeof MEMORY_EXPORT_FORMAT;
	version: 1;
	name: string;
	workspace?: string;
	exportedAt: string;
	notes: Array<{ text: string; tags: string[]; createdAt: string }>;
}

export const MEMORY_EXPORT_FORMAT = "cerebriline-memory";

/** A memory is a note, not a document: longer than this belongs in the Library. */
export const MEMORY_MAX_CHARS = 4000;
export const MEMORY_NAME_MAX_CHARS = 60;

/** The names the first build used for its two kinds of collection. */
const LEGACY_GLOBAL = "global";
const LEGACY_PROJECT = "project:";

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

/** A name as it is kept: trimmed, one line, of a length a list can show. */
export function normalizeMemoryName(name: string): string {
	return name.replace(/\s+/g, " ").trim().slice(0, MEMORY_NAME_MAX_CHARS);
}

export class Memory {
	private readonly library: Library;
	private readonly directory: string;
	private migrated = false;

	constructor(options: LibraryOptions = {}) {
		this.directory = options.directory ?? resolveMemoryDirectory();
		this.library = new Library({ ...options, directory: this.directory });
	}

	// ── The memories ────────────────────────────────────────────────────

	/** Which workspace each memory was made for. Not in the database: it is about the user's folders, not the notes. */
	private get registryPath(): string {
		return join(this.directory, "memories.json");
	}

	private readRegistry(): Record<string, { workspace?: string }> {
		try {
			if (!existsSync(this.registryPath)) return {};
			const parsed = JSON.parse(readFileSync(this.registryPath, "utf8"));
			return typeof parsed === "object" && parsed !== null ? parsed : {};
		} catch {
			return {};
		}
	}

	private writeRegistry(registry: Record<string, { workspace?: string }>) {
		writeFileSync(this.registryPath, `${JSON.stringify(registry, null, 2)}\n`);
	}

	/**
	 * Bring a store made by the first build to this one's names, once: its
	 * `global` collection is the main memory, and each `project:<path>` is a
	 * memory named after the folder, made for that workspace.
	 */
	private migrate(): void {
		if (this.migrated) return;
		this.migrated = true;
		const store = this.library.store;
		const names = new Set(store.listCollections().map((c) => c.name));
		const registry = this.readRegistry();
		let changed = false;
		for (const collection of store.listCollections()) {
			if (collection.name === LEGACY_GLOBAL && !names.has(MAIN_MEMORY)) {
				store.renameCollection(collection.id, MAIN_MEMORY);
				names.add(MAIN_MEMORY);
			} else if (collection.name.startsWith(LEGACY_PROJECT)) {
				const workspace = collection.name.slice(LEGACY_PROJECT.length);
				const name = this.freeName(
					normalizeMemoryName(
						memoryWorkspaceKey(workspace).split("/").pop() ?? "",
					) || "workspace",
					names,
				);
				store.renameCollection(collection.id, name);
				names.add(name);
				registry[name] = { workspace: memoryWorkspaceKey(workspace) };
				changed = true;
			}
		}
		if (changed) this.writeRegistry(registry);
		store.ensureCollection(MAIN_MEMORY);
	}

	private freeName(wanted: string, taken: Set<string>): string {
		if (!taken.has(wanted)) return wanted;
		for (let n = 2; ; n += 1) {
			const candidate = `${wanted} ${n}`;
			if (!taken.has(candidate)) return candidate;
		}
	}

	/** Every memory in the store, the main one first. */
	listMemories(): MemoryInfo[] {
		this.migrate();
		const registry = this.readRegistry();
		return this.library.store
			.listCollections()
			.map((collection) => ({
				name: collection.name,
				main: collection.name === MAIN_MEMORY,
				notes: collection.documents,
				...(registry[collection.name]?.workspace
					? { workspace: registry[collection.name].workspace }
					: {}),
				createdAt: collection.createdAt,
			}))
			.sort(
				(a, b) =>
					Number(b.main) - Number(a.main) || a.name.localeCompare(b.name),
			);
	}

	/** Make a memory. A name already taken is refused, not reused. */
	createMemory(input: { name: string; workspace?: string }): MemoryInfo {
		this.migrate();
		const name = normalizeMemoryName(input.name);
		if (!name) throw new Error("A memory needs a name.");
		if (this.listMemories().some((memory) => memory.name === name)) {
			throw new Error(`There is already a memory named "${name}".`);
		}
		this.library.store.ensureCollection(name);
		if (input.workspace) {
			const registry = this.readRegistry();
			registry[name] = { workspace: memoryWorkspaceKey(input.workspace) };
			this.writeRegistry(registry);
		}
		return this.listMemories().find(
			(memory) => memory.name === name,
		) as MemoryInfo;
	}

	/** Delete a memory and every note in it. The main memory stays. */
	async deleteMemory(name: string): Promise<number> {
		this.migrate();
		if (name === MAIN_MEMORY) {
			throw new Error("The main memory cannot be deleted.");
		}
		const collection = this.library.store
			.listCollections()
			.find((entry) => entry.name === name);
		if (!collection) throw new Error(`There is no memory named "${name}".`);
		await this.library.removeCollection(collection.id);
		const registry = this.readRegistry();
		if (registry[name]) {
			delete registry[name];
			this.writeRegistry(registry);
		}
		return collection.documents;
	}

	/** The collections of these memories; a name that is not a memory is left out. */
	private collections(memories: readonly string[]) {
		this.migrate();
		const wanted = new Set(memories);
		return this.library.store
			.listCollections()
			.filter((collection) => wanted.has(collection.name));
	}

	// ── The notes ───────────────────────────────────────────────────────

	private toItem(document: LibraryDocument, memory: string): MemoryItem {
		const text = this.library.store
			.documentChunks(document.id)
			.map((chunk) => chunk.text)
			.join("\n");
		const noted = document.metadata.createdAt;
		return {
			id: `m${document.id}`,
			text,
			memory,
			tags: Array.isArray(document.metadata.tags)
				? (document.metadata.tags as unknown[]).map(String)
				: [],
			// An imported note keeps the day it was noted, not the day it arrived.
			createdAt: typeof noted === "string" && noted ? noted : document.addedAt,
		};
	}

	/** Keep a note. The same text in the same memory is kept once. */
	async remember(input: {
		text: string;
		/** @default the main memory */
		memory?: string;
		tags?: readonly string[];
		/** For an imported note: when it was first noted. */
		createdAt?: string;
		endpoints?: MemoryEndpoints;
		signal?: AbortSignal;
	}): Promise<{
		item: MemoryItem;
		outcome: "added" | "unchanged";
		note?: string;
	}> {
		this.migrate();
		const text = input.text.trim();
		if (!text) {
			throw new Error("There is nothing to remember: the text is empty.");
		}
		if (text.length > MEMORY_MAX_CHARS) {
			throw new Error(
				`That is ${text.length} characters; a memory is a note of at most ${MEMORY_MAX_CHARS}. Keep the fact, or put the document in the Library.`,
			);
		}
		const memory = input.memory ?? MAIN_MEMORY;
		if (!this.listMemories().some((entry) => entry.name === memory)) {
			throw new Error(`There is no memory named "${memory}".`);
		}
		const tags = [
			...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
		];
		const result = await this.library.addDocument(
			memory,
			{
				source: `memory:${createHash("sha256").update(text).digest("hex").slice(0, 24)}`,
				text,
				metadata: {
					tags,
					...(input.createdAt ? { createdAt: input.createdAt } : {}),
				},
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
			item: this.toItem(result.document, memory),
			outcome: result.outcome === "unchanged" ? "unchanged" : "added",
			...(note ? { note } : {}),
		};
	}

	/** The notes that best match, best first, from the memories named. */
	async recall(
		query: string,
		options: {
			/** @default the main memory */
			memories?: readonly string[];
			settings?: MemorySettings;
			endpoints?: MemoryEndpoints;
			limit?: number;
			signal?: AbortSignal;
		} = {},
	): Promise<{ items: RecalledMemory[]; notes: string[] }> {
		const settings = options.settings ?? DEFAULT_MEMORY_SETTINGS;
		const collections = this.collections(options.memories ?? [MAIN_MEMORY]);
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
				...this.toItem(document, names.get(hit.collectionId) ?? MAIN_MEMORY),
				...(hit.rerankScore !== undefined
					? { relevance: hit.rerankScore }
					: {}),
				...(hit.similarity !== undefined ? { similarity: hit.similarity } : {}),
			});
		}
		return { items, notes: result.notes };
	}

	/** Every note of the memories named, newest first. */
	list(options: { memories?: readonly string[] } = {}): MemoryItem[] {
		return this.collections(options.memories ?? [MAIN_MEMORY])
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

	/** Remove a note. False when the memories named hold none with that id. */
	async forget(
		id: string,
		options: { memories?: readonly string[] } = {},
	): Promise<boolean> {
		const documentId = Number(id.trim().replace(/^m/i, ""));
		if (!Number.isInteger(documentId)) return false;
		const document = this.library.store.getDocument(documentId);
		const reach = new Set(
			this.collections(options.memories ?? [MAIN_MEMORY]).map(
				(collection) => collection.id,
			),
		);
		if (!document || !reach.has(document.collectionId)) return false;
		await this.library.removeDocument(documentId);
		return true;
	}

	// ── Out and back in ─────────────────────────────────────────────────

	/** A memory as a file's content. The notes only: vectors are made again where it is read. */
	exportMemory(name: string): MemoryExport {
		const info = this.listMemories().find((memory) => memory.name === name);
		if (!info) throw new Error(`There is no memory named "${name}".`);
		return {
			format: MEMORY_EXPORT_FORMAT,
			version: 1,
			name,
			...(info.workspace ? { workspace: info.workspace } : {}),
			exportedAt: new Date().toISOString(),
			notes: this.list({ memories: [name] })
				.reverse()
				.map((item) => ({
					text: item.text,
					tags: item.tags,
					createdAt: item.createdAt,
				})),
		};
	}

	/**
	 * Read an exported memory in. Into the memory named, or into one of the
	 * file's own name, made if it is not there. A note already there is left
	 * alone, so reading the same file twice adds nothing.
	 */
	async importMemory(
		data: unknown,
		options: { into?: string; endpoints?: MemoryEndpoints } = {},
	): Promise<{
		memory: string;
		created: boolean;
		added: number;
		unchanged: number;
		skipped: number;
	}> {
		const file = data as Partial<MemoryExport> | null;
		if (
			!file ||
			typeof file !== "object" ||
			file.format !== MEMORY_EXPORT_FORMAT ||
			!Array.isArray(file.notes)
		) {
			throw new Error(
				"That is not an exported memory: it has no notes in the format this reads.",
			);
		}
		const name = normalizeMemoryName(
			options.into ?? (typeof file.name === "string" ? file.name : ""),
		);
		if (!name) throw new Error("The file names no memory to read it into.");
		const created = !this.listMemories().some((memory) => memory.name === name);
		if (created) this.createMemory({ name });
		let added = 0;
		let unchanged = 0;
		let skipped = 0;
		for (const note of file.notes) {
			const text = typeof note?.text === "string" ? note.text.trim() : "";
			if (!text || text.length > MEMORY_MAX_CHARS) {
				skipped += 1;
				continue;
			}
			const result = await this.remember({
				text,
				memory: name,
				tags: Array.isArray(note.tags) ? note.tags.map(String) : [],
				...(typeof note.createdAt === "string" && note.createdAt
					? { createdAt: note.createdAt }
					: {}),
			});
			if (result.outcome === "added") added += 1;
			else unchanged += 1;
		}
		if (added > 0 && options.endpoints?.embedding) {
			await this.library
				.embedPending({
					embedding: options.endpoints.embedding,
					settings: NOTE_SETTINGS,
				})
				.catch(() => undefined);
		}
		return { memory: name, created, added, unchanged, skipped };
	}

	/** How many notes there are, and how many have vectors for this embedding model. */
	counts(model?: string): { notes: number; embeddedNotes: number } {
		this.migrate();
		const counts = this.library.store.counts(model);
		return { notes: counts.documents, embeddedNotes: counts.embeddedDocuments };
	}

	/** Whether notes can be found by meaning here now, and if not, why. */
	vectorState(): { installed: boolean; unsupported?: string } {
		return this.library.vectorState();
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
