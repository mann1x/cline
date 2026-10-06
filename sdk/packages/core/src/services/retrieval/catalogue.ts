/**
 * The Library's catalogue: sections, the shelves in them, and the books on
 * the shelves.
 *
 * A book is a folder (`books/<uid>/`) and a collection in the text store. The
 * folder is the book itself: the files it was made from, named by their
 * sha256, the text read out of each, its pictures, and `book.json` saying
 * what all of it is. The database is the index of those folders, so a folder
 * can be carried to another Library and read back in, which is what export
 * and import do.
 *
 * Nothing the model does here is final. A deleted book, or a source taken
 * out of one, goes to the trash and stays there for thirty days.
 */

import { createHash, randomBytes } from "node:crypto";
import {
	copyFileSync,
	createReadStream,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { DEFAULT_LIBRARY_SETTINGS, type LibrarySettings } from "@cline/shared";
import type { SqliteDb } from "@cline/shared/db";
import { fingerprintSimilarity, textFingerprint } from "./fingerprint";
import type { Library } from "./library";
import { extractTarGz } from "./tar-extract";
import { type TarEntry, writeTarGz } from "./tar-write";

export const BOOK_FORMAT = "cerebriline-book";
export const LIBRARY_EXPORT_FORMAT = "cerebriline-library";
/** How long the trash keeps what was deleted. */
export const TRASH_DAYS = 30;
/** Where the collections of a Library from before it had shelves are put. */
export const LEGACY_SECTION = "General";

const SCHEMA = [
	`CREATE TABLE IF NOT EXISTS sections (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL UNIQUE COLLATE NOCASE,
		description TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS shelves (
		id INTEGER PRIMARY KEY,
		section_id INTEGER NOT NULL REFERENCES sections(id),
		name TEXT NOT NULL COLLATE NOCASE,
		description TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL,
		UNIQUE (section_id, name)
	)`,
	// A book in the trash has no shelf: the shelf may be gone by the time it
	// is wanted back, so where it stood is kept by name.
	`CREATE TABLE IF NOT EXISTS books (
		id INTEGER PRIMARY KEY,
		uid TEXT NOT NULL UNIQUE,
		shelf_id INTEGER REFERENCES shelves(id),
		collection_id INTEGER NOT NULL UNIQUE REFERENCES collections(id),
		title TEXT NOT NULL,
		description TEXT NOT NULL DEFAULT '',
		metadata TEXT NOT NULL DEFAULT '{}',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		trashed_at TEXT,
		trashed_from TEXT
	)`,
	`CREATE TABLE IF NOT EXISTS book_sources (
		id INTEGER PRIMARY KEY,
		book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		kind TEXT NOT NULL,
		sha256 TEXT NOT NULL,
		name TEXT NOT NULL,
		stored TEXT,
		text_file TEXT,
		url TEXT,
		bytes INTEGER NOT NULL DEFAULT 0,
		added_at TEXT NOT NULL,
		document_id INTEGER,
		fingerprint TEXT,
		metadata TEXT NOT NULL DEFAULT '{}',
		removed_at TEXT
	)`,
	"CREATE INDEX IF NOT EXISTS book_sources_by_book ON book_sources(book_id)",
	"CREATE INDEX IF NOT EXISTS book_sources_by_hash ON book_sources(sha256)",
	`CREATE TABLE IF NOT EXISTS book_images (
		id INTEGER PRIMARY KEY,
		book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
		source_id INTEGER NOT NULL REFERENCES book_sources(id) ON DELETE CASCADE,
		sha256 TEXT NOT NULL,
		file TEXT NOT NULL,
		media_type TEXT NOT NULL,
		bytes INTEGER NOT NULL DEFAULT 0,
		width INTEGER,
		height INTEGER,
		origin TEXT,
		description TEXT
	)`,
	"CREATE INDEX IF NOT EXISTS book_images_by_book ON book_images(book_id)",
];

export interface LibraryShelf {
	id: number;
	sectionId: number;
	name: string;
	description: string;
	books: number;
	passages: number;
}

export interface LibrarySection {
	id: number;
	name: string;
	description: string;
	shelves: LibraryShelf[];
}

/** Where a scraped book came from, kept so it can be brought up to date. */
export interface BookWebOrigin {
	/** What was asked for, when the links were found by searching. */
	query?: string;
	/** The links given or found: where a later check starts again. */
	links: string[];
	crawl?: { limit?: number; depth?: number };
	checkedAt?: string;
}

export interface BookMetadata {
	authors?: string[];
	edition?: string;
	year?: number;
	language?: string;
	isbn?: string;
	publisher?: string;
	tags?: string[];
	web?: BookWebOrigin;
	[key: string]: unknown;
}

export interface LibraryBook {
	id: number;
	uid: string;
	/** Undefined for a book in the trash. */
	shelfId?: number;
	collectionId: number;
	title: string;
	description: string;
	metadata: BookMetadata;
	createdAt: string;
	updatedAt: string;
	trashedAt?: string;
	/** Where a trashed book stood. */
	trashedFrom?: { section: string; shelf: string };
	sources: number;
	passages: number;
}

export type BookSourceKind = "file" | "web" | "text";

export interface BookSource {
	id: number;
	bookId: number;
	kind: BookSourceKind;
	sha256: string;
	name: string;
	/** The source itself, relative to the book's folder. */
	stored?: string;
	/** Its text, relative to the book's folder. */
	textFile?: string;
	url?: string;
	bytes: number;
	addedAt: string;
	documentId?: number;
	fingerprint?: number[];
	metadata: Record<string, unknown>;
	removedAt?: string;
}

export interface BookImage {
	id: number;
	bookId: number;
	sourceId: number;
	sha256: string;
	/** Relative to the book's folder. */
	file: string;
	mediaType: string;
	bytes: number;
	width?: number;
	height?: number;
	/** Where in the source it was: `page 7`, `chapter 2`. */
	origin?: string;
	/** What a vision model said it shows, or failing that its caption in the book. */
	description?: string;
	/** A vision model has described it: `description` is not just its caption. */
	described: boolean;
}

export interface SourceImageInput {
	/** The name the source's text links it by: `images/<file>`. */
	file: string;
	data: Uint8Array;
	mediaType: string;
	width?: number;
	height?: number;
	origin?: string;
	description?: string;
	/** `description` is a vision model's, not the caption the book gave it. */
	described?: boolean;
}

export interface AddSourceInput {
	kind: BookSourceKind;
	/** A file name, or a page's title. */
	name: string;
	/** For a file: where it is now. It is copied into the book. */
	path?: string;
	url?: string;
	/** The source as text or markdown: what is searched. */
	text: string;
	title?: string;
	metadata?: Record<string, unknown>;
	images?: readonly SourceImageInput[];
	/** A source of this book it takes the place of. */
	replaces?: number;
}

export interface AddSourceResult {
	source: BookSource;
	outcome: "added" | "replaced" | "unchanged";
	passages: number;
	images: number;
}

export interface BookMatch {
	book: LibraryBook;
	source?: BookSource;
	reason:
		| "same file"
		| "same link"
		| "same isbn"
		| "same title and author"
		| "same title"
		| "similar text";
	/** For "similar text": the share of the text the two have in common, 0 to 1. */
	similarity?: number;
}

export interface FindSimilarInput {
	sha256?: string;
	url?: string;
	title?: string;
	authors?: readonly string[];
	isbn?: string;
	fingerprint?: readonly number[];
	/** Text similarity below this is not reported. @default 0.3 */
	minSimilarity?: number;
}

export type ExportScope =
	| { library: true }
	| { sectionId: number }
	| { shelfId: number }
	| { bookId: number };

export interface ExportResult {
	file: string;
	books: number;
	files: number;
	bytes: number;
}

export interface ImportOptions {
	settings?: LibrarySettings;
	/** Put every book on this shelf, whatever shelf the archive says. */
	shelfId?: number;
	/**
	 * A book already here (the same book, by its id): leave it, replace it,
	 * or bring the archive's in beside it as a copy. @default "skip"
	 */
	existing?: "skip" | "replace" | "copy";
}

export interface ImportResult {
	imported: { title: string; section: string; shelf: string }[];
	skipped: { title: string; reason: string }[];
}

export interface CatalogueProblem {
	book?: string;
	problem: string;
}

interface BookFile {
	format: typeof BOOK_FORMAT;
	version: 1;
	uid: string;
	title: string;
	description: string;
	metadata: BookMetadata;
	section?: string;
	shelf?: string;
	createdAt: string;
	updatedAt: string;
	sources: Omit<BookSource, "id" | "bookId" | "documentId" | "removedAt">[];
	images: (Omit<BookImage, "id" | "bookId" | "sourceId"> & {
		source: string;
	})[];
}

interface ExportManifest {
	format: typeof LIBRARY_EXPORT_FORMAT;
	version: 1;
	exportedAt: string;
	sections: {
		name: string;
		description: string;
		shelves: { name: string; description: string; books: string[] }[];
	}[];
}

const IMAGE_EXTENSIONS: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp",
	"image/bmp": "bmp",
	"image/tiff": "tif",
	"image/svg+xml": "svg",
};

function parse<T>(value: unknown, fallback: T): T {
	if (typeof value !== "string" || !value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function now(): string {
	return new Date().toISOString();
}

function named(value: string, what: string): string {
	const trimmed = value.trim().replace(/\s+/g, " ");
	if (!trimmed) throw new Error(`A ${what} needs a name.`);
	if (trimmed.length > 120) {
		throw new Error(`A ${what}'s name is at most 120 characters.`);
	}
	return trimmed;
}

/** A title as it is compared: lower case, letters and digits only. */
export function normalizeTitle(title: string): string {
	return title
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export function normalizeIsbn(isbn: string): string {
	return isbn.replace(/[^0-9xX]/g, "").toUpperCase();
}

async function sha256OfFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path))
		hash.update(chunk as Buffer);
	return hash.digest("hex");
}

function filesUnder(root: string, prefix = ""): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			found.push(...filesUnder(join(root, entry.name), relative));
		} else if (entry.isFile()) {
			found.push(relative);
		}
	}
	return found;
}

export class Catalogue {
	private readonly db: SqliteDb;
	private readonly booksDirectory: string;

	constructor(private readonly library: Library) {
		this.db = library.store.database;
		this.booksDirectory = join(library.directory, "books");
		for (const statement of SCHEMA) this.db.exec(statement);
		// Whether a vision model has described the picture. A caption out of
		// the book is kept in `description` too, and is not that.
		try {
			this.db.exec(
				"ALTER TABLE book_images ADD COLUMN described INTEGER NOT NULL DEFAULT 0",
			);
		} catch {
			// The column is there: a Library opened before.
		}
		mkdirSync(this.booksDirectory, { recursive: true });
		this.adoptLegacyCollections();
	}

	private one(
		sql: string,
		...args: unknown[]
	): Record<string, unknown> | undefined {
		return this.db.prepare(sql).get(...args) as
			| Record<string, unknown>
			| undefined;
	}

	private all(sql: string, ...args: unknown[]): Record<string, unknown>[] {
		return this.db.prepare(sql).all(...args) as Record<string, unknown>[];
	}

	bookDirectory(book: Pick<LibraryBook, "uid">): string {
		return join(this.booksDirectory, book.uid);
	}

	/**
	 * A Library from before it had shelves: each of its collections becomes a
	 * shelf in "General" holding one book of that name. The documents stay
	 * indexed as they are; their files were never copied in, so the book
	 * records where they were.
	 */
	private adoptLegacyCollections(): void {
		const orphans = this.all(
			"SELECT c.id, c.name FROM collections c WHERE NOT EXISTS (SELECT 1 FROM books b WHERE b.collection_id = c.id)",
		);
		for (const row of orphans) {
			const name = String(row.name);
			const collectionId = Number(row.id);
			const section = this.ensureSection(LEGACY_SECTION);
			const shelf = this.ensureShelf(section.id, name.slice(0, 120));
			const uid = randomBytes(8).toString("hex");
			const at = now();
			const inserted = this.db
				.prepare(
					"INSERT INTO books(uid, shelf_id, collection_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					uid,
					shelf.id,
					collectionId,
					name,
					"Documents added before the Library had shelves.",
					at,
					at,
				);
			const bookId = Number(inserted.lastInsertRowid);
			for (const document of this.library.store.listDocuments(collectionId)) {
				this.db
					.prepare(
						"INSERT INTO book_sources(book_id, kind, sha256, name, bytes, added_at, document_id, metadata) VALUES (?, 'file', ?, ?, ?, ?, ?, ?)",
					)
					.run(
						bookId,
						document.contentHash,
						basename(document.source.replace(/\\/g, "/")),
						document.bytes ?? 0,
						document.addedAt,
						document.id,
						JSON.stringify({ path: document.source, notCopied: true }),
					);
			}
			this.writeBookFile(bookId);
		}
	}

	// ---- sections and shelves -------------------------------------------

	sections(): LibrarySection[] {
		const shelves = this.all(
			`SELECT s.id, s.section_id, s.name, s.description,
				(SELECT COUNT(*) FROM books b WHERE b.shelf_id = s.id AND b.trashed_at IS NULL) AS books,
				(SELECT COALESCE(SUM(d.chunk_count), 0) FROM books b JOIN documents d ON d.collection_id = b.collection_id
					WHERE b.shelf_id = s.id AND b.trashed_at IS NULL) AS passages
			FROM shelves s ORDER BY s.name`,
		).map(
			(row): LibraryShelf => ({
				id: Number(row.id),
				sectionId: Number(row.section_id),
				name: String(row.name),
				description: String(row.description ?? ""),
				books: Number(row.books),
				passages: Number(row.passages),
			}),
		);
		return this.all(
			"SELECT id, name, description FROM sections ORDER BY name",
		).map((row) => ({
			id: Number(row.id),
			name: String(row.name),
			description: String(row.description ?? ""),
			shelves: shelves.filter((shelf) => shelf.sectionId === Number(row.id)),
		}));
	}

	findSection(name: string): LibrarySection | undefined {
		const wanted = name.trim().toLowerCase();
		return this.sections().find(
			(section) => section.name.toLowerCase() === wanted,
		);
	}

	/** A shelf by name; in one section when that is given, and otherwise wherever it is the only one of that name. */
	findShelf(name: string, section?: string): LibraryShelf | undefined {
		const wanted = name.trim().toLowerCase();
		const sections = section
			? [this.findSection(section)].filter(
					(found): found is LibrarySection => found !== undefined,
				)
			: this.sections();
		const found = sections.flatMap((entry) =>
			entry.shelves.filter((shelf) => shelf.name.toLowerCase() === wanted),
		);
		return found.length === 1 ? found[0] : undefined;
	}

	shelf(shelfId: number): (LibraryShelf & { section: string }) | undefined {
		for (const section of this.sections()) {
			const shelf = section.shelves.find((entry) => entry.id === shelfId);
			if (shelf) return { ...shelf, section: section.name };
		}
		return undefined;
	}

	ensureSection(name: string, description?: string): LibrarySection {
		const trimmed = named(name, "section");
		this.db
			.prepare(
				"INSERT INTO sections(name, description, created_at) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING",
			)
			.run(trimmed, description?.trim() ?? "", now());
		const section = this.findSection(trimmed);
		if (!section) throw new Error(`Section "${trimmed}" could not be created.`);
		if (description?.trim() && !section.description) {
			this.db
				.prepare("UPDATE sections SET description = ? WHERE id = ?")
				.run(description.trim(), section.id);
			section.description = description.trim();
		}
		return section;
	}

	updateSection(
		sectionId: number,
		change: { name?: string; description?: string },
	): void {
		if (change.name !== undefined) {
			const name = named(change.name, "section");
			const taken = this.findSection(name);
			if (taken && taken.id !== sectionId) {
				throw new Error(`There is already a section named "${taken.name}".`);
			}
			this.db
				.prepare("UPDATE sections SET name = ? WHERE id = ?")
				.run(name, sectionId);
		}
		if (change.description !== undefined) {
			this.db
				.prepare("UPDATE sections SET description = ? WHERE id = ?")
				.run(change.description.trim(), sectionId);
		}
		this.rewriteBookFiles({ sectionId });
	}

	/** Remove a section and its shelves. Their books go to the trash. */
	deleteSection(sectionId: number): number {
		const section = this.sections().find((entry) => entry.id === sectionId);
		if (!section) throw new Error("No such section.");
		let trashed = 0;
		for (const shelf of section.shelves) trashed += this.deleteShelf(shelf.id);
		this.db.prepare("DELETE FROM sections WHERE id = ?").run(sectionId);
		return trashed;
	}

	ensureShelf(
		sectionId: number,
		name: string,
		description?: string,
	): LibraryShelf {
		const trimmed = named(name, "shelf");
		this.db
			.prepare(
				"INSERT INTO shelves(section_id, name, description, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(section_id, name) DO NOTHING",
			)
			.run(sectionId, trimmed, description?.trim() ?? "", now());
		const row = this.one(
			"SELECT id FROM shelves WHERE section_id = ? AND name = ?",
			sectionId,
			trimmed,
		);
		const shelf = row ? this.shelf(Number(row.id)) : undefined;
		if (!shelf) throw new Error(`Shelf "${trimmed}" could not be created.`);
		return shelf;
	}

	updateShelf(
		shelfId: number,
		change: { name?: string; description?: string; sectionId?: number },
	): void {
		const shelf = this.shelf(shelfId);
		if (!shelf) throw new Error("No such shelf.");
		const sectionId = change.sectionId ?? shelf.sectionId;
		const name =
			change.name !== undefined ? named(change.name, "shelf") : shelf.name;
		const taken = this.one(
			"SELECT id FROM shelves WHERE section_id = ? AND name = ? AND id <> ?",
			sectionId,
			name,
			shelfId,
		);
		if (taken) {
			throw new Error(
				`There is already a shelf named "${name}" in that section.`,
			);
		}
		this.db
			.prepare(
				"UPDATE shelves SET section_id = ?, name = ?, description = ? WHERE id = ?",
			)
			.run(
				sectionId,
				name,
				change.description !== undefined
					? change.description.trim()
					: shelf.description,
				shelfId,
			);
		this.rewriteBookFiles({ shelfId });
	}

	/** Remove a shelf. Its books go to the trash; resolves with how many. */
	deleteShelf(shelfId: number): number {
		const books = this.books({ shelfId });
		for (const book of books) this.trashBook(book.id);
		this.db.prepare("DELETE FROM shelves WHERE id = ?").run(shelfId);
		return books.length;
	}

	// ---- books ----------------------------------------------------------

	private toBook(row: Record<string, unknown>): LibraryBook {
		return {
			id: Number(row.id),
			uid: String(row.uid),
			...(row.shelf_id != null ? { shelfId: Number(row.shelf_id) } : {}),
			collectionId: Number(row.collection_id),
			title: String(row.title),
			description: String(row.description ?? ""),
			metadata: parse<BookMetadata>(row.metadata, {}),
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
			...(typeof row.trashed_at === "string"
				? { trashedAt: row.trashed_at }
				: {}),
			...(typeof row.trashed_from === "string"
				? {
						trashedFrom: parse<{ section: string; shelf: string }>(
							row.trashed_from,
							{ section: LEGACY_SECTION, shelf: "Restored" },
						),
					}
				: {}),
			sources: Number(row.sources ?? 0),
			passages: Number(row.passages ?? 0),
		};
	}

	private static readonly BOOK_COLUMNS = `b.*,
		(SELECT COUNT(*) FROM book_sources s WHERE s.book_id = b.id AND s.removed_at IS NULL) AS sources,
		(SELECT COALESCE(SUM(d.chunk_count), 0) FROM documents d WHERE d.collection_id = b.collection_id) AS passages`;

	/** The books on a shelf, or all of them; the trash only when asked for. */
	books(filter: { shelfId?: number; trashed?: boolean } = {}): LibraryBook[] {
		const where = [
			filter.trashed ? "b.trashed_at IS NOT NULL" : "b.trashed_at IS NULL",
		];
		const args: unknown[] = [];
		if (filter.shelfId !== undefined) {
			where.push("b.shelf_id = ?");
			args.push(filter.shelfId);
		}
		return this.all(
			`SELECT ${Catalogue.BOOK_COLUMNS} FROM books b WHERE ${where.join(" AND ")} ORDER BY b.title COLLATE NOCASE`,
			...args,
		).map((row) => this.toBook(row));
	}

	book(bookId: number): LibraryBook | undefined {
		const row = this.one(
			`SELECT ${Catalogue.BOOK_COLUMNS} FROM books b WHERE b.id = ?`,
			bookId,
		);
		return row ? this.toBook(row) : undefined;
	}

	bookByUid(uid: string): LibraryBook | undefined {
		const row = this.one("SELECT id FROM books WHERE uid = ?", uid);
		return row ? this.book(Number(row.id)) : undefined;
	}

	/**
	 * A book by what the model can name it with: its number (`#12`), its id,
	 * or its title. Several books of one title come back together, for the
	 * caller to say which.
	 */
	findBooks(
		reference: string,
		options: { trashed?: boolean } = {},
	): LibraryBook[] {
		const wanted = reference.trim();
		const number = /^#?(\d+)$/.exec(wanted);
		const pool = this.books({ trashed: options.trashed });
		if (number) {
			return pool.filter((book) => book.id === Number(number[1]));
		}
		const byUid = pool.filter((book) => book.uid === wanted);
		if (byUid.length > 0) return byUid;
		const title = normalizeTitle(wanted);
		return pool.filter((book) => normalizeTitle(book.title) === title);
	}

	/** The collections search may read: every book not in the trash, or those of the shelves named. */
	searchableCollections(shelfIds?: readonly number[]): number[] {
		return this.books()
			.filter((book) => !shelfIds || shelfIds.includes(book.shelfId ?? -1))
			.map((book) => book.collectionId);
	}

	/** Where a collection's passages are from: "Section / Shelf / Title". */
	collectionLabels(): Map<number, string> {
		const shelves = new Map<number, string>();
		for (const section of this.sections()) {
			for (const shelf of section.shelves) {
				shelves.set(shelf.id, `${section.name} / ${shelf.name}`);
			}
		}
		return new Map(
			this.books().map((book) => [
				book.collectionId,
				`${shelves.get(book.shelfId ?? -1) ?? "?"} / ${book.title}`,
			]),
		);
	}

	createBook(input: {
		shelfId: number;
		title: string;
		description?: string;
		metadata?: BookMetadata;
		uid?: string;
		createdAt?: string;
	}): LibraryBook {
		if (!this.shelf(input.shelfId)) throw new Error("No such shelf.");
		const title = input.title.trim().replace(/\s+/g, " ");
		if (!title) throw new Error("A book needs a title.");
		const uid = input.uid ?? randomBytes(8).toString("hex");
		const collection = this.library.store.ensureCollection(`book:${uid}`);
		const at = now();
		const inserted = this.db
			.prepare(
				"INSERT INTO books(uid, shelf_id, collection_id, title, description, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				uid,
				input.shelfId,
				collection.id,
				title,
				input.description?.trim() ?? "",
				JSON.stringify(input.metadata ?? {}),
				input.createdAt ?? at,
				at,
			);
		const bookId = Number(inserted.lastInsertRowid);
		mkdirSync(join(this.booksDirectory, uid), { recursive: true });
		this.writeBookFile(bookId);
		return this.book(bookId) as LibraryBook;
	}

	/** Change what a book says of itself. `metadata` is merged; a key set to null is removed. */
	updateBook(
		bookId: number,
		change: {
			title?: string;
			description?: string;
			metadata?: Record<string, unknown>;
			shelfId?: number;
		},
	): LibraryBook {
		const book = this.book(bookId);
		if (!book) throw new Error("No such book.");
		if (change.shelfId !== undefined && !this.shelf(change.shelfId)) {
			throw new Error("No such shelf.");
		}
		const metadata: Record<string, unknown> = { ...book.metadata };
		for (const [key, value] of Object.entries(change.metadata ?? {})) {
			if (value === null || value === undefined) delete metadata[key];
			else metadata[key] = value;
		}
		const title =
			change.title !== undefined
				? change.title.trim().replace(/\s+/g, " ")
				: book.title;
		if (!title) throw new Error("A book needs a title.");
		this.db
			.prepare(
				"UPDATE books SET title = ?, description = ?, metadata = ?, shelf_id = ?, updated_at = ? WHERE id = ?",
			)
			.run(
				title,
				change.description !== undefined
					? change.description.trim()
					: book.description,
				JSON.stringify(metadata),
				change.shelfId ?? book.shelfId ?? null,
				now(),
				bookId,
			);
		this.writeBookFile(bookId);
		return this.book(bookId) as LibraryBook;
	}

	/** To the trash: out of every search, and gone for good after thirty days. */
	trashBook(bookId: number): void {
		const book = this.book(bookId);
		if (!book || book.trashedAt) return;
		const shelf =
			book.shelfId !== undefined ? this.shelf(book.shelfId) : undefined;
		this.db
			.prepare(
				"UPDATE books SET trashed_at = ?, trashed_from = ?, shelf_id = NULL WHERE id = ?",
			)
			.run(
				now(),
				JSON.stringify({
					section: shelf?.section ?? LEGACY_SECTION,
					shelf: shelf?.name ?? "Restored",
				}),
				bookId,
			);
	}

	/** Out of the trash, onto the shelf it was on (made again if it is gone) or the one given. */
	restoreBook(bookId: number, shelfId?: number): LibraryBook {
		const book = this.book(bookId);
		if (!book) throw new Error("No such book.");
		if (!book.trashedAt) return book;
		const from = book.trashedFrom ?? {
			section: LEGACY_SECTION,
			shelf: "Restored",
		};
		const target =
			shelfId ??
			this.ensureShelf(this.ensureSection(from.section).id, from.shelf).id;
		if (!this.shelf(target)) throw new Error("No such shelf.");
		this.db
			.prepare(
				"UPDATE books SET trashed_at = NULL, trashed_from = NULL, shelf_id = ? WHERE id = ?",
			)
			.run(target, bookId);
		this.writeBookFile(bookId);
		return this.book(bookId) as LibraryBook;
	}

	/** Delete a book for good: its passages, its vectors and its folder. */
	async purgeBook(bookId: number): Promise<void> {
		const book = this.book(bookId);
		if (!book) return;
		this.db.prepare("DELETE FROM book_images WHERE book_id = ?").run(bookId);
		this.db.prepare("DELETE FROM book_sources WHERE book_id = ?").run(bookId);
		this.db.prepare("DELETE FROM books WHERE id = ?").run(bookId);
		await this.library.removeCollection(book.collectionId);
		rmSync(this.bookDirectory(book), { recursive: true, force: true });
	}

	/** Empty the trash of what has been in it past its days. `days: 0` empties it. */
	async purgeTrash(
		days: number = TRASH_DAYS,
		at: Date = new Date(),
	): Promise<{ books: number; sources: number }> {
		const before = new Date(at.getTime() - days * 86_400_000).toISOString();
		let books = 0;
		for (const book of this.books({ trashed: true })) {
			if ((book.trashedAt ?? "") <= before) {
				await this.purgeBook(book.id);
				books++;
			}
		}
		let sources = 0;
		for (const row of this.all(
			"SELECT id FROM book_sources WHERE removed_at IS NOT NULL AND removed_at <= ?",
			before,
		)) {
			await this.dropSource(Number(row.id));
			sources++;
		}
		return { books, sources };
	}

	// ---- sources --------------------------------------------------------

	private toSource(row: Record<string, unknown>): BookSource {
		return {
			id: Number(row.id),
			bookId: Number(row.book_id),
			kind: String(row.kind) as BookSourceKind,
			sha256: String(row.sha256),
			name: String(row.name),
			...(typeof row.stored === "string" ? { stored: row.stored } : {}),
			...(typeof row.text_file === "string" ? { textFile: row.text_file } : {}),
			...(typeof row.url === "string" ? { url: row.url } : {}),
			bytes: Number(row.bytes ?? 0),
			addedAt: String(row.added_at),
			...(row.document_id != null
				? { documentId: Number(row.document_id) }
				: {}),
			...(typeof row.fingerprint === "string"
				? { fingerprint: parse<number[]>(row.fingerprint, []) }
				: {}),
			metadata: parse<Record<string, unknown>>(row.metadata, {}),
			...(typeof row.removed_at === "string"
				? { removedAt: row.removed_at }
				: {}),
		};
	}

	sources(bookId: number, options: { removed?: boolean } = {}): BookSource[] {
		return this.all(
			`SELECT * FROM book_sources WHERE book_id = ? AND removed_at IS ${options.removed ? "NOT NULL" : "NULL"} ORDER BY added_at, id`,
			bookId,
		).map((row) => this.toSource(row));
	}

	source(sourceId: number): BookSource | undefined {
		const row = this.one("SELECT * FROM book_sources WHERE id = ?", sourceId);
		return row ? this.toSource(row) : undefined;
	}

	images(bookId: number): BookImage[] {
		return this.all(
			"SELECT * FROM book_images WHERE book_id = ? ORDER BY id",
			bookId,
		).map((row) => ({
			id: Number(row.id),
			bookId: Number(row.book_id),
			sourceId: Number(row.source_id),
			sha256: String(row.sha256),
			file: String(row.file),
			mediaType: String(row.media_type),
			bytes: Number(row.bytes ?? 0),
			...(row.width != null ? { width: Number(row.width) } : {}),
			...(row.height != null ? { height: Number(row.height) } : {}),
			...(typeof row.origin === "string" ? { origin: row.origin } : {}),
			described: Number(row.described ?? 0) === 1,
			...(typeof row.description === "string"
				? { description: row.description }
				: {}),
		}));
	}

	/** The name a source is indexed under: its own, made unique within the book. */
	private documentName(
		book: LibraryBook,
		input: AddSourceInput,
		sha256: string,
	): string {
		const name = input.kind === "web" && input.url ? input.url : input.name;
		const taken = this.library.store.findDocument(book.collectionId, name);
		return taken ? `${name} (${sha256.slice(0, 8)})` : name;
	}

	/**
	 * Add a source to a book: the file is copied in under its sha256, its
	 * text and pictures are written beside it, and the text is indexed. The
	 * same content already in the book is left alone; a page of the same
	 * link with other content takes the old one's place.
	 */
	async addSource(
		bookId: number,
		input: AddSourceInput,
		settings: LibrarySettings = DEFAULT_LIBRARY_SETTINGS,
	): Promise<AddSourceResult> {
		const book = this.book(bookId);
		if (!book) throw new Error("No such book.");
		if (!input.text.trim()) {
			throw new Error(`${input.name} has no text to add.`);
		}
		const sha256 =
			input.kind === "file" && input.path
				? await sha256OfFile(input.path)
				: createHash("sha256").update(input.text).digest("hex");
		const current = this.sources(bookId);
		const same = current.find((source) => source.sha256 === sha256);
		if (same) {
			return { source: same, outcome: "unchanged", passages: 0, images: 0 };
		}
		const replaced =
			(input.replaces !== undefined
				? current.find((source) => source.id === input.replaces)
				: undefined) ??
			(input.kind === "web" && input.url
				? current.find((source) => source.url === input.url)
				: undefined);
		if (replaced) await this.dropSource(replaced.id);

		const directory = this.bookDirectory(book);
		for (const part of ["sources", "text", "images"]) {
			mkdirSync(join(directory, part), { recursive: true });
		}
		// Pictures are kept by content, so two sources with the same figure
		// share one file; the text is pointed at the names they have here.
		let text = input.text;
		const pictures: (SourceImageInput & { sha256: string; kept: string })[] =
			[];
		for (const image of input.images ?? []) {
			const hash = createHash("sha256").update(image.data).digest("hex");
			const extension =
				IMAGE_EXTENSIONS[image.mediaType] ??
				(extname(image.file).slice(1).toLowerCase() || "bin");
			const kept = `images/${hash}.${extension}`;
			if (!existsSync(join(directory, kept))) {
				writeFileSync(join(directory, kept), image.data);
			}
			text = text.split(`(images/${image.file})`).join(`(${kept})`);
			pictures.push({ ...image, sha256: hash, kept });
		}
		const textFile = `text/${sha256}.md`;
		writeFileSync(join(directory, textFile), text);
		let stored: string | undefined;
		let bytes = Buffer.byteLength(input.text);
		if (input.kind === "file" && input.path) {
			stored = `sources/${sha256}${extname(input.name).toLowerCase()}`;
			copyFileSync(input.path, join(directory, stored));
			bytes = statSync(input.path).size;
		}

		const added = await this.library.addDocument(
			`book:${book.uid}`,
			{
				source: this.documentName(book, input, sha256),
				title: input.title ?? book.title,
				text,
				bytes,
			},
			settings,
		);
		const inserted = this.db
			.prepare(
				`INSERT INTO book_sources(book_id, kind, sha256, name, stored, text_file, url, bytes, added_at, document_id, fingerprint, metadata)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				bookId,
				input.kind,
				sha256,
				input.name,
				stored ?? null,
				textFile,
				input.url ?? null,
				bytes,
				now(),
				added.document.id,
				JSON.stringify(textFingerprint(text)),
				JSON.stringify({
					...(input.title ? { title: input.title } : {}),
					...input.metadata,
				}),
			);
		const sourceId = Number(inserted.lastInsertRowid);
		for (const picture of pictures) {
			this.db
				.prepare(
					`INSERT INTO book_images(book_id, source_id, sha256, file, media_type, bytes, width, height, origin, description, described)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					bookId,
					sourceId,
					picture.sha256,
					picture.kept,
					picture.mediaType,
					picture.data.byteLength,
					picture.width ?? null,
					picture.height ?? null,
					picture.origin ?? null,
					picture.description ?? null,
					picture.described ? 1 : 0,
				);
		}
		this.db
			.prepare("UPDATE books SET updated_at = ? WHERE id = ?")
			.run(now(), bookId);
		this.writeBookFile(bookId);
		return {
			source: this.source(sourceId) as BookSource,
			outcome: replaced ? "replaced" : "added",
			passages: added.chunkIds.length,
			images: pictures.length,
		};
	}

	/**
	 * Take a source out of its book. It is no longer searched, and its files
	 * stay in the book's folder for thirty days, where `restoreSource` finds
	 * them.
	 */
	async removeSource(sourceId: number): Promise<void> {
		const source = this.source(sourceId);
		if (!source || source.removedAt) return;
		if (source.documentId !== undefined) {
			await this.library.removeDocument(source.documentId);
		}
		this.db
			.prepare(
				"UPDATE book_sources SET removed_at = ?, document_id = NULL WHERE id = ?",
			)
			.run(now(), sourceId);
		this.writeBookFile(source.bookId);
	}

	async restoreSource(
		sourceId: number,
		settings: LibrarySettings = DEFAULT_LIBRARY_SETTINGS,
	): Promise<BookSource> {
		const source = this.source(sourceId);
		if (!source) throw new Error("No such source.");
		if (!source.removedAt) return source;
		const book = this.book(source.bookId);
		if (!book) throw new Error("Its book is gone.");
		const documentId = await this.indexSource(book, source, settings);
		this.db
			.prepare(
				"UPDATE book_sources SET removed_at = NULL, document_id = ? WHERE id = ?",
			)
			.run(documentId ?? null, sourceId);
		this.writeBookFile(book.id);
		return this.source(sourceId) as BookSource;
	}

	/** Index a source's text from its file in the book's folder. */
	private async indexSource(
		book: LibraryBook,
		source: BookSource,
		settings: LibrarySettings,
	): Promise<number | undefined> {
		if (!source.textFile) return undefined;
		const file = join(this.bookDirectory(book), source.textFile);
		if (!existsSync(file)) return undefined;
		const name = source.kind === "web" && source.url ? source.url : source.name;
		const taken = this.library.store.findDocument(book.collectionId, name);
		const added = await this.library.addDocument(
			`book:${book.uid}`,
			{
				source: taken ? `${name} (${source.sha256.slice(0, 8)})` : name,
				title:
					typeof source.metadata.title === "string"
						? source.metadata.title
						: book.title,
				text: readFileSync(file, "utf8"),
				bytes: source.bytes,
			},
			settings,
		);
		return added.document.id;
	}

	/** Remove a source for good: its passages, its vectors, its rows and its files. */
	private async dropSource(
		sourceId: number,
		options: { keepImages?: boolean } = {},
	): Promise<void> {
		const source = this.source(sourceId);
		if (!source) return;
		const book = this.book(source.bookId);
		if (source.documentId !== undefined) {
			await this.library.removeDocument(source.documentId);
		}
		const images = this.images(source.bookId).filter(
			(image) => image.sourceId === sourceId,
		);
		this.db
			.prepare("DELETE FROM book_images WHERE source_id = ?")
			.run(sourceId);
		this.db.prepare("DELETE FROM book_sources WHERE id = ?").run(sourceId);
		if (!book) return;
		const directory = this.bookDirectory(book);
		const others = this.all(
			"SELECT stored, text_file FROM book_sources WHERE book_id = ?",
			book.id,
		);
		for (const file of [source.stored, source.textFile]) {
			if (
				file &&
				!others.some((row) => row.stored === file || row.text_file === file)
			) {
				rmSync(join(directory, file), { force: true });
			}
		}
		if (!options.keepImages) {
			const kept = new Set(this.images(book.id).map((image) => image.file));
			for (const image of images) {
				if (!kept.has(image.file)) {
					rmSync(join(directory, image.file), { force: true });
				}
			}
		}
	}

	/** Give a picture its description, or another one. */
	describeImage(imageId: number, description: string): void {
		const row = this.one(
			"SELECT book_id FROM book_images WHERE id = ?",
			imageId,
		);
		if (!row) throw new Error("No such picture.");
		this.db
			.prepare(
				"UPDATE book_images SET description = ?, described = ? WHERE id = ?",
			)
			.run(description.trim() || null, description.trim() ? 1 : 0, imageId);
		this.writeBookFile(Number(row.book_id));
	}

	/**
	 * Give pictures of one source their descriptions after the fact: each is
	 * kept with its picture, written into the source's text where the picture
	 * is linked, and the source is indexed again so the words can be found.
	 *
	 * This is what adding a book does when a vision model is set; it lets a
	 * book added without one be completed without reading the book again.
	 */
	async describeSourceImages(
		sourceId: number,
		described: readonly { imageId: number; description: string; alt: string }[],
		settings: LibrarySettings = DEFAULT_LIBRARY_SETTINGS,
	): Promise<{ described: number; passages: number }> {
		const source = this.source(sourceId);
		if (!source) throw new Error("No such source.");
		const book = this.book(source.bookId);
		if (!book) throw new Error("Its book is gone.");
		const images = new Map(
			this.images(book.id)
				.filter((image) => image.sourceId === sourceId)
				.map((image) => [image.id, image]),
		);
		const file = source.textFile
			? join(this.bookDirectory(book), source.textFile)
			: undefined;
		let text =
			file && existsSync(file) ? readFileSync(file, "utf8") : undefined;
		let count = 0;
		for (const entry of described) {
			const image = images.get(entry.imageId);
			const description = entry.description.trim();
			if (!image || !description) continue;
			this.db
				.prepare(
					"UPDATE book_images SET description = ?, described = 1 WHERE id = ?",
				)
				.run(description, image.id);
			count++;
			if (text !== undefined) {
				const link = `(${image.file})`;
				const alt = entry.alt.replace(/[[\]\n]/g, " ").trim();
				// Every place the picture is linked: `![anything](images/<hash>)`.
				let from = 0;
				let rebuilt = "";
				for (;;) {
					const at = text.indexOf(link, from);
					if (at < 0) break;
					const open = text.lastIndexOf("![", at);
					const close = text.lastIndexOf("]", at);
					if (
						open >= from &&
						close === at - 1 &&
						!text.slice(open, close).includes("\n")
					) {
						rebuilt += `${text.slice(from, open)}![${alt}]${link}`;
					} else {
						rebuilt += text.slice(from, at + link.length);
					}
					from = at + link.length;
				}
				text = rebuilt + text.slice(from);
			}
		}
		if (count === 0) return { described: 0, passages: 0 };
		let passages = 0;
		if (file && text !== undefined) {
			writeFileSync(file, text);
			const current =
				source.documentId !== undefined
					? this.library.store.getDocument(source.documentId)
					: undefined;
			if (current && !source.removedAt) {
				// The same name in the same collection: its passages are replaced.
				const added = await this.library.addDocument(
					`book:${book.uid}`,
					{
						source: current.source,
						title: current.title ?? book.title,
						text,
						bytes: source.bytes,
					},
					settings,
				);
				passages = added.chunkIds.length;
				this.db
					.prepare(
						"UPDATE book_sources SET document_id = ?, fingerprint = ? WHERE id = ?",
					)
					.run(
						added.document.id,
						JSON.stringify(textFingerprint(text)),
						sourceId,
					);
			}
		}
		this.db
			.prepare("UPDATE books SET updated_at = ? WHERE id = ?")
			.run(now(), book.id);
		this.writeBookFile(book.id);
		return { described: count, passages };
	}

	/**
	 * Move every source of one book into another, and trash the emptied one.
	 * A source the other already holds is left where it is.
	 */
	async mergeBooks(
		fromId: number,
		intoId: number,
		settings: LibrarySettings = DEFAULT_LIBRARY_SETTINGS,
	): Promise<{ moved: number; alreadyThere: number }> {
		const from = this.book(fromId);
		const into = this.book(intoId);
		if (!from || !into) throw new Error("No such book.");
		if (from.id === into.id) throw new Error("That is the same book.");
		const fromDirectory = this.bookDirectory(from);
		const images = this.images(from.id);
		let moved = 0;
		let alreadyThere = 0;
		for (const source of this.sources(from.id)) {
			const text = source.textFile
				? join(fromDirectory, source.textFile)
				: undefined;
			if (!text || !existsSync(text)) {
				alreadyThere++;
				continue;
			}
			const result = await this.addSource(
				into.id,
				{
					kind: source.kind,
					name: source.name,
					path:
						source.kind === "file" && source.stored
							? join(fromDirectory, source.stored)
							: undefined,
					url: source.url,
					text: readFileSync(text, "utf8"),
					metadata: source.metadata,
					images: images
						.filter((image) => image.sourceId === source.id)
						.filter((image) => existsSync(join(fromDirectory, image.file)))
						.map((image) => ({
							file: basename(image.file),
							data: readFileSync(join(fromDirectory, image.file)),
							mediaType: image.mediaType,
							width: image.width,
							height: image.height,
							origin: image.origin,
							description: image.description,
						})),
				},
				settings,
			);
			if (result.outcome === "unchanged") alreadyThere++;
			else moved++;
		}
		this.trashBook(from.id);
		return { moved, alreadyThere };
	}

	// ---- is it here already ---------------------------------------------

	/**
	 * The books that may be this one: the same file, the same link, the same
	 * ISBN, the same title, or text that is largely the same. Books in the
	 * trash are included, and say so.
	 */
	findSimilar(input: FindSimilarInput): BookMatch[] {
		const books = new Map(
			[...this.books(), ...this.books({ trashed: true })].map((book) => [
				book.id,
				book,
			]),
		);
		const matches: BookMatch[] = [];
		const seen = new Set<string>();
		const push = (match: BookMatch) => {
			const key = `${match.book.id}:${match.reason}`;
			if (seen.has(key)) return;
			seen.add(key);
			matches.push(match);
		};
		const sourceRows = this.all(
			"SELECT * FROM book_sources WHERE removed_at IS NULL",
		).map((row) => this.toSource(row));
		for (const source of sourceRows) {
			const book = books.get(source.bookId);
			if (!book) continue;
			if (input.sha256 && source.sha256 === input.sha256) {
				push({ book, source, reason: "same file" });
			}
			if (input.url && source.url === input.url) {
				push({ book, source, reason: "same link" });
			}
		}
		const isbn = input.isbn ? normalizeIsbn(input.isbn) : "";
		const title = input.title ? normalizeTitle(input.title) : "";
		const authors = (input.authors ?? []).map(normalizeTitle).filter(Boolean);
		for (const book of books.values()) {
			if (
				isbn &&
				typeof book.metadata.isbn === "string" &&
				normalizeIsbn(book.metadata.isbn) === isbn
			) {
				push({ book, reason: "same isbn" });
			}
			if (input.url && book.metadata.web?.links?.includes(input.url)) {
				push({ book, reason: "same link" });
			}
			if (title && normalizeTitle(book.title) === title) {
				const theirs = (book.metadata.authors ?? []).map(normalizeTitle);
				const shared = authors.some((author) => theirs.includes(author));
				push({
					book,
					reason: shared ? "same title and author" : "same title",
				});
			}
		}
		if (input.fingerprint && input.fingerprint.length > 0) {
			const floor = input.minSimilarity ?? 0.3;
			const best = new Map<
				number,
				{ source: BookSource; similarity: number }
			>();
			for (const source of sourceRows) {
				if (!source.fingerprint?.length) continue;
				const similarity = fingerprintSimilarity(
					input.fingerprint,
					source.fingerprint,
				);
				if (similarity < floor) continue;
				const known = best.get(source.bookId);
				if (!known || known.similarity < similarity) {
					best.set(source.bookId, { source, similarity });
				}
			}
			for (const [bookId, found] of best) {
				const book = books.get(bookId);
				if (book) {
					push({
						book,
						source: found.source,
						reason: "similar text",
						similarity: found.similarity,
					});
				}
			}
		}
		return matches;
	}

	// ---- the book's own file --------------------------------------------

	private bookFile(book: LibraryBook): BookFile {
		const shelf =
			book.shelfId !== undefined ? this.shelf(book.shelfId) : undefined;
		const sources = this.sources(book.id);
		const names = new Map(sources.map((source) => [source.id, source.sha256]));
		return {
			format: BOOK_FORMAT,
			version: 1,
			uid: book.uid,
			title: book.title,
			description: book.description,
			metadata: book.metadata,
			...(shelf ? { section: shelf.section, shelf: shelf.name } : {}),
			createdAt: book.createdAt,
			updatedAt: book.updatedAt,
			sources: sources.map(
				({ id: _id, bookId: _b, documentId: _d, removedAt: _r, ...rest }) =>
					rest,
			),
			images: this.images(book.id)
				.filter((image) => names.has(image.sourceId))
				.map(({ id: _id, bookId: _b, sourceId, ...rest }) => ({
					...rest,
					source: names.get(sourceId) as string,
				})),
		};
	}

	/** Write `book.json`: what the folder is, for a person and for import. */
	writeBookFile(bookId: number): void {
		const book = this.book(bookId);
		if (!book) return;
		const directory = this.bookDirectory(book);
		mkdirSync(directory, { recursive: true });
		const target = join(directory, "book.json");
		const temporary = `${target}.${randomBytes(4).toString("hex")}.tmp`;
		writeFileSync(
			temporary,
			`${JSON.stringify(this.bookFile(book), null, 2)}\n`,
		);
		renameSync(temporary, target);
	}

	private rewriteBookFiles(filter: {
		sectionId?: number;
		shelfId?: number;
	}): void {
		const shelves =
			filter.shelfId !== undefined
				? [filter.shelfId]
				: this.sections()
						.filter((section) => section.id === filter.sectionId)
						.flatMap((section) => section.shelves.map((shelf) => shelf.id));
		for (const shelfId of shelves) {
			for (const book of this.books({ shelfId })) this.writeBookFile(book.id);
		}
	}

	// ---- export and import ----------------------------------------------

	/**
	 * Write the Library, a section, a shelf or one book to a file: the books'
	 * folders as they are, and where each stood. Vectors are left out; they
	 * are made again where the file is read in, with the model set there.
	 */
	async export(scope: ExportScope, file: string): Promise<ExportResult> {
		const sections = this.sections();
		const wanted = sections
			.map((section) => ({
				section,
				shelves: section.shelves.filter((shelf) => {
					if ("library" in scope) return true;
					if ("sectionId" in scope) return section.id === scope.sectionId;
					if ("shelfId" in scope) return shelf.id === scope.shelfId;
					return this.book(scope.bookId)?.shelfId === shelf.id;
				}),
			}))
			.filter(
				(entry) =>
					entry.shelves.length > 0 ||
					"library" in scope ||
					("sectionId" in scope && entry.section.id === scope.sectionId),
			);
		const manifest: ExportManifest = {
			format: LIBRARY_EXPORT_FORMAT,
			version: 1,
			exportedAt: now(),
			sections: [],
		};
		const books: LibraryBook[] = [];
		for (const { section, shelves } of wanted) {
			manifest.sections.push({
				name: section.name,
				description: section.description,
				shelves: shelves.map((shelf) => {
					const onShelf = this.books({ shelfId: shelf.id }).filter(
						(book) => !("bookId" in scope) || book.id === scope.bookId,
					);
					books.push(...onShelf);
					return {
						name: shelf.name,
						description: shelf.description,
						books: onShelf.map((book) => book.uid),
					};
				}),
			});
		}
		if ("bookId" in scope && books.length === 0) {
			throw new Error("No such book, or it is in the trash.");
		}
		const self = this;
		function* entries(): Generator<TarEntry> {
			yield {
				name: "library/library.json",
				data: `${JSON.stringify(manifest, null, 2)}\n`,
			};
			for (const book of books) {
				self.writeBookFile(book.id);
				const directory = self.bookDirectory(book);
				for (const relative of filesUnder(directory)) {
					if (relative.endsWith(".tmp")) continue;
					yield {
						name: `library/books/${book.uid}/${relative}`,
						path: join(directory, relative),
					};
				}
			}
		}
		const files = await writeTarGz(file, entries());
		return { file, books: books.length, files, bytes: statSync(file).size };
	}

	/**
	 * Read an exported file in. Sections and shelves are made where they are
	 * missing; a book already here is left alone unless told otherwise.
	 */
	async import(
		file: string,
		options: ImportOptions = {},
	): Promise<ImportResult> {
		const settings = options.settings ?? DEFAULT_LIBRARY_SETTINGS;
		const staging = join(
			this.library.directory,
			`import-${randomBytes(4).toString("hex")}`,
		);
		const result: ImportResult = { imported: [], skipped: [] };
		try {
			await extractTarGz(createReadStream(file), staging);
			const manifestFile = join(staging, "library.json");
			if (!existsSync(manifestFile)) {
				throw new Error(
					"That file is not a Library export: it has no library.json.",
				);
			}
			const manifest = parse<ExportManifest | undefined>(
				readFileSync(manifestFile, "utf8"),
				undefined,
			);
			if (manifest?.format !== LIBRARY_EXPORT_FORMAT) {
				throw new Error("That file is not a Library export.");
			}
			for (const section of manifest.sections ?? []) {
				for (const shelf of section.shelves ?? []) {
					const target =
						options.shelfId !== undefined
							? this.shelf(options.shelfId)
							: (() => {
									const made = this.ensureShelf(
										this.ensureSection(section.name, section.description).id,
										shelf.name,
										shelf.description,
									);
									return this.shelf(made.id);
								})();
					if (!target) throw new Error("No such shelf.");
					for (const uid of shelf.books ?? []) {
						if (!/^[a-z0-9-]{4,64}$/i.test(uid)) continue;
						await this.importBook(
							join(staging, "books", uid),
							target,
							options.existing ?? "skip",
							settings,
							result,
						);
					}
				}
			}
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
		return result;
	}

	private async importBook(
		folder: string,
		shelf: LibraryShelf & { section: string },
		existing: "skip" | "replace" | "copy",
		settings: LibrarySettings,
		result: ImportResult,
	): Promise<void> {
		const described = existsSync(join(folder, "book.json"))
			? parse<BookFile | undefined>(
					readFileSync(join(folder, "book.json"), "utf8"),
					undefined,
				)
			: undefined;
		if (described?.format !== BOOK_FORMAT) {
			result.skipped.push({
				title: basename(folder),
				reason: "its book.json is missing or not a book's",
			});
			return;
		}
		let uid = described.uid;
		const here = this.bookByUid(uid);
		if (here) {
			if (existing === "skip") {
				result.skipped.push({
					title: described.title,
					reason: here.trashedAt
						? "it is already here, in the trash"
						: "it is already here",
				});
				return;
			}
			if (existing === "replace") await this.purgeBook(here.id);
			else uid = randomBytes(8).toString("hex");
		}
		const book = this.createBook({
			shelfId: shelf.id,
			title: described.title,
			description: described.description,
			metadata: described.metadata ?? {},
			uid,
			createdAt: described.createdAt,
		});
		const directory = this.bookDirectory(book);
		for (const relative of filesUnder(folder)) {
			if (relative === "book.json") continue;
			mkdirSync(join(directory, relative, ".."), { recursive: true });
			copyFileSync(join(folder, relative), join(directory, relative));
		}
		const ids = new Map<string, number>();
		for (const source of described.sources ?? []) {
			const inserted = this.db
				.prepare(
					`INSERT INTO book_sources(book_id, kind, sha256, name, stored, text_file, url, bytes, added_at, fingerprint, metadata)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					book.id,
					source.kind,
					source.sha256,
					source.name,
					source.stored ?? null,
					source.textFile ?? null,
					source.url ?? null,
					source.bytes ?? 0,
					source.addedAt ?? now(),
					source.fingerprint ? JSON.stringify(source.fingerprint) : null,
					JSON.stringify(source.metadata ?? {}),
				);
			const sourceId = Number(inserted.lastInsertRowid);
			ids.set(source.sha256, sourceId);
			const documentId = await this.indexSource(
				book,
				this.source(sourceId) as BookSource,
				settings,
			);
			this.db
				.prepare("UPDATE book_sources SET document_id = ? WHERE id = ?")
				.run(documentId ?? null, sourceId);
		}
		for (const image of described.images ?? []) {
			const sourceId = ids.get(image.source);
			if (sourceId === undefined) continue;
			this.db
				.prepare(
					`INSERT INTO book_images(book_id, source_id, sha256, file, media_type, bytes, width, height, origin, description, described)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					book.id,
					sourceId,
					image.sha256,
					image.file,
					image.mediaType,
					image.bytes ?? 0,
					image.width ?? null,
					image.height ?? null,
					image.origin ?? null,
					image.description ?? null,
					image.described ? 1 : 0,
				);
		}
		this.writeBookFile(book.id);
		result.imported.push({
			title: book.title,
			section: shelf.section,
			shelf: shelf.name,
		});
	}

	// ---- is everything where it should be --------------------------------

	/** What is wrong with the Library as it stands: missing files, books with nothing in them. */
	problems(): CatalogueProblem[] {
		const found: CatalogueProblem[] = [];
		for (const book of this.books()) {
			const directory = this.bookDirectory(book);
			const sources = this.sources(book.id);
			if (sources.length === 0) {
				found.push({ book: book.title, problem: "has no sources" });
			}
			for (const source of sources) {
				if (source.metadata.notCopied) continue;
				for (const file of [source.stored, source.textFile]) {
					if (file && !existsSync(join(directory, file))) {
						found.push({
							book: book.title,
							problem: `${source.name}: ${file} is missing from its folder`,
						});
					}
				}
				if (source.documentId === undefined) {
					found.push({
						book: book.title,
						problem: `${source.name} is not indexed, so it is not searched`,
					});
				}
			}
		}
		for (const section of this.sections()) {
			if (section.shelves.length === 0) {
				found.push({ problem: `section "${section.name}" has no shelves` });
			}
		}
		return found;
	}
}
