import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isLanceDbInstalled, loadLanceDb } from "./lancedb-runtime";
import { VectorIndex, vectorTableName } from "./vector-index";

/**
 * These run against a real LanceDB, which is a download of 200 MB and more
 * and so is not part of the checkout. Point CEREBRILINE_LANCEDB_RUNTIME at a
 * folder `installLanceDb` filled to run them; without it they are skipped.
 */
const directory = process.env.CEREBRILINE_LANCEDB_RUNTIME;
const available = Boolean(directory && isLanceDbInstalled({ directory }));

const unit = (values: number[]) => {
	const length = Math.hypot(...values);
	return new Float32Array(values.map((value) => value / length));
};

describe("vectorTableName", () => {
	it("names a table after the model and the dimension", () => {
		expect(vectorTableName("snowflake-arctic-embed2:latest", 1024)).toBe(
			"vectors_snowflake_arctic_embed2_latest_1024",
		);
		expect(vectorTableName("BAAI/bge-m3", 1024)).toBe(
			"vectors_baai_bge_m3_1024",
		);
		expect(vectorTableName("///", 8)).toBe("vectors_model_8");
	});
});

describe.skipIf(!available)("VectorIndex, on a real LanceDB", () => {
	let root: string;
	let index: VectorIndex;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "vector-index-"));
		index = await VectorIndex.open(
			loadLanceDb({ directory: directory as string }),
			join(root, "vectors"),
		);
	});
	afterEach(async () => {
		index.close();
		await rm(root, { recursive: true, force: true });
	});

	const rows = [
		{ chunkId: 1, collectionId: 1, documentId: 10, vector: unit([1, 0, 0, 0]) },
		{
			chunkId: 2,
			collectionId: 1,
			documentId: 10,
			vector: unit([0.9, 0.4, 0, 0]),
		},
		{ chunkId: 3, collectionId: 2, documentId: 20, vector: unit([0, 1, 0, 0]) },
		{ chunkId: 4, collectionId: 2, documentId: 21, vector: unit([0, 0, 1, 0]) },
	];

	it("answers nothing before anything is added", async () => {
		expect(await index.search("m", unit([1, 0, 0, 0]))).toEqual([]);
		expect(await index.count("m")).toBe(0);
	});

	it("finds the nearest vectors, as cosine similarity", async () => {
		await index.add("m", rows);
		const hits = await index.search("m", unit([1, 0.1, 0, 0]), { limit: 3 });
		expect(hits.map((hit) => hit.chunkId)).toEqual([1, 2, 3]);
		expect(hits[0].similarity).toBeGreaterThan(0.99);
		expect(hits[2].similarity).toBeLessThan(0.2);
		expect(await index.count("m")).toBe(4);
		expect(await index.count("m", 4)).toBe(4);
	});

	it("keeps to the collections asked for", async () => {
		await index.add("m", rows);
		const hits = await index.search("m", unit([1, 0, 0, 0]), {
			collectionIds: [2],
		});
		expect(hits.map((hit) => hit.chunkId).sort()).toEqual([3, 4]);
	});

	it("keeps each model's vectors apart", async () => {
		await index.add("m", rows);
		await index.add("m-large", [
			{ chunkId: 1, collectionId: 1, documentId: 10, vector: unit([1, 0]) },
		]);
		expect((await index.tableNames()).sort()).toEqual([
			"vectors_m_4",
			"vectors_m_large_2",
		]);
		// "m" is a prefix of "m-large" and must not be taken for it.
		expect(await index.count("m")).toBe(4);
		expect(await index.count("m-large")).toBe(1);
		expect(await index.search("other", unit([1, 0, 0, 0]))).toEqual([]);
	});

	it("removes a document's vectors, and a collection's, from every table", async () => {
		await index.add("m", rows);
		await index.add("m-large", [
			{ chunkId: 4, collectionId: 2, documentId: 21, vector: unit([1, 0]) },
		]);
		await index.deleteDocuments([10]);
		expect(await index.count("m")).toBe(2);
		await index.deleteCollection(2);
		expect(await index.count("m")).toBe(0);
		expect(await index.count("m-large")).toBe(0);
	});

	it("refuses vectors of mixed dimensions in one batch", async () => {
		await expect(
			index.add("m", [
				rows[0],
				{ chunkId: 9, collectionId: 1, documentId: 1, vector: unit([1, 0]) },
			]),
		).rejects.toThrow(/4 and 2 dimensions/);
	});

	it("names the chunk whose vector is not a number", async () => {
		await expect(
			index.add("m", [
				rows[0],
				{
					chunkId: 77,
					collectionId: 1,
					documentId: 1,
					vector: new Float32Array([0, Number.NaN, 0, 0]),
				},
			]),
		).rejects.toThrow(/chunk 77/);
		expect(await index.count("m")).toBe(0);
	});

	it("survives being closed and opened again", async () => {
		await index.add("m", rows);
		index.close();
		index = await VectorIndex.open(
			loadLanceDb({ directory: directory as string }),
			join(root, "vectors"),
		);
		expect(await index.count("m")).toBe(4);
	});

	it("builds the approximate index only once a table is large enough", async () => {
		const many = Array.from({ length: 600 }, (_, i) => ({
			chunkId: i + 1,
			collectionId: 1,
			documentId: 1 + (i % 7),
			vector: unit(
				Array.from({ length: 16 }, (_, d) => Math.sin((i + 1) * (d + 1))),
			),
		}));
		await index.add("big", many);
		expect(await index.optimize("big", 16)).toBe(false);
		expect(await index.optimize("big", 16, { minRows: 500 })).toBe(true);
		const hits = await index.search("big", many[41].vector, { limit: 20 });
		expect(hits).toHaveLength(20);
		expect(hits.map((hit) => hit.chunkId)).toContain(42);
	});
});
