/**
 * The Library's vectors, in LanceDB.
 *
 * SQLite holds the text and answers keyword queries; this holds one vector
 * per chunk and answers "what is close to this". The two are joined on the
 * chunk id. Vectors from different embedding models are not comparable, so
 * each model and dimension has a table of its own: changing the model leaves
 * the old vectors where they are and starts a new table.
 */

import type { LanceDbRuntime } from "./lancedb-runtime";

export interface VectorRow {
	chunkId: number;
	collectionId: number;
	documentId: number;
	vector: Float32Array;
}

export interface VectorHit {
	chunkId: number;
	/** Cosine similarity, 1 for the same direction. */
	similarity: number;
}

export interface VectorSearchOptions {
	collectionIds?: readonly number[];
	/** Default 10. */
	limit?: number;
}

/** What hybrid retrieval needs from a vector index. */
export interface VectorSearcher {
	search(
		model: string,
		vector: Float32Array,
		options?: VectorSearchOptions,
	): Promise<VectorHit[]>;
}

/**
 * Below this many rows a table is scanned: exact, and fast enough. Above it
 * an approximate index is built, which is what keeps a library of gigabytes
 * answering in milliseconds.
 */
export const VECTOR_INDEX_MIN_ROWS = 50_000;

export function vectorTableName(model: string, dimension: number): string {
	const slug = model
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return `vectors_${slug || "model"}_${dimension}`;
}

function integers(values: readonly number[]): string {
	return values.map((value) => Math.trunc(Number(value))).join(", ");
}

export class VectorIndex implements VectorSearcher {
	// biome-ignore lint/suspicious/noExplicitAny: LanceDB is loaded at run time
	private readonly tables = new Map<string, any>();

	private constructor(
		private readonly runtime: LanceDbRuntime,
		// biome-ignore lint/suspicious/noExplicitAny: as above
		private readonly db: any,
	) {}

	static async open(
		runtime: LanceDbRuntime,
		directory: string,
	): Promise<VectorIndex> {
		return new VectorIndex(runtime, await runtime.lancedb.connect(directory));
	}

	/** The tables there are, as `{model slug, dimension}` names. */
	async tableNames(): Promise<string[]> {
		return (await this.db.tableNames()).filter((name: string) =>
			name.startsWith("vectors_"),
		);
	}

	private async table(model: string, dimension?: number) {
		// A search knows the model but not always the dimension.
		const names: string[] = await this.tableNames();
		const prefix = vectorTableName(model, 0).slice(0, -1);
		const name =
			dimension !== undefined
				? vectorTableName(model, dimension)
				: names.find(
						(candidate) =>
							candidate.startsWith(prefix) &&
							/^\d+$/.test(candidate.slice(prefix.length)),
					);
		if (!name) return undefined;
		const cached = this.tables.get(name);
		if (cached) return cached;
		if (!names.includes(name)) return undefined;
		const table = await this.db.openTable(name);
		this.tables.set(name, table);
		return table;
	}

	private async createTable(model: string, dimension: number) {
		const { arrow } = this.runtime;
		const schema = new arrow.Schema([
			new arrow.Field("chunk_id", new arrow.Int64(), false),
			new arrow.Field("collection_id", new arrow.Int32(), false),
			new arrow.Field("document_id", new arrow.Int32(), false),
			new arrow.Field(
				"vector",
				new arrow.FixedSizeList(
					dimension,
					new arrow.Field("item", new arrow.Float32(), true),
				),
				false,
			),
		]);
		const name = vectorTableName(model, dimension);
		const table = await this.db.createEmptyTable(name, schema, {
			existOk: true,
		});
		this.tables.set(name, table);
		return table;
	}

	/**
	 * Add vectors. The caller removes a document's old vectors first
	 * (`deleteDocuments`): chunk ids are new each time a document is replaced.
	 */
	async add(model: string, rows: readonly VectorRow[]): Promise<void> {
		if (rows.length === 0) return;
		const dimension = rows[0].vector.length;
		for (const row of rows) {
			if (row.vector.length !== dimension) {
				throw new Error(
					`Vectors of ${dimension} and ${row.vector.length} dimensions in one batch.`,
				);
			}
			// LanceDB refuses the whole batch on one NaN; name the chunk instead.
			if (!row.vector.every(Number.isFinite)) {
				throw new Error(
					`The vector of chunk ${row.chunkId} holds a value that is not a number.`,
				);
			}
		}
		const table =
			(await this.table(model, dimension)) ??
			(await this.createTable(model, dimension));
		await table.add(
			rows.map((row) => ({
				chunk_id: row.chunkId,
				collection_id: row.collectionId,
				document_id: row.documentId,
				vector: Array.from(row.vector),
			})),
		);
	}

	async search(
		model: string,
		vector: Float32Array,
		options: VectorSearchOptions = {},
	): Promise<VectorHit[]> {
		const table = await this.table(model, vector.length);
		if (!table) return [];
		let query = table.vectorSearch(vector).distanceType("cosine");
		if (options.collectionIds && options.collectionIds.length > 0) {
			query = query.where(
				`collection_id IN (${integers(options.collectionIds)})`,
			);
		}
		const rows = await query.limit(Math.max(1, options.limit ?? 10)).toArray();
		return rows.map((row: { chunk_id: bigint; _distance: number }) => ({
			chunkId: Number(row.chunk_id),
			similarity: 1 - row._distance,
		}));
	}

	async count(model: string, dimension?: number): Promise<number> {
		const table = await this.table(model, dimension);
		return table ? await table.countRows() : 0;
	}

	/**
	 * Remove these documents' vectors from one model's table only. For
	 * embedding a document again: its vectors for other models are not this
	 * run's to touch, and deleting them empties a set the store still counts.
	 */
	async deleteDocumentsIn(
		model: string,
		dimension: number,
		documentIds: readonly number[],
	): Promise<void> {
		if (documentIds.length === 0) return;
		const table = await this.table(model, dimension);
		await table?.delete(`document_id IN (${integers(documentIds)})`);
	}

	/** Every set of vectors there is: its table, the size of its vectors, and how many. */
	async sets(): Promise<{ table: string; dimension: number; rows: number }[]> {
		const sets: { table: string; dimension: number; rows: number }[] = [];
		for (const name of await this.tableNames()) {
			const table = this.tables.get(name) ?? (await this.db.openTable(name));
			this.tables.set(name, table);
			sets.push({
				table: name,
				dimension: Number(name.slice(name.lastIndexOf("_") + 1)) || 0,
				rows: await table.countRows(),
			});
		}
		return sets;
	}

	/** Delete a whole set of vectors. */
	async dropSet(table: string): Promise<boolean> {
		if (!(await this.tableNames()).includes(table)) return false;
		this.tables.get(table)?.close?.();
		this.tables.delete(table);
		await this.db.dropTable(table);
		return true;
	}

	/** Remove the vectors of these documents, in every table. */
	async deleteDocuments(documentIds: readonly number[]): Promise<void> {
		if (documentIds.length === 0) return;
		await this.deleteWhere(`document_id IN (${integers(documentIds)})`);
	}

	async deleteCollection(collectionId: number): Promise<void> {
		await this.deleteWhere(`collection_id = ${integers([collectionId])}`);
	}

	private async deleteWhere(predicate: string): Promise<void> {
		for (const name of await this.tableNames()) {
			const table = this.tables.get(name) ?? (await this.db.openTable(name));
			this.tables.set(name, table);
			await table.delete(predicate);
		}
	}

	/**
	 * Housekeeping after a large ingest: compact what the adds wrote, and build
	 * the approximate index once the table is large enough to need one.
	 * Returns whether the table has an index on its vectors afterwards.
	 */
	async optimize(
		model: string,
		dimension: number,
		options: { minRows?: number } = {},
	): Promise<boolean> {
		const table = await this.table(model, dimension);
		if (!table) return false;
		const hasIndex = async () =>
			(await table.listIndices()).some((index: { columns: string[] }) =>
				index.columns.includes("vector"),
			);
		const rows: number = await table.countRows();
		if (
			!(await hasIndex()) &&
			rows >= (options.minRows ?? VECTOR_INDEX_MIN_ROWS)
		) {
			const { lancedb } = this.runtime;
			await table.createIndex("vector", {
				config: lancedb.Index.ivfPq({
					numPartitions: Math.max(1, Math.round(Math.sqrt(rows))),
					distanceType: "cosine",
				}),
			});
		}
		await table.optimize();
		return hasIndex();
	}

	close(): void {
		for (const table of this.tables.values()) {
			table.close?.();
		}
		this.tables.clear();
		this.db.close?.();
	}
}
