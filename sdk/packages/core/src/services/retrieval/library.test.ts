import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_LIBRARY_SETTINGS,
	resolveLibrarySettings,
} from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLanceDbInstalled } from "./lancedb-runtime";
import { closeSharedLibraries, Library, sharedLibrary } from "./library";

const runtimeDirectory = process.env.CEREBRILINE_LANCEDB_RUNTIME;
const lanceAvailable = Boolean(
	runtimeDirectory && isLanceDbInstalled({ directory: runtimeDirectory }),
);

const embedding = { baseUrl: "http://embed.test", model: "toy" };

/** Three dimensions, one per subject: enough to tell meanings apart. */
function toyVector(text: string): number[] {
	const has = (pattern: RegExp) => (pattern.test(text) ? 1 : 0);
	const vector = [
		has(/coolant|overheat|thermostat|radiator|hot/i),
		has(/oil|filter|gearbox/i),
		has(/tyre|pressure|spare/i),
	];
	return vector.some(Boolean) ? vector : [0.01, 0.01, 0.01];
}

function embedder(options: { failAfter?: number } = {}) {
	const state = { requests: 0, texts: 0 };
	const send = (async (_input: string | URL | Request, init?: RequestInit) => {
		const input = JSON.parse(String(init?.body)).input as string[];
		state.requests++;
		if (options.failAfter !== undefined && state.requests > options.failAfter) {
			return new Response("bad input", { status: 400 });
		}
		state.texts += input.length;
		return Response.json({
			data: input.map((text, index) => ({ index, embedding: toyVector(text) })),
		});
	}) as typeof fetch;
	return { send, state };
}

describe("resolveLibrarySettings", () => {
	it("gives the defaults for nothing stored", () => {
		expect(resolveLibrarySettings(undefined)).toEqual(DEFAULT_LIBRARY_SETTINGS);
		expect(DEFAULT_LIBRARY_SETTINGS).toMatchObject({
			chunkSize: 1500,
			chunkOverlap: 100,
			chunkMinSize: 0,
			topK: 5,
			topKReranker: 3,
			relevanceThreshold: 0,
			rerankingBatchSize: 32,
			hybridSearch: true,
		});
	});

	it("keeps values in range and ignores what is not a value", () => {
		const settings = resolveLibrarySettings({
			chunkSize: 400,
			chunkOverlap: 9999,
			bm25Weight: 7,
			topK: "12",
			topKReranker: "many",
			splitter: "sentences",
			hybridSearch: "yes",
		});
		expect(settings.chunkSize).toBe(400);
		// An overlap of the whole chunk would never advance.
		expect(settings.chunkOverlap).toBe(200);
		expect(settings.bm25Weight).toBe(1);
		expect(settings.topK).toBe(12);
		expect(settings.topKReranker).toBe(3);
		expect(settings.splitter).toBe("characters");
		expect(settings.hybridSearch).toBe(true);
	});
});

describe("closeSharedLibraries", () => {
	it("closes what the process opened, and the next use opens it afresh", async () => {
		const root = await mkdtemp(join(tmpdir(), "library-shared-"));
		try {
			const directory = join(root, "library");
			const first = sharedLibrary({ directory });
			first.store.listCollections();
			expect(sharedLibrary({ directory })).toBe(first);
			await closeSharedLibraries();
			// Closed: on Windows the folder could not be removed otherwise.
			expect(() => first.store.listCollections()).toThrow();
			const second = sharedLibrary({ directory });
			expect(second).not.toBe(first);
			expect(Array.isArray(second.store.listCollections())).toBe(true);
			await closeSharedLibraries();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("Library", () => {
	let root: string;
	let library: Library;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "library-"));
	});
	afterEach(async () => {
		await library?.close();
		await rm(root, { recursive: true, force: true });
	});

	const open = (send?: typeof fetch, runtime = join(root, "no-runtime")) => {
		library = new Library({
			directory: join(root, "library"),
			runtimeDirectory: runtime,
			fetch: send,
		});
		return library;
	};

	const manual = {
		source: "manual.md",
		title: "Workshop manual",
		text: "# Cooling\n\nThe coolant pump is held by four bolts.\n\n# Oil\n\nChange the oil and the filter together.\n",
	};

	it("is searchable by keyword as soon as a document is added, with no LanceDB", async () => {
		open();
		const added = await library.addDocument("manuals", manual);
		expect(added.outcome).toBe("added");
		expect(library.vectorState().installed).toBe(false);
		const result = await library.search("coolant pump");
		expect(result.mode).toBe("keyword");
		expect(result.hits[0].headings).toEqual(["Cooling"]);
		expect(result.hits[0].title).toBe("Workshop manual");
	});

	it("leaves an unchanged document alone, and re-chunks it when the settings change", async () => {
		open();
		await library.addDocument("manuals", manual);
		expect((await library.addDocument("manuals", manual)).outcome).toBe(
			"unchanged",
		);
		const again = await library.addDocument("manuals", manual, {
			...DEFAULT_LIBRARY_SETTINGS,
			markdownHeaders: false,
		});
		expect(again.outcome).toBe("replaced");
		expect(library.store.counts().documents).toBe(1);
	});

	it("embeds nothing, and says why, while LanceDB is not installed", async () => {
		const { send, state } = embedder();
		open(send);
		await library.addDocument("manuals", manual);
		const result = await library.embedPending({ embedding });
		expect(result).toEqual({
			documents: 0,
			chunks: 0,
			skipped: "LanceDB is not installed yet.",
		});
		expect(state.requests).toBe(0);
		// And a search with an embedding model still answers, by keyword.
		const found = await library.search("coolant", { embedding });
		expect(found.mode).toBe("keyword");
		expect(found.hits).toHaveLength(1);
	});

	describe.skipIf(!lanceAvailable)("with a real LanceDB", () => {
		const docs = {
			"cooling.md":
				"When the engine runs hot, look at the thermostat and the radiator fan.",
			"oil.md":
				"Change the oil every ten thousand kilometres, and the filter with it.",
			"tyres.md": "Tyre pressure is checked cold, including the spare.",
		};
		const fill = async () => {
			for (const [source, text] of Object.entries(docs)) {
				await library.addDocument("manuals", { source, text });
			}
		};

		it("embeds what is pending, once, and finds by meaning", async () => {
			const { send, state } = embedder();
			open(send, runtimeDirectory);
			await fill();
			const seen: number[] = [];
			const first = await library.embedPending({
				embedding,
				onProgress: (progress) => seen.push(progress.documentIndex),
			});
			expect(first).toEqual({ documents: 3, chunks: 3, dimension: 3 });
			expect(seen).toEqual([0, 1, 2]);
			expect(library.store.counts("toy").embeddedDocuments).toBe(3);
			const before = state.requests;
			expect(await library.embedPending({ embedding })).toEqual({
				documents: 0,
				chunks: 0,
			});
			expect(state.requests).toBe(before);

			// No word of the query is in the document it means.
			const result = await library.search("overheating", { embedding });
			expect(result.mode).toBe("hybrid");
			expect(result.notes).toEqual([]);
			expect(result.hits[0].source).toBe("cooling.md");
			expect(result.hits[0].vectorRank).toBe(1);
			expect(result.hits[0].keywordRank).toBeUndefined();
		});

		it("picks up where a failed run stopped, without duplicates", async () => {
			const failing = embedder({ failAfter: 1 });
			open(failing.send, runtimeDirectory);
			await fill();
			await expect(library.embedPending({ embedding })).rejects.toThrow(/400/);
			expect(library.store.counts("toy").embeddedDocuments).toBe(1);
			await library.close();

			const { send, state } = embedder();
			open(send, runtimeDirectory);
			const resumed = await library.embedPending({ embedding });
			expect(resumed.documents).toBe(2);
			expect(state.texts).toBe(2);
			const index = await library.vectors();
			expect(await index?.count("toy")).toBe(3);
		});

		/** The toy embedder, with its vectors padded to another size. */
		const sized = (dimension: number) =>
			(async (_input: string | URL | Request, init?: RequestInit) => {
				const input = JSON.parse(String(init?.body)).input as string[];
				return Response.json({
					data: input.map((text, index) => ({
						index,
						embedding: [
							...toyVector(text),
							...new Array(dimension - 3).fill(0),
						],
					})),
				});
			}) as typeof fetch;

		it("keeps one model's vectors when another model embeds the same documents", async () => {
			const { send, state } = embedder();
			open(send, runtimeDirectory);
			await fill();
			await library.embedPending({ embedding });
			const other = { ...embedding, model: "other" };
			expect((await library.embedPending({ embedding: other })).documents).toBe(
				3,
			);
			const index = await library.vectors();
			// The first model's set is whole: going back to it costs nothing.
			expect(await index?.count("toy")).toBe(3);
			expect(await index?.count("other")).toBe(3);
			const before = state.requests;
			expect((await library.embedPending({ embedding })).documents).toBe(0);
			expect(state.requests).toBe(before);
			const result = await library.search("overheating", { embedding });
			expect(result.hits[0].source).toBe("cooling.md");
			expect(result.notes).toEqual([]);
		});

		it("embeds again when the same model comes back with another vector size", async () => {
			open(embedder().send, runtimeDirectory);
			await fill();
			await library.embedPending({ embedding });
			await library.close();

			// The same name, five numbers instead of three.
			open(sized(5), runtimeDirectory);
			// Nothing has said so yet: by its records everything is embedded.
			expect((await library.embedPending({ embedding })).documents).toBe(0);
			// A search does: its own vector is the new size, and finds no set of it.
			const stale = await library.search("overheating", { embedding });
			expect(stale.mode).toBe("keyword");
			expect(stale.notes[0]).toContain("embedded with toy yet");
			expect(library.store.counts("toy").embeddedDocuments).toBe(0);
			// And now the documents are known to be waiting.
			expect(await library.embedPending({ embedding })).toMatchObject({
				documents: 3,
				dimension: 5,
			});
			expect(library.store.counts("toy").embeddedDocuments).toBe(3);
			const found = await library.search("overheating", { embedding });
			expect(found.hits[0].source).toBe("cooling.md");
			expect(found.hits[0].vectorRank).toBe(1);
		});

		it("learns the new size at once when asked to look first", async () => {
			open(embedder().send, runtimeDirectory);
			await fill();
			await library.embedPending({ embedding });
			await library.close();
			open(sized(4), runtimeDirectory);
			expect(
				await library.embedPending({ embedding, probe: true }),
			).toMatchObject({ documents: 3, dimension: 4 });
		});

		it("lists the sets of vectors, and deletes one so that its documents are embedded again", async () => {
			const { send } = embedder();
			open(send, runtimeDirectory);
			await fill();
			await library.embedPending({ embedding });
			await library.embedPending({
				embedding: { ...embedding, model: "Other/Model:v2" },
			});
			const sets = await library.vectorSets("toy");
			expect(
				sets.map(({ bytes, ...set }) => ({ ...set, onDisk: bytes > 0 })),
			).toEqual([
				{
					table: "vectors_other_model_v2_3",
					// Its own name, not the table's spelling of it.
					model: "Other/Model:v2",
					dimension: 3,
					vectors: 3,
					documents: 3,
					current: false,
					onDisk: true,
				},
				{
					table: "vectors_toy_3",
					model: "toy",
					dimension: 3,
					vectors: 3,
					documents: 3,
					current: true,
					onDisk: true,
				},
			]);
			expect(await library.deleteVectorSet("vectors_other_model_v2_3")).toBe(
				true,
			);
			expect(await library.deleteVectorSet("vectors_nope_3")).toBe(false);
			expect((await library.vectorSets("toy")).map((set) => set.table)).toEqual(
				["vectors_toy_3"],
			);
			expect(library.store.counts("Other/Model:v2").embeddedDocuments).toBe(0);
			expect(
				(
					await library.embedPending({
						embedding: { ...embedding, model: "Other/Model:v2" },
					})
				).documents,
			).toBe(3);
		});

		it("removes vectors with their document, and replaces them with its new text", async () => {
			const { send } = embedder();
			open(send, runtimeDirectory);
			await fill();
			await library.embedPending({ embedding });
			const index = await library.vectors();

			const replaced = await library.addDocument("manuals", {
				source: "tyres.md",
				text: "The gearbox takes two litres of oil.",
			});
			expect(replaced.outcome).toBe("replaced");
			expect(await index?.count("toy")).toBe(2);
			expect((await library.embedPending({ embedding })).documents).toBe(1);
			expect(await index?.count("toy")).toBe(3);
			const tyres = await library.search("tyre pressure", { embedding });
			// The old text is gone from both indexes; the source now holds the new.
			expect(tyres.hits.some((hit) => /Tyre pressure/.test(hit.text))).toBe(
				false,
			);
			expect(tyres.hits.find((hit) => hit.source === "tyres.md")?.text).toMatch(
				/gearbox/,
			);

			const [first] = library.store.listDocuments(
				library.store.ensureCollection("manuals").id,
			);
			await library.removeDocument(first.id);
			expect(await index?.count("toy")).toBe(2);
			await library.removeCollection(
				library.store.ensureCollection("manuals").id,
			);
			expect(await index?.count("toy")).toBe(0);
		});

		it("embeds with another model beside the first", async () => {
			const { send } = embedder();
			open(send, runtimeDirectory);
			await fill();
			await library.embedPending({ embedding });
			const other = { ...embedding, model: "toy-2" };
			expect((await library.embedPending({ embedding: other })).documents).toBe(
				3,
			);
			const index = await library.vectors();
			expect((await index?.tableNames())?.sort()).toEqual([
				"vectors_toy_2_3",
				"vectors_toy_3",
			]);
		});
	});
});
