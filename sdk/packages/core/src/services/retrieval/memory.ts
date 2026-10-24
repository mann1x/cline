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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import {
	type EmbedPendingResult,
	Library,
	type LibraryOptions,
	type LibraryVectorSet,
} from "./library";
import type { LibraryDocument } from "./library-store";
import {
	type MemoryEvidence,
	type MemoryKind,
	type MemoryNoteFields,
	type MemoryOrigin,
	type MemoryPlace,
	type MemoryStatus,
	parsePlace,
	readNoteFields,
	useWeight,
} from "./memory-note";

export interface MemoryItem extends Partial<MemoryNoteFields> {
	/** `m12`: what `forget` takes. */
	id: string;
	text: string;
	/** The memory it is kept in. */
	memory: string;
	tags: string[];
	createdAt: string;
}

/** What `remember` did with a note. */
export type RememberOutcome =
	/** Kept as a new note. */
	| "added"
	/** Already there; new tags, places or evidence were added to it. */
	| "updated"
	/** Already there, word for word, with nothing new. */
	| "unchanged"
	/** The note it replaces now says this, under the same id. */
	| "revised"
	/** Not kept: a note there says nearly the same. */
	| "similar";

/**
 * Two notes this alike say the same thing (claude-hooks dedup.py: 0.85 of
 * the first 500 characters, there by SequenceMatcher, here by the letter
 * pairs both share).
 */
export const NEAR_DUPLICATE_SIMILARITY = 0.85;

/** How alike two notes read, 0 to 1: the share of letter pairs they have in common. */
export function noteSimilarity(a: string, b: string): number {
	const pairs = (value: string) => {
		const flat = value
			.normalize("NFKC")
			.toLowerCase()
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 500);
		const counts = new Map<string, number>();
		for (let at = 0; at < flat.length - 1; at++) {
			const pair = flat.slice(at, at + 2);
			counts.set(pair, (counts.get(pair) ?? 0) + 1);
		}
		return { counts, total: Math.max(0, flat.length - 1) };
	};
	const left = pairs(a);
	const right = pairs(b);
	if (left.total === 0 || right.total === 0)
		return a.trim() === b.trim() ? 1 : 0;
	let shared = 0;
	for (const [pair, count] of left.counts) {
		shared += Math.min(count, right.counts.get(pair) ?? 0);
	}
	return (2 * shared) / (left.total + right.total);
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
	notes: Array<
		{ text: string; tags: string[]; createdAt: string } & Partial<
			Pick<
				MemoryNoteFields,
				| "kind"
				| "status"
				| "reason"
				| "places"
				| "evidence"
				| "history"
				| "settled"
				| "origin"
				| "revisedAt"
			>
		>
	>;
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

/**
 * The key a note is kept under: its text with spacing and case evened out,
 * hashed. "Run the tests with vitest" noted twice, once with a capital and a
 * trailing newline, is one note. The key is the source of the note's
 * document, so it never changes with the chunk settings and neither does
 * the note's id.
 */
export function memoryNoteKey(text: string): string {
	const normalized = text
		.normalize("NFKC")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
	return `memory:${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

function tagsOfDocument(document: LibraryDocument): string[] {
	return Array.isArray(document.metadata.tags)
		? (document.metadata.tags as unknown[]).map(String)
		: [];
}

/** What became of a place a note gives. */
export interface PlaceCheck {
	place: MemoryPlace;
	/**
	 * `ok`: there as noted. `moved`: its line is now at `line`. `changed`:
	 * the line is no longer in the file. `missing`: no such file.
	 * `ambiguous`: more than one file it could be.
	 */
	state: "ok" | "moved" | "changed" | "missing" | "ambiguous";
	line?: number;
}

const WORKSPACE_FILES_MAX = 20_000;
const WORKSPACE_FILES_TTL_MS = 60_000;
const SKIPPED_DIRECTORIES = new Set([
	".git",
	"node_modules",
	"dist",
	"out",
	"build",
	".next",
	"target",
	"__pycache__",
	".venv",
	"venv",
]);
const fileLists = new Map<string, { at: number; files: string[] }>();

/** The workspace's files, relative, bounded and kept a minute. */
export function workspaceFiles(cwd: string): string[] {
	const held = fileLists.get(cwd);
	if (held && Date.now() - held.at < WORKSPACE_FILES_TTL_MS) return held.files;
	const files: string[] = [];
	const walk = (directory: string, prefix: string) => {
		if (files.length >= WORKSPACE_FILES_MAX) return;
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (files.length >= WORKSPACE_FILES_MAX) return;
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!SKIPPED_DIRECTORIES.has(entry.name)) {
					walk(join(directory, entry.name), relative);
				}
			} else if (entry.isFile()) {
				files.push(relative);
			}
		}
	};
	walk(cwd, "");
	fileLists.set(cwd, { at: Date.now(), files });
	return files;
}

function resolvePlacePath(
	path: string,
	cwd: string,
	files: () => readonly string[],
): { state: "found"; path: string } | { state: "missing" | "ambiguous" } {
	const direct = path.startsWith("/") ? path : join(cwd, path);
	if (existsSync(direct)) return { state: "found", path: direct };
	const relative = path.replace(/^\.\//, "");
	const matches = files().filter(
		(file) => file === relative || file.endsWith(`/${relative}`),
	);
	if (matches.length === 1)
		return { state: "found", path: join(cwd, matches[0]) };
	return { state: matches.length > 1 ? "ambiguous" : "missing" };
}

/**
 * The rubric a model distils expired notes by (claude-hooks M14): keep what
 * was found and decided and what is still open; drop the process -- the
 * attempts, the retries, the order things were tried in.
 */
export const MEMORY_DISTILL_SYSTEM_PROMPT =
	"You distil a project's expired notes into one. Keep every finding that still says something about the project, every decision with its reason, and every open question. Drop the process: attempts, retries, dead ends that taught nothing, the order things were tried in. Keep names, paths, commands and numbers exactly as written. Write plain sentences, at most 12 of them, with nothing before or after the note.";

export function buildMemoryDistillPrompt(notes: readonly MemoryItem[]): string {
	return [
		`Notes kept between ${notes.map((note) => note.createdAt.slice(0, 10)).sort()[0]} and ${notes
			.map((note) => note.createdAt.slice(0, 10))
			.sort()
			.at(-1)}:`,
		...notes.map((note, index) => `${index + 1}. ${note.text}`),
		"",
		"The one note that keeps what they found:",
	].join("\n");
}

/** Lines apart that still count as the same place (claude-hooks LINE_WINDOW). */
const PLACE_LINE_WINDOW = 40;

/** Whether two paths name one file: the same, or one a path suffix of the other. */
export function sameFile(a: string, b: string): boolean {
	const left = a.replace(/^\.\//, "");
	const right = b.replace(/^\.\//, "");
	return (
		left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`)
	);
}

/**
 * 1 when two lists of places share one (the same file, lines close or not
 * given), 0.5 when they share only a file, else 0.
 */
export function placeScore(
	a: readonly MemoryPlace[],
	b: readonly MemoryPlace[],
): number {
	let best = 0;
	for (const left of a) {
		for (const right of b) {
			if (!sameFile(left.path, right.path)) continue;
			if (
				left.line === undefined ||
				right.line === undefined ||
				Math.abs(left.line - right.line) <= PLACE_LINE_WINDOW
			) {
				return 1;
			}
			best = 0.5;
		}
	}
	return best;
}

/** The paths a note's text names, with a directory or a known extension. */
function filesInText(text: string): string[] {
	const found = new Set<string>();
	for (const match of text.matchAll(
		/(?<![\w./-])((?:[\w.-]+\/)+[\w-][\w.-]*\.[a-z0-9]{1,6}|[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cc|cpp|hpp|cs|swift|md|json|yaml|yml|toml|sh|sql|proto|css|scss|html|vue|svelte))(?![\w/-])/g,
	)) {
		found.add(match[1]);
	}
	return [...found];
}

/** Tags, places and evidence added to what a note's metadata holds, each once. */
function mergeInto(
	metadata: Record<string, unknown>,
	added: { tags: string[]; places: MemoryPlace[]; evidence: MemoryEvidence[] },
): { metadata: Record<string, unknown>; changed: boolean } {
	const fields = readNoteFields(metadata);
	const heldTags = Array.isArray(metadata.tags)
		? (metadata.tags as unknown[]).map(String)
		: [];
	const tags = [...new Set([...heldTags, ...added.tags])];
	const places = [...fields.places];
	for (const place of added.places) {
		if (
			!places.some(
				(held) => held.path === place.path && held.line === place.line,
			)
		) {
			places.push(place);
		}
	}
	// Evidence is appended, never repeated.
	const evidence = [...fields.evidence];
	for (const entry of added.evidence) {
		if (!evidence.some((held) => held.text === entry.text))
			evidence.push(entry);
	}
	const changed =
		tags.length !== heldTags.length ||
		places.length !== fields.places.length ||
		evidence.length !== fields.evidence.length;
	return {
		metadata: {
			...metadata,
			tags,
			...(places.length > 0 ? { places } : {}),
			...(evidence.length > 0 ? { evidence } : {}),
		},
		changed,
	};
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
		this.rekeyNotes();
		store.reindexKeyedContexts();
	}

	/**
	 * Bring notes kept under the first key (the exact text) to the key they
	 * have now. Notes that turn out the same are one: the oldest stays, with
	 * the tags of all of them, so its id is the one that keeps working.
	 */
	private rekeyNotes(): void {
		const store = this.library.store;
		for (const collection of store.listCollections()) {
			const groups = new Map<string, LibraryDocument[]>();
			for (const document of store.listDocuments(collection.id)) {
				if (!document.source.startsWith("memory:")) continue;
				const key = memoryNoteKey(this.textOf(document.id));
				groups.set(key, [...(groups.get(key) ?? []), document]);
			}
			for (const [key, group] of groups) {
				group.sort((a, b) => a.id - b.id);
				const [survivor, ...duplicates] = group;
				if (duplicates.length > 0) {
					const tags = [...new Set(group.flatMap(tagsOfDocument))];
					store.updateMetadata(survivor.id, { ...survivor.metadata, tags });
					// The rows go now, before the key is taken; the vectors when
					// the index is open.
					for (const duplicate of duplicates) {
						void this.library.removeDocument(duplicate.id).catch(() => {});
					}
				}
				if (survivor.source !== key) store.renameSource(survivor.id, key);
			}
		}
	}

	private textOf(documentId: number): string {
		return this.library.store
			.documentChunks(documentId)
			.map((chunk) => chunk.text)
			.join("\n");
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

	/**
	 * Give a memory another name. Its notes, their ids and their vectors stay
	 * as they are. The main memory keeps its name: everything starts on it.
	 */
	renameMemory(from: string, to: string): MemoryInfo {
		this.migrate();
		const name = normalizeMemoryName(to);
		if (!name) throw new Error("A memory needs a name.");
		if (from === MAIN_MEMORY) {
			throw new Error("The main memory cannot be renamed.");
		}
		const collection = this.library.store
			.listCollections()
			.find((entry) => entry.name === from);
		if (!collection) throw new Error(`There is no memory named "${from}".`);
		if (name !== from) {
			if (this.listMemories().some((memory) => memory.name === name)) {
				throw new Error(`There is already a memory named "${name}".`);
			}
			this.library.store.renameCollection(collection.id, name);
			const registry = this.readRegistry();
			if (registry[from]) {
				registry[name] = registry[from];
				delete registry[from];
				this.writeRegistry(registry);
			}
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
		const noted = document.metadata.createdAt;
		return {
			...readNoteFields(document.metadata),
			id: `m${document.id}`,
			text: this.textOf(document.id),
			memory,
			tags: tagsOfDocument(document),
			// An imported note keeps the day it was noted, not the day it arrived.
			createdAt: typeof noted === "string" && noted ? noted : document.addedAt,
		};
	}

	/**
	 * The document a note id names, in the memories in reach: the note itself,
	 * or the one it was merged into.
	 */
	private resolveNote(
		id: string,
		memories: readonly string[],
	): { document: LibraryDocument; memory: string } | undefined {
		const wanted = id.trim().toLowerCase();
		const documentId = Number(wanted.replace(/^m/, ""));
		if (!Number.isInteger(documentId)) return undefined;
		const reach = new Map(
			this.collections(memories).map((collection) => [
				collection.id,
				collection.name,
			]),
		);
		const direct = this.library.store.getDocument(documentId);
		if (direct && reach.has(direct.collectionId)) {
			return {
				document: direct,
				memory: reach.get(direct.collectionId) as string,
			};
		}
		for (const [collectionId, name] of reach) {
			for (const document of this.library.store.listDocuments(collectionId)) {
				if (
					readNoteFields(document.metadata).merged.includes(`m${documentId}`)
				) {
					return { document, memory: name };
				}
			}
		}
		return undefined;
	}

	/** One note by id, from the memories named; one merged away reads as the note it went into. */
	get(
		id: string,
		options: { memories?: readonly string[] } = {},
	): MemoryItem | undefined {
		const found = this.resolveNote(id, options.memories ?? [MAIN_MEMORY]);
		return found ? this.toItem(found.document, found.memory) : undefined;
	}

	/**
	 * The places a note gives, with the line each read when it was kept, so a
	 * recall can tell later whether the code moved under it.
	 */
	private placesFrom(
		given: readonly string[] | undefined,
		cwd: string | undefined,
	): MemoryPlace[] {
		const places: MemoryPlace[] = [];
		for (const value of given ?? []) {
			const place = parsePlace(value);
			if (
				!place ||
				places.some(
					(held) => held.path === place.path && held.line === place.line,
				)
			) {
				continue;
			}
			if (place.line && cwd) {
				try {
					const lines = readFileSync(
						place.path.startsWith("/") ? place.path : join(cwd, place.path),
						"utf8",
					).split(/\r?\n/);
					const line = lines[place.line - 1];
					if (line !== undefined) place.text = line.trim();
				} catch {
					// Not readable from here: kept as a place without its line.
				}
			}
			places.push(place);
		}
		return places;
	}

	/**
	 * Keep a note. The same text in the same memory is kept once, whatever
	 * its spacing and case; noted again, it gains the new tags, places and
	 * evidence. A note that says nearly what one there says is not kept: the
	 * answer names that one, to be revised (`replaces`) rather than doubled.
	 */
	async remember(input: {
		text: string;
		/** @default the main memory */
		memory?: string;
		tags?: readonly string[];
		/** @default "fact" */
		kind?: MemoryKind;
		/** Why: required for a decision. */
		reason?: string;
		/** `path` or `path:line`, the places in the code the note is about. */
		places?: readonly string[];
		/** What showed it, appended to what the note already has. */
		evidence?: string;
		/** A note id: that note now says this, under its own id. */
		replaces?: string;
		/** Who keeps it, and in which task. */
		origin?: MemoryOrigin;
		/** Where the places' paths are read from. */
		cwd?: string;
		/** Keep it even when a note says nearly the same. For imports. */
		allowSimilar?: boolean;
		/** Days until it expires; 0 or left out, never. */
		ttlDays?: number;
		/** For an imported note: when it was first noted. */
		createdAt?: string;
		endpoints?: MemoryEndpoints;
		signal?: AbortSignal;
	}): Promise<{
		item: MemoryItem;
		outcome: RememberOutcome;
		/** For "similar": how alike, 0 to 1. */
		similarity?: number;
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
		const kind = input.kind ?? "fact";
		const reason = input.reason?.trim();
		if (kind === "decision" && !reason && !input.replaces) {
			throw new Error(
				"A decision needs its reason: say why it was decided, so it is not reopened without one.",
			);
		}
		const tags = [
			...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean)),
		];
		const places = this.placesFrom(input.places, input.cwd);
		const now = new Date().toISOString();
		const evidence: MemoryEvidence[] = input.evidence?.trim()
			? [{ at: now, text: input.evidence.trim() }]
			: [];
		const source = memoryNoteKey(text);
		const store = this.library.store;
		const collection = store.ensureCollection(memory);

		if (input.replaces) {
			return this.revise({
				id: input.replaces,
				memory,
				text,
				source,
				tags,
				kind: input.kind,
				reason,
				places,
				evidence,
				now,
				endpoints: input.endpoints,
				signal: input.signal,
			});
		}

		const existing = store.findDocument(collection.id, source);
		if (existing) {
			// Looked up by key, never added again: an add with other settings
			// would replace the note, and give it a new id.
			const merged = mergeInto(existing.metadata, { tags, places, evidence });
			if (!merged.changed) {
				return { item: this.toItem(existing, memory), outcome: "unchanged" };
			}
			store.updateMetadata(existing.id, merged.metadata);
			const updated = store.getDocument(existing.id) ?? existing;
			return { item: this.toItem(updated, memory), outcome: "updated" };
		}

		if (!input.allowSimilar) {
			const near = await this.nearest(
				text,
				memory,
				input.endpoints,
				input.signal,
			);
			if (near) {
				return {
					item: near.item,
					outcome: "similar",
					similarity: near.similarity,
				};
			}
		}

		const ttl = Number(input.ttlDays);
		const result = await this.library.addDocument(
			memory,
			{
				source,
				text,
				metadata: {
					tags,
					...(kind !== "fact" ? { kind } : {}),
					...(reason ? { reason } : {}),
					...(places.length > 0 ? { places } : {}),
					...(evidence.length > 0 ? { evidence } : {}),
					...(input.origin ? { origin: input.origin } : {}),
					...(Number.isFinite(ttl) && ttl > 0 && kind === "fact"
						? {
								expiresAt: new Date(
									Date.now() + ttl * 86_400_000,
								).toISOString(),
							}
						: {}),
					...(input.createdAt ? { createdAt: input.createdAt } : {}),
				},
			},
			NOTE_SETTINGS,
		);
		const note = await this.embedNew(input.endpoints, input.signal);
		return {
			item: this.toItem(result.document, memory),
			outcome: "added",
			...(note ? { note } : {}),
		};
	}

	/** Embedded now, so the next recall finds it by meaning. A failure loses nothing: it is embedded with the next note. */
	private async embedNew(
		endpoints: MemoryEndpoints | undefined,
		signal: AbortSignal | undefined,
	): Promise<string | undefined> {
		if (!endpoints?.embedding) return undefined;
		try {
			const embedded = await this.library.embedPending({
				embedding: endpoints.embedding,
				settings: NOTE_SETTINGS,
				signal,
			});
			return embedded.skipped;
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	}

	/**
	 * The note in this memory that says nearly the same, if one does: found
	 * by the same search a recall makes, by meaning when there are vectors,
	 * and judged on the text.
	 */
	private async nearest(
		text: string,
		memory: string,
		endpoints: MemoryEndpoints | undefined,
		signal: AbortSignal | undefined,
	): Promise<{ item: MemoryItem; similarity: number } | undefined> {
		let best: { item: MemoryItem; similarity: number } | undefined;
		try {
			const found = await this.recall(text, {
				memories: [memory],
				...(endpoints?.embedding
					? { endpoints: { embedding: endpoints.embedding } }
					: {}),
				limit: 3,
				...(signal ? { signal } : {}),
			});
			for (const item of found.items) {
				const similarity = noteSimilarity(text, item.text);
				if (
					similarity >= NEAR_DUPLICATE_SIMILARITY &&
					(!best || similarity > best.similarity)
				) {
					best = { item, similarity };
				}
			}
		} catch {
			// The check fails open: a doubled note is better than a lost one.
		}
		return best;
	}

	/** Give a note new text, keeping its id; what it said before is kept with it. */
	private async revise(input: {
		id: string;
		memory: string;
		text: string;
		source: string;
		tags: string[];
		kind?: MemoryKind;
		reason?: string;
		places: MemoryPlace[];
		evidence: MemoryEvidence[];
		now: string;
		endpoints?: MemoryEndpoints;
		signal?: AbortSignal;
	}): Promise<{ item: MemoryItem; outcome: RememberOutcome; note?: string }> {
		const found = this.resolveNote(input.id, [input.memory]);
		if (!found) {
			throw new Error(
				`There is no note ${input.id} in the "${input.memory}" memory to replace.`,
			);
		}
		const { document } = found;
		const before = this.textOf(document.id);
		const fields = readNoteFields(document.metadata);
		const kind = input.kind ?? fields.kind;
		const reason = input.reason || fields.reason;
		if (kind === "decision" && !reason) {
			throw new Error("A decision needs its reason: say why it was decided.");
		}
		const sameText = memoryNoteKey(before) === input.source;
		const other = this.library.store.findDocument(
			document.collectionId,
			input.source,
		);
		if (other && other.id !== document.id) {
			throw new Error(
				`m${other.id} already says that. Forget ${input.id}, or say something else.`,
			);
		}
		const merged = mergeInto(document.metadata, {
			tags: input.tags,
			places: input.places,
			evidence: input.evidence,
		}).metadata;
		const metadata: Record<string, unknown> = {
			...merged,
			...(kind !== "fact" ? { kind } : { kind: undefined }),
			...(reason ? { reason } : {}),
			...(input.places.length > 0 ? { places: input.places } : {}),
		};
		if (sameText) {
			this.library.store.updateMetadata(document.id, metadata);
			const updated = this.library.store.getDocument(document.id) ?? document;
			return { item: this.toItem(updated, input.memory), outcome: "revised" };
		}
		// New words: the user's verdict was on the old ones.
		const revised = await this.library.replaceDocument(
			document.id,
			{
				source: input.source,
				text: input.text,
				metadata: {
					...metadata,
					history: [...fields.history, { at: input.now, text: before }],
					revisedAt: input.now,
					status: undefined,
					settled: undefined,
				},
			},
			NOTE_SETTINGS,
		);
		const note = await this.embedNew(input.endpoints, input.signal);
		return {
			item: this.toItem(revised, input.memory),
			outcome: "revised",
			...(note ? { note } : {}),
		};
	}

	/**
	 * The user's verdict on a note: confirmed, outdated (with why), or back
	 * to noted. Only the user's: no tool the model has calls this.
	 */
	settle(
		id: string,
		verdict: { status: MemoryStatus; reason?: string },
		options: { memories?: readonly string[] } = {},
	): MemoryItem {
		this.migrate();
		const memories =
			options.memories ?? this.listMemories().map((memory) => memory.name);
		const found = this.resolveNote(id, memories);
		if (!found) throw new Error(`There is no note ${id}.`);
		const reason = verdict.reason?.trim();
		const {
			status: _status,
			settled: _settled,
			...rest
		} = found.document.metadata;
		this.library.store.updateMetadata(found.document.id, {
			...rest,
			...(verdict.status === "noted"
				? {}
				: {
						status: verdict.status,
						settled: {
							at: new Date().toISOString(),
							...(reason ? { reason } : {}),
						},
					}),
		});
		const updated =
			this.library.store.getDocument(found.document.id) ?? found.document;
		return this.toItem(updated, found.memory);
	}

	/** Count a use of these notes: they were given to a task. */
	noteRecalled(ids: readonly string[], memories: readonly string[]): void {
		const at = new Date().toISOString();
		for (const id of ids) {
			const found = this.resolveNote(id, memories);
			if (!found) continue;
			const use = readNoteFields(found.document.metadata).recalled;
			this.library.store.updateMetadata(found.document.id, {
				...found.document.metadata,
				recalled: { count: (use?.count ?? 0) + 1, last: at },
			});
		}
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
			/** Leave out the notes the user marked outdated. */
			skipOutdated?: boolean;
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
		const found: RecalledMemory[] = [];
		for (const hit of result.hits) {
			if (seen.has(hit.documentId)) continue;
			seen.add(hit.documentId);
			const document = this.library.store.getDocument(hit.documentId);
			if (!document) continue;
			const item: RecalledMemory = {
				...this.toItem(document, names.get(hit.collectionId) ?? MAIN_MEMORY),
				...(hit.rerankScore !== undefined
					? { relevance: hit.rerankScore }
					: {}),
				...(hit.similarity !== undefined ? { similarity: hit.similarity } : {}),
			};
			if (options.skipOutdated && item.status === "outdated") continue;
			found.push(item);
		}
		// The search's order, moved by each note's use (claude-hooks decay.py,
		// applied after the fusion): a note recalled lately counts for more, one
		// that comes up at every turn for less. By rank and not by score, so a
		// weight moves a note past its neighbours and not past the whole list.
		const now = Date.now();
		const items = found
			.map((item, rank) => ({
				item,
				score: useWeight(item.recalled, now) / (rank + 1),
			}))
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((entry) => entry.item);
		return { items, notes: result.notes };
	}

	/**
	 * Notes about the files in play: those whose places, or whose text, name
	 * a file among `paths`, best place first. For a recall keyed on the
	 * prompt, which misses the notes about the code a task has open (claude-
	 * hooks cd71cf3: over 8 councils this pass added 5-9 findings each,
	 * settled ones the question alone never reached). A shared file counts;
	 * shared words alone never do.
	 */
	recallAtPlaces(
		paths: readonly string[],
		options: {
			memories?: readonly string[];
			limit?: number;
			exclude?: readonly string[];
		} = {},
	): RecalledMemory[] {
		const wanted = paths
			.map((path) => parsePlace(path))
			.filter((place): place is MemoryPlace => place !== undefined);
		if (wanted.length === 0) return [];
		const exclude = new Set(options.exclude ?? []);
		const scored: Array<{ item: RecalledMemory; score: number }> = [];
		for (const item of this.list({ memories: options.memories })) {
			if (exclude.has(item.id) || item.status === "outdated") continue;
			const held = [
				...(item.places ?? []),
				...filesInText(item.text).map((path) => ({ path })),
			];
			const score = placeScore(held, wanted);
			if (score > 0) scored.push({ item, score });
		}
		return scored
			.sort(
				(a, b) =>
					b.score - a.score || b.item.createdAt.localeCompare(a.item.createdAt),
			)
			.slice(0, Math.max(0, options.limit ?? 3))
			.map((entry) => entry.item);
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
		const found = this.resolveNote(id, options.memories ?? [MAIN_MEMORY]);
		if (!found) return false;
		await this.library.removeDocument(found.document.id);
		return true;
	}

	// ── Upkeep ──────────────────────────────────────────────────────────

	/**
	 * Merge the notes of a memory that say nearly the same. The oldest of
	 * each set stays, with every tag, place and piece of evidence, and the
	 * ids of the others, so a reference to one still reaches it; the others
	 * are deleted. A consolidation that only reported merges and left the
	 * notes in place grew the store while it said it shrank it (claude-hooks
	 * v1.15). A note the user confirmed is never merged into one they did not.
	 */
	async consolidate(
		options: { memories?: readonly string[] } = {},
	): Promise<{ merged: number; into: string[] }> {
		this.migrate();
		let merged = 0;
		const into = new Set<string>();
		for (const collection of this.collections(
			options.memories ?? this.listMemories().map((memory) => memory.name),
		)) {
			const notes = this.library.store
				.listDocuments(collection.id)
				.filter((document) => document.source.startsWith("memory:"))
				.sort((a, b) => a.id - b.id)
				.map((document) => ({
					document,
					text: this.textOf(document.id),
					fields: readNoteFields(document.metadata),
				}));
			const gone = new Set<number>();
			for (let at = 0; at < notes.length; at++) {
				const survivor = notes[at];
				if (gone.has(survivor.document.id)) continue;
				for (let next = at + 1; next < notes.length; next++) {
					const other = notes[next];
					if (gone.has(other.document.id)) continue;
					if (
						other.fields.status === "confirmed" &&
						survivor.fields.status !== "confirmed"
					) {
						continue;
					}
					if (
						noteSimilarity(survivor.text, other.text) <
						NEAR_DUPLICATE_SIMILARITY
					) {
						continue;
					}
					const held = this.library.store.getDocument(survivor.document.id);
					if (!held) break;
					const combined = mergeInto(held.metadata, {
						tags: Array.isArray(other.document.metadata.tags)
							? (other.document.metadata.tags as unknown[]).map(String)
							: [],
						places: other.fields.places,
						evidence: other.fields.evidence,
					}).metadata;
					const fields = readNoteFields(held.metadata);
					this.library.store.updateMetadata(survivor.document.id, {
						...combined,
						merged: [
							...new Set([
								...fields.merged,
								`m${other.document.id}`,
								...other.fields.merged,
							]),
						],
					});
					await this.library.removeDocument(other.document.id);
					gone.add(other.document.id);
					merged += 1;
					into.add(`m${survivor.document.id}`);
				}
			}
		}
		return { merged, into: [...into] };
	}

	/**
	 * Hold a note's places against the code as it is now. A short path is
	 * found by the one file it is a suffix of (as the council's citation
	 * check does); two such files is ambiguous, not missing. A line kept
	 * with its text is looked for where it was, then anywhere in the file.
	 */
	checkPlaces(
		item: Pick<MemoryItem, "places">,
		cwd: string,
		files: () => readonly string[] = () => workspaceFiles(cwd),
	): PlaceCheck[] {
		const checks: PlaceCheck[] = [];
		for (const place of item.places ?? []) {
			const resolved = resolvePlacePath(place.path, cwd, files);
			if (resolved.state !== "found") {
				checks.push({ place, state: resolved.state });
				continue;
			}
			if (!place.line || place.text === undefined) {
				checks.push({ place, state: "ok" });
				continue;
			}
			let lines: string[];
			try {
				lines = readFileSync(resolved.path, "utf8").split(/\r?\n/);
			} catch {
				checks.push({ place, state: "missing" });
				continue;
			}
			if ((lines[place.line - 1] ?? "").trim() === place.text) {
				checks.push({ place, state: "ok" });
				continue;
			}
			const moved = place.text
				? lines.findIndex((line) => line.trim() === place.text)
				: -1;
			checks.push(
				moved >= 0
					? { place, state: "moved", line: moved + 1 }
					: { place, state: "changed" },
			);
		}
		return checks;
	}

	/**
	 * Distil the notes that have expired into one, then remove them: the
	 * notes of a fact that were only ever noted, past the day they were kept
	 * until. One summary per memory, kept with no expiry; the originals go
	 * only once it is written (claude-hooks M14). With no `distill`, or a
	 * distillation that fails, they stay where they are.
	 */
	async expire(options: {
		distill: (notes: readonly MemoryItem[]) => Promise<string | undefined>;
		nowMs?: number;
		memories?: readonly string[];
		endpoints?: MemoryEndpoints;
	}): Promise<
		Array<{
			memory: string;
			distilled?: string;
			removed: number;
			kept?: string;
		}>
	> {
		this.migrate();
		const now = options.nowMs ?? Date.now();
		const outcomes: Array<{
			memory: string;
			distilled?: string;
			removed: number;
			kept?: string;
		}> = [];
		const names =
			options.memories ?? this.listMemories().map((memory) => memory.name);
		for (const name of names) {
			const expired = this.list({ memories: [name] }).filter(
				(item) =>
					item.expiresAt !== undefined &&
					Date.parse(item.expiresAt) <= now &&
					item.status === "noted" &&
					(item.kind ?? "fact") === "fact",
			);
			if (expired.length === 0) continue;
			let summary: string | undefined;
			try {
				summary = (await options.distill(expired))?.trim();
			} catch (error) {
				outcomes.push({
					memory: name,
					removed: 0,
					kept: `the distillation failed: ${error instanceof Error ? error.message : String(error)}`,
				});
				continue;
			}
			if (!summary) {
				outcomes.push({
					memory: name,
					removed: 0,
					kept: "the distillation came back empty",
				});
				continue;
			}
			const written = await this.remember({
				text: summary.slice(0, MEMORY_MAX_CHARS),
				memory: name,
				tags: ["distilled"],
				origin: { by: "model" },
				allowSimilar: true,
				...(options.endpoints ? { endpoints: options.endpoints } : {}),
			});
			const kept = this.library.store.getDocument(
				Number(written.item.id.slice(1)),
			);
			if (kept) {
				this.library.store.updateMetadata(kept.id, {
					...kept.metadata,
					distilledFrom: expired.map((item) => item.id),
					distilledAt: new Date(now).toISOString(),
				});
			}
			for (const item of expired) {
				if (item.id === written.item.id) continue;
				await this.forget(item.id, { memories: [name] });
			}
			outcomes.push({
				memory: name,
				distilled: written.item.id,
				removed: expired.filter((item) => item.id !== written.item.id).length,
			});
		}
		return outcomes;
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
					// What it is and where it stands travel with it; its use
					// and the ids merged into it are this store's own.
					...(item.kind && item.kind !== "fact" ? { kind: item.kind } : {}),
					...(item.status && item.status !== "noted"
						? { status: item.status }
						: {}),
					...(item.reason ? { reason: item.reason } : {}),
					...(item.places?.length ? { places: item.places } : {}),
					...(item.evidence?.length ? { evidence: item.evidence } : {}),
					...(item.history?.length ? { history: item.history } : {}),
					...(item.settled ? { settled: item.settled } : {}),
					...(item.origin ? { origin: item.origin } : {}),
					...(item.revisedAt ? { revisedAt: item.revisedAt } : {}),
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
				allowSimilar: true,
				origin: { by: "import" },
				...(typeof note.createdAt === "string" && note.createdAt
					? { createdAt: note.createdAt }
					: {}),
			});
			if (result.outcome === "added") {
				added += 1;
				// The rest as the file has it, read through the same parser
				// as a note's own metadata, so a bad field is dropped and not kept.
				const fields = readNoteFields(note as Record<string, unknown>);
				const document = this.library.store.getDocument(
					Number(result.item.id.slice(1)),
				);
				if (document) {
					this.library.store.updateMetadata(document.id, {
						...document.metadata,
						...(fields.kind !== "fact" ? { kind: fields.kind } : {}),
						...(fields.status !== "noted" ? { status: fields.status } : {}),
						...(fields.reason ? { reason: fields.reason } : {}),
						...(fields.places.length ? { places: fields.places } : {}),
						...(fields.evidence.length ? { evidence: fields.evidence } : {}),
						...(fields.history.length ? { history: fields.history } : {}),
						...(fields.settled ? { settled: fields.settled } : {}),
						...(fields.revisedAt ? { revisedAt: fields.revisedAt } : {}),
					});
				}
			} else {
				unchanged += 1;
			}
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

	/** Give vectors to every note that has none for this embedding model. */
	embedPending(options: {
		embedding: RetrievalEndpoint;
		onProgress?: (progress: { done: number; total: number }) => void;
		probe?: boolean;
		signal?: AbortSignal;
	}): Promise<EmbedPendingResult> {
		this.migrate();
		return this.library.embedPending({
			embedding: options.embedding,
			settings: NOTE_SETTINGS,
			probe: options.probe,
			signal: options.signal,
			onProgress: (progress) =>
				options.onProgress?.({
					done: progress.documentIndex + 1,
					total: progress.documentCount,
				}),
		});
	}

	/** The sets of vectors the notes have, one per embedding model and size. */
	vectorSets(current?: string): Promise<LibraryVectorSet[]> {
		return this.library.vectorSets(current);
	}

	deleteVectorSet(table: string): Promise<boolean> {
		return this.library.deleteVectorSet(table);
	}

	/** Record the vector size a model returned, as a search would. */
	noteDimension(model: string, dimension: number): void {
		this.library.store.noteDimension(model, dimension);
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

/** Closes every Memory this process opened. For shutdown, like `closeSharedLibraries`. */
export async function closeSharedMemories(): Promise<void> {
	const open = [...shared.values()];
	shared.clear();
	await Promise.all(open.map((memory) => memory.close().catch(() => {})));
}

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
