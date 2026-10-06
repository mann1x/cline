import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkText } from "./chunker";
import { chunkContext, LibraryStore, queryTerms } from "./library-store";

describe("LibraryStore", () => {
	let root: string;
	let store: LibraryStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "library-store-"));
		store = new LibraryStore(join(root, "library.db"));
	});
	afterEach(async () => {
		store.close();
		await rm(root, { recursive: true, force: true });
	});

	const add = (
		collectionId: number,
		source: string,
		text: string,
		extra: { title?: string; hash?: string } = {},
	) =>
		store.addDocument(
			collectionId,
			{ source, title: extra.title, contentHash: extra.hash ?? text },
			chunkText(text, { size: 200, overlap: 0 }),
		);

	it("creates a collection once and counts what is in it", () => {
		const books = store.ensureCollection("Books");
		expect(store.ensureCollection(" Books ").id).toBe(books.id);
		add(
			books.id,
			"/b/moby.md",
			"# Loomings\nCall me Ishmael.\n# The Carpet-Bag\nI stuffed a shirt or two.",
		);
		expect(store.listCollections()).toMatchObject([
			{ name: "Books", documents: 1, chunks: 2 },
		]);
		expect(() => store.ensureCollection("  ")).toThrow("needs a name");
	});

	it("finds a chunk by its words, best match first, with where it came from", () => {
		const books = store.ensureCollection("Books");
		add(
			books.id,
			"/b/whales.md",
			"# Whales\nThe sperm whale dives deep to hunt squid.\n# Ships\nThe ship left Nantucket at dawn.",
		);
		add(
			books.id,
			"/b/cooking.md",
			"# Squid\nFry the squid quickly. Squid toughens when it cooks long. Serve the squid hot.",
		);
		const hits = store.searchKeywords("How do I cook squid?");
		expect(hits.map((hit) => hit.source)).toEqual([
			"/b/cooking.md",
			"/b/whales.md",
		]);
		expect(hits[0].score).toBeGreaterThan(hits[1].score);
		expect(hits[1]).toMatchObject({
			headings: ["Whales"],
			text: expect.stringContaining("sperm whale"),
		});
		const whales = store
			.listDocuments(books.id)
			.find((d) => d.source === "/b/whales.md");
		expect(hits[1].documentId).toBe(whales?.id);
	});

	it("matches without regard to case or accents, and survives punctuation in the query", () => {
		const books = store.ensureCollection("Books");
		add(books.id, "/b/caffe.md", "Il caffè è pronto. Perché no?");
		expect(store.searchKeywords("CAFFE")).toHaveLength(1);
		expect(store.searchKeywords("perche")).toHaveLength(1);
		expect(store.searchKeywords('caffè" OR (NEAR *')).toHaveLength(1);
		expect(store.searchKeywords("?!")).toEqual([]);
		expect(queryTerms("Perché, perché no?")).toEqual(["perche", "no"]);
	});

	it("matches the file name, title and headers unless told to search the text alone", () => {
		const books = store.ensureCollection("Books");
		add(books.id, "/b/moby-dick.md", "# Loomings\nCall me Ishmael.", {
			title: "Moby Dick, or The Whale",
		});
		expect(chunkContext({ source: "/b/moby-dick.md", title: "T" }, ["H"])).toBe(
			"moby dick md | T | H",
		);
		expect(store.searchKeywords("whale")).toHaveLength(1);
		expect(store.searchKeywords("loomings moby")).toHaveLength(1);
		expect(store.searchKeywords("whale", { contextWeight: 0 })).toEqual([]);
		expect(store.searchKeywords("ishmael", { contextWeight: 0 })).toHaveLength(
			1,
		);
	});

	it("searches only the collections asked for", () => {
		const a = store.ensureCollection("A");
		const b = store.ensureCollection("B");
		add(a.id, "/a.md", "Alpha text about harpoons.");
		add(b.id, "/b.md", "Beta text about harpoons.");
		expect(store.searchKeywords("harpoons")).toHaveLength(2);
		expect(
			store
				.searchKeywords("harpoons", { collectionIds: [b.id] })
				.map((h) => h.source),
		).toEqual(["/b.md"]);
	});

	it("leaves an unchanged document alone and replaces a changed one, index included", () => {
		const books = store.ensureCollection("Books");
		const first = add(
			books.id,
			"/b/notes.md",
			"The old text mentions harpoons.",
			{ hash: "v1" },
		);
		expect(first.outcome).toBe("added");
		expect(first.chunkIds).toHaveLength(1);
		expect(
			add(books.id, "/b/notes.md", "ignored", { hash: "v1" }),
		).toMatchObject({ outcome: "unchanged", chunkIds: [] });
		const second = add(
			books.id,
			"/b/notes.md",
			"The new text mentions lanterns.",
			{ hash: "v2" },
		);
		expect(second.outcome).toBe("replaced");
		expect(store.searchKeywords("harpoons")).toEqual([]);
		expect(store.searchKeywords("lanterns")).toHaveLength(1);
		expect(store.listDocuments(books.id)).toHaveLength(1);
	});

	it("removes a document or a whole collection from the index too", () => {
		const a = store.ensureCollection("A");
		const b = store.ensureCollection("B");
		const doc = add(a.id, "/a.md", "Alpha harpoons.").document;
		add(a.id, "/a2.md", "More alpha harpoons.");
		add(b.id, "/b.md", "Beta harpoons.");
		store.deleteDocument(doc.id);
		expect(
			store
				.searchKeywords("harpoons")
				.map((h) => h.source)
				.sort(),
		).toEqual(["/a2.md", "/b.md"]);
		store.deleteCollection(a.id);
		expect(store.searchKeywords("harpoons").map((h) => h.source)).toEqual([
			"/b.md",
		]);
		expect(store.searchKeywords("alpha")).toEqual([]);
		expect(store.listCollections().map((c) => c.name)).toEqual(["B"]);
	});

	it("returns chunks by id in the order asked", () => {
		const books = store.ensureCollection("Books");
		const { chunkIds } = add(
			books.id,
			"/b/x.md",
			"# One\nFirst.\n# Two\nSecond.\n# Three\nThird.",
		);
		const got = store.getChunks([chunkIds[2], 999999, chunkIds[0]]);
		expect(got.map((c) => c.headings[0])).toEqual(["Three", "One"]);
	});

	it("does not let words found everywhere decide the result", () => {
		const books = store.ensureCollection("Books");
		for (let i = 0; i < 300; i++) {
			add(
				books.id,
				`/b/filler-${i}.md`,
				`The the the the page ${i} of the the the book is the the one.`,
			);
		}
		add(books.id, "/b/target.md", "A narwhal has one tusk.");
		const hits = store.searchKeywords("the narwhal", { limit: 5 });
		expect(hits).toHaveLength(1);
		expect(hits[0].source).toBe("/b/target.md");
		// A query of nothing but common words still searches for them.
		expect(store.searchKeywords("the", { limit: 5 })).toHaveLength(5);
	});

	it("keeps what was stored across a reopen", () => {
		const books = store.ensureCollection("Books");
		add(books.id, "/b/x.md", "Persistent harpoons.");
		store.close();
		store = new LibraryStore(join(root, "library.db"));
		expect(store.searchKeywords("harpoons")).toHaveLength(1);
	});
});
