import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOOK_FORMAT, LEGACY_SECTION } from "./catalogue";
import { fingerprintSimilarity, textFingerprint } from "./fingerprint";
import { Library } from "./library";

const PROSE = Array.from(
	{ length: 120 },
	(_unused, n) =>
		`Sentence ${n} explains how the tilemap node number ${n * 7} keeps its cells in a grid and draws them in order.`,
).join(" ");

describe("the Library's catalogue", () => {
	let root: string;
	let library: Library;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "catalogue-"));
		library = new Library({ directory: join(root, "library") });
	});
	afterEach(async () => {
		await library.close();
		rmSync(root, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 100,
		});
	});

	function shelf(section = "Game development", name = "Godot") {
		const catalogue = library.catalogue;
		return catalogue.ensureShelf(catalogue.ensureSection(section).id, name);
	}

	function file(name: string, content: string): string {
		const path = join(root, name);
		writeFileSync(path, content);
		return path;
	}

	it("keeps a book as a folder: the file by its sha256, its text, and book.json", async () => {
		const catalogue = library.catalogue;
		const book = catalogue.createBook({
			shelfId: shelf().id,
			title: "Godot Tilemaps",
			description: "How tilemaps work.",
			metadata: { authors: ["A. Writer"], edition: "2nd" },
		});
		const added = await catalogue.addSource(book.id, {
			kind: "file",
			name: "tilemaps.epub",
			path: file("tilemaps.epub", "not really an epub"),
			text: `# Tilemaps\n\n${PROSE}\n\n![a grid](images/p1.png)`,
			images: [
				{
					file: "p1.png",
					data: new Uint8Array([1, 2, 3]),
					mediaType: "image/png",
					description: "A grid of tiles.",
				},
			],
		});
		expect(added.outcome).toBe("added");
		expect(added.passages).toBeGreaterThan(0);
		const directory = catalogue.bookDirectory(book);
		expect(readdirSync(join(directory, "sources"))).toEqual([
			`${added.source.sha256}.epub`,
		]);
		const text = readFileSync(
			join(directory, added.source.textFile ?? ""),
			"utf8",
		);
		const [image] = catalogue.images(book.id);
		expect(text).toContain(`(${image.file})`);
		expect(existsSync(join(directory, image.file))).toBe(true);
		const described = JSON.parse(
			readFileSync(join(directory, "book.json"), "utf8"),
		);
		expect(described).toMatchObject({
			format: BOOK_FORMAT,
			title: "Godot Tilemaps",
			section: "Game development",
			shelf: "Godot",
			metadata: { authors: ["A. Writer"], edition: "2nd" },
		});
		expect(described.sources[0].sha256).toBe(added.source.sha256);
		expect(described.images[0].description).toBe("A grid of tiles.");

		// A picture held as a file is filed from it, as one given as bytes is.
		const held = file("held.png", "held picture bytes");
		const fromFile = await catalogue.addSource(book.id, {
			kind: "text",
			name: "notes",
			text: `${PROSE} more\n\n![held](images/h.png)`,
			images: [{ file: "h.png", path: held, mediaType: "image/png" }],
		});
		const filed = catalogue
			.images(book.id)
			.find((picture) => picture.sourceId === fromFile.source.id);
		expect(filed?.bytes).toBe("held picture bytes".length);
		expect(readFileSync(join(directory, filed?.file ?? ""), "utf8")).toBe(
			"held picture bytes",
		);

		// The same file again is left alone.
		const again = await catalogue.addSource(book.id, {
			kind: "file",
			name: "copy.epub",
			path: file("copy.epub", "not really an epub"),
			text: "anything",
		});
		expect(again.outcome).toBe("unchanged");
	});

	it("searches the shelves named, labels where a passage is from, and never the trash", async () => {
		const catalogue = library.catalogue;
		const godot = catalogue.createBook({
			shelfId: shelf().id,
			title: "Godot Tilemaps",
		});
		const cooking = catalogue.createBook({
			shelfId: shelf("Home", "Cooking").id,
			title: "Bread",
		});
		await catalogue.addSource(godot.id, {
			kind: "text",
			name: "a",
			text: PROSE,
		});
		await catalogue.addSource(cooking.id, {
			kind: "text",
			name: "b",
			text: "Sourdough needs a starter and a tilemap of patience.",
		});
		expect(catalogue.collectionLabels().get(godot.collectionId)).toBe(
			"Game development / Godot / Godot Tilemaps",
		);
		const home = await library.search("tilemap", {
			collectionIds: catalogue.searchableCollections([cooking.shelfId ?? -1]),
		});
		expect(home.hits.map((hit) => hit.collectionId)).toEqual([
			cooking.collectionId,
		]);
		catalogue.trashBook(cooking.id);
		expect(catalogue.searchableCollections()).toEqual([godot.collectionId]);
		expect(
			catalogue.books({ trashed: true }).map((book) => book.title),
		).toEqual(["Bread"]);
	});

	it("restores a trashed book to its shelf, making the shelf again when it is gone", async () => {
		const catalogue = library.catalogue;
		const place = shelf("Home", "Cooking");
		const book = catalogue.createBook({ shelfId: place.id, title: "Bread" });
		await catalogue.addSource(book.id, {
			kind: "text",
			name: "b",
			text: PROSE,
		});
		expect(catalogue.deleteSection(place.sectionId)).toBe(1);
		expect(catalogue.sections()).toEqual([]);
		const restored = catalogue.restoreBook(book.id);
		expect(catalogue.shelf(restored.shelfId ?? -1)).toMatchObject({
			section: "Home",
			name: "Cooking",
		});
	});

	it("empties the trash of what is past its thirty days, and only that", async () => {
		const catalogue = library.catalogue;
		const old = catalogue.createBook({ shelfId: shelf().id, title: "Old" });
		const recent = catalogue.createBook({
			shelfId: shelf().id,
			title: "Recent",
		});
		await catalogue.addSource(old.id, { kind: "text", name: "o", text: PROSE });
		catalogue.trashBook(old.id);
		catalogue.trashBook(recent.id);
		const directory = catalogue.bookDirectory(old);
		expect(
			await catalogue.purgeTrash(30, new Date(Date.now() + 29 * 86_400_000)),
		).toEqual({
			books: 0,
			sources: 0,
		});
		library.store.database
			.prepare("UPDATE books SET trashed_at = ? WHERE id = ?")
			.run(new Date(Date.now() - 31 * 86_400_000).toISOString(), old.id);
		expect((await catalogue.purgeTrash()).books).toBe(1);
		expect(existsSync(directory)).toBe(false);
		expect(
			catalogue.books({ trashed: true }).map((book) => book.title),
		).toEqual(["Recent"]);
		expect(library.store.counts().documents).toBe(0);
	});

	it("takes a source out of a book without losing it", async () => {
		const catalogue = library.catalogue;
		const book = catalogue.createBook({ shelfId: shelf().id, title: "Godot" });
		const { source } = await catalogue.addSource(book.id, {
			kind: "text",
			name: "notes",
			text: PROSE,
		});
		await catalogue.removeSource(source.id);
		expect(catalogue.sources(book.id)).toEqual([]);
		expect(library.store.counts().documents).toBe(0);
		const back = await catalogue.restoreSource(source.id);
		expect(back.removedAt).toBeUndefined();
		expect(library.store.counts().documents).toBe(1);
	});

	it("replaces a page of the same link when its content changed", async () => {
		const catalogue = library.catalogue;
		const book = catalogue.createBook({
			shelfId: shelf().id,
			title: "Godot-Github",
		});
		const page = {
			kind: "web" as const,
			name: "Recipes",
			url: "https://example.com/r",
		};
		await catalogue.addSource(book.id, { ...page, text: PROSE });
		const same = await catalogue.addSource(book.id, { ...page, text: PROSE });
		expect(same.outcome).toBe("unchanged");
		const changed = await catalogue.addSource(book.id, {
			...page,
			text: `${PROSE} And a new recipe.`,
		});
		expect(changed.outcome).toBe("replaced");
		expect(catalogue.sources(book.id)).toHaveLength(1);
		expect(library.store.counts().documents).toBe(1);
	});

	it("finds a book that is already here: by file, by title, by ISBN, and by its text", async () => {
		const catalogue = library.catalogue;
		const book = catalogue.createBook({
			shelfId: shelf().id,
			title: "Godot Tilemaps: A Guide",
			metadata: { authors: ["A. Writer"], isbn: "978-1-4028-9462-6" },
		});
		const { source } = await catalogue.addSource(book.id, {
			kind: "file",
			name: "t.epub",
			path: file("t.epub", "bytes"),
			text: PROSE,
		});
		const reasons = (input: Parameters<typeof catalogue.findSimilar>[0]) =>
			catalogue.findSimilar(input).map((match) => match.reason);
		expect(reasons({ sha256: source.sha256 })).toEqual(["same file"]);
		expect(reasons({ isbn: "9781402894626" })).toEqual(["same isbn"]);
		expect(
			reasons({ title: "godot tilemaps - a guide", authors: ["a. writer"] }),
		).toEqual(["same title and author"]);
		expect(reasons({ title: "Godot Tilemaps: A Guide" })).toEqual([
			"same title",
		]);
		// A new edition: most of the text, with a chapter added.
		const edition = `${PROSE} ${Array.from({ length: 30 }, (_u, n) => `A new chapter ${n} about navigation layers and their agents in version four.`).join(" ")}`;
		const [similar] = catalogue.findSimilar({
			fingerprint: textFingerprint(edition),
		});
		expect(similar.reason).toBe("similar text");
		expect(similar.similarity).toBeGreaterThan(0.5);
		expect(similar.similarity).toBeLessThan(1);
		expect(
			catalogue.findSimilar({
				fingerprint: textFingerprint(
					"An unrelated text about bread and ovens and flour and salt and water.",
				),
			}),
		).toEqual([]);
		// In the trash it is still found, and says so.
		catalogue.trashBook(book.id);
		expect(
			catalogue.findSimilar({ sha256: source.sha256 })[0].book.trashedAt,
		).toBeTruthy();
	});

	it("keeps a source's running heads, and weighs a title match by the text", async () => {
		const catalogue = library.catalogue;
		const paged = (head: string) =>
			Array.from(
				{ length: 8 },
				(_u, n) => `## Page ${n + 1}\n\n${head}\n${PROSE} ${n}.\n${n + 1}\n`,
			).join("\n");
		const head = "24592 rev 3.23 amd64 technology";
		const book = catalogue.createBook({
			shelfId: shelf().id,
			title: "AMD64 Architecture Programmer's Manual",
		});
		const { source } = await catalogue.addSource(book.id, {
			kind: "file",
			name: "v1.pdf",
			path: file("v1.pdf", "bytes"),
			text: paged("24592 Rev 3.23 AMD64 Technology"),
		});
		expect(catalogue.sources(book.id)[0].metadata.runningHeads).toEqual([head]);
		// Every volume of the set carries its title, and almost none of its text.
		const [title] = catalogue.findSimilar({
			title: "AMD64 Architecture Programmer's Manual",
			fingerprint: textFingerprint(
				"An unrelated text about bread and ovens and flour and salt and water.",
			),
		});
		expect(title).toMatchObject({
			reason: "same title",
			similarity: 0,
			runningHeads: [head],
		});
		// Added before heads were kept: read from its text once, and kept.
		(
			catalogue as unknown as {
				db: { prepare(sql: string): { run(...values: unknown[]): void } };
			}
		).db
			.prepare("UPDATE book_sources SET metadata = '{}' WHERE id = ?")
			.run(source.id);
		const [text] = catalogue.findSimilar({
			fingerprint: textFingerprint(paged("24592 Rev 3.23 AMD64 Technology")),
		});
		expect(text).toMatchObject({
			reason: "similar text",
			runningHeads: [head],
		});
		expect(catalogue.sources(book.id)[0].metadata.runningHeads).toEqual([head]);
	});

	it("tells the same text in another layout from another text", () => {
		const flowed = textFingerprint(PROSE.replace(/\. /g, ".\n\n"));
		expect(fingerprintSimilarity(textFingerprint(PROSE), flowed)).toBe(1);
		expect(textFingerprint("too short")).toEqual([]);
	});

	it("merges one book into another and trashes the emptied one", async () => {
		const catalogue = library.catalogue;
		const one = catalogue.createBook({
			shelfId: shelf().id,
			title: "Part one",
		});
		const two = catalogue.createBook({
			shelfId: shelf().id,
			title: "Part two",
		});
		await catalogue.addSource(one.id, { kind: "text", name: "1", text: PROSE });
		await catalogue.addSource(two.id, {
			kind: "text",
			name: "2",
			text: `${PROSE} More.`,
		});
		expect(await catalogue.mergeBooks(two.id, one.id)).toEqual({
			moved: 1,
			alreadyThere: 0,
		});
		expect(catalogue.sources(one.id)).toHaveLength(2);
		expect(catalogue.book(two.id)?.trashedAt).toBeTruthy();
	});

	it("exports a mixed selection: a whole shelf and one book from elsewhere", async () => {
		const catalogue = library.catalogue;
		const godot = shelf();
		catalogue.createBook({ shelfId: godot.id, title: "Tilemaps" });
		catalogue.createBook({ shelfId: godot.id, title: "Shaders" });
		const cooking = shelf("Home", "Cooking");
		const bread = catalogue.createBook({ shelfId: cooking.id, title: "Bread" });
		catalogue.createBook({ shelfId: cooking.id, title: "Soup" });
		catalogue.createBook({
			shelfId: shelf("Home", "Garden").id,
			title: "Roses",
		});
		const archive = join(root, "selection.cbl.tar.gz");
		const exported = await catalogue.export(
			{ selection: { shelfIds: [godot.id], bookIds: [bread.id] } },
			archive,
		);
		expect(exported.books).toBe(3);

		const other = new Library({ directory: join(root, "other") });
		try {
			const result = await other.catalogue.import(archive);
			expect(
				result.imported.map((entry) => `${entry.shelf}/${entry.title}`).sort(),
			).toEqual(["Cooking/Bread", "Godot/Shaders", "Godot/Tilemaps"]);
		} finally {
			await other.close();
		}
		await expect(
			catalogue.export({ selection: {} }, join(root, "none.tar.gz")),
		).rejects.toThrow("Nothing selected");
	});

	it("exports a shelf and reads it into another Library, files and all", async () => {
		const catalogue = library.catalogue;
		const place = shelf();
		const book = catalogue.createBook({
			shelfId: place.id,
			title: "Godot Tilemaps",
			description: "How tilemaps work.",
			metadata: {
				web: {
					query: "godot tilemap recipes",
					links: ["https://example.com/r"],
				},
			},
		});
		const { source } = await catalogue.addSource(book.id, {
			kind: "file",
			name: "tilemaps.epub",
			path: file("tilemaps.epub", "the original bytes"),
			text: `${PROSE}\n\n![x](images/a.png)`,
			images: [
				{
					file: "a.png",
					data: new Uint8Array([9, 9]),
					mediaType: "image/png",
					description: "A picture.",
				},
			],
		});
		catalogue.createBook({
			shelfId: shelf("Home", "Cooking").id,
			title: "Bread",
		});
		const archive = join(root, "godot.cbl.tar.gz");
		const exported = await catalogue.export({ shelfId: place.id }, archive);
		expect(exported.books).toBe(1);

		const other = new Library({ directory: join(root, "other") });
		try {
			const result = await other.catalogue.import(archive);
			expect(result.imported).toEqual([
				{
					title: "Godot Tilemaps",
					section: "Game development",
					shelf: "Godot",
				},
			]);
			const [copy] = other.catalogue.books();
			expect(copy).toMatchObject({
				uid: book.uid,
				description: "How tilemaps work.",
				metadata: { web: { query: "godot tilemap recipes" } },
			});
			const directory = other.catalogue.bookDirectory(copy);
			expect(readFileSync(join(directory, source.stored ?? ""), "utf8")).toBe(
				"the original bytes",
			);
			expect(other.catalogue.images(copy.id)[0].description).toBe("A picture.");
			const found = await other.search("tilemap", {
				collectionIds: other.catalogue.searchableCollections(),
			});
			expect(found.hits.length).toBeGreaterThan(0);
			// Read in again, the book is already there.
			expect((await other.catalogue.import(archive)).skipped).toEqual([
				{ title: "Godot Tilemaps", reason: "it is already here" },
			]);
			const copied = await other.catalogue.import(archive, {
				existing: "copy",
			});
			expect(copied.imported).toHaveLength(1);
			expect(other.catalogue.books()).toHaveLength(2);
		} finally {
			await other.close();
		}
	});

	it("refuses a file that is not a Library export", async () => {
		const path = file("x.tar.gz", "not an archive");
		await expect(library.catalogue.import(path)).rejects.toThrow();
		expect(
			readdirSync(library.directory).filter((name) =>
				name.startsWith("import-"),
			),
		).toEqual([]);
	});

	it("puts the collections of a Library from before shelves on shelves", async () => {
		await library.addDocument("manuals", {
			source: "/docs/guide.md",
			text: PROSE,
		});
		const catalogue = library.catalogue;
		const [section] = catalogue.sections();
		expect(section.name).toBe(LEGACY_SECTION);
		expect(section.shelves.map((entry) => entry.name)).toEqual(["manuals"]);
		const [book] = catalogue.books();
		expect(catalogue.sources(book.id)[0]).toMatchObject({
			name: "guide.md",
			metadata: { path: "/docs/guide.md", notCopied: true },
		});
		expect(catalogue.problems()).toEqual([]);
	});

	it("says what is wrong with the Library", async () => {
		const catalogue = library.catalogue;
		const book = catalogue.createBook({ shelfId: shelf().id, title: "Godot" });
		const { source } = await catalogue.addSource(book.id, {
			kind: "text",
			name: "n",
			text: PROSE,
		});
		catalogue.createBook({ shelfId: shelf().id, title: "Empty" });
		rmSync(join(catalogue.bookDirectory(book), source.textFile ?? ""));
		expect(catalogue.problems().map((entry) => entry.problem)).toEqual([
			"has no sources",
			expect.stringContaining("is missing from its folder"),
		]);
	});
});
