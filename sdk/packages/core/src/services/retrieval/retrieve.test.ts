import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkText } from "./chunker";
import { LibraryStore } from "./library-store";
import { fuseRankings, normalizeRerankScores, retrieve } from "./retrieve";
import type { VectorHit, VectorSearcher } from "./vector-index";

const embedding = { baseUrl: "http://embed.test", model: "embed" };
const reranker = { baseUrl: "http://rerank.test", model: "rerank" };

describe("fuseRankings", () => {
	it("puts first what both rankings agree on", () => {
		const fused = fuseRankings([
			{ ids: [1, 2, 3], weight: 0.5 },
			{ ids: [4, 2, 5], weight: 0.5 },
		]);
		expect(fused[0].id).toBe(2);
		expect(fused.map((entry) => entry.id).sort()).toEqual([1, 2, 3, 4, 5]);
	});

	it("leans to the heavier ranking", () => {
		const rankings = (weight: number) => [
			{ ids: [1, 2], weight },
			{ ids: [2, 1], weight: 1 - weight },
		];
		expect(fuseRankings(rankings(0.8))[0].id).toBe(1);
		expect(fuseRankings(rankings(0.2))[0].id).toBe(2);
	});

	it("ignores a ranking of no weight", () => {
		expect(
			fuseRankings([
				{ ids: [1], weight: 0 },
				{ ids: [2], weight: 1 },
			]).map((entry) => entry.id),
		).toEqual([2]);
	});
});

describe("normalizeRerankScores", () => {
	it("leaves probabilities as they are", () => {
		expect(normalizeRerankScores([0.9, 0.1, 0])).toEqual([0.9, 0.1, 0]);
	});

	it("turns logits into probabilities, keeping the order", () => {
		const scores = normalizeRerankScores([9.67, 0.139, -5.57]);
		expect(scores[0]).toBeGreaterThan(0.99);
		expect(scores[1]).toBeCloseTo(0.5347, 3);
		expect(scores[2]).toBeLessThan(0.01);
	});
});

describe("retrieve", () => {
	let root: string;
	let store: LibraryStore;
	let ids: Record<string, number>;

	const texts = {
		pump: "The coolant pump is replaced by removing four bolts from the housing.",
		heat: "When the engine runs hot, look at the thermostat and the radiator fan first.",
		oil: "Change the oil every ten thousand kilometres, and the filter with it.",
		tyres: "Tyre pressure is checked cold, including the spare.",
	};

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "retrieve-"));
		store = new LibraryStore(join(root, "library.db"));
		const collection = store.ensureCollection("manuals");
		ids = {};
		for (const [name, text] of Object.entries(texts)) {
			const added = store.addDocument(
				collection.id,
				{ source: `${name}.md`, contentHash: text },
				chunkText(text, { size: 500, overlap: 0 }),
			);
			ids[name] = added.chunkIds[0];
		}
	});
	afterEach(async () => {
		store.close();
		await rm(root, { recursive: true, force: true });
	});

	/** Embedding and reranking endpoints answered from here. */
	function endpoints(
		options: {
			rerank?: (documents: string[]) => number[];
			embedStatus?: number;
			rerankStatus?: number;
		} = {},
	) {
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		const send = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body ?? "{}"));
			calls.push({ url, body });
			if (url.endsWith("/embeddings")) {
				if (options.embedStatus) {
					return new Response("down", { status: options.embedStatus });
				}
				return Response.json({
					data: (body.input as string[]).map((_, index) => ({
						index,
						embedding: [1, 0, 0],
					})),
				});
			}
			if (options.rerankStatus) {
				return new Response("down", { status: options.rerankStatus });
			}
			const scores = options.rerank?.(body.documents as string[]) ?? [];
			return Response.json({
				results: scores.map((relevance_score, index) => ({
					index,
					relevance_score,
				})),
			});
		}) as typeof fetch;
		return { send, calls };
	}

	const vectors = (
		hits: VectorHit[],
	): VectorSearcher & { asked: unknown[] } => {
		const asked: unknown[] = [];
		return {
			asked,
			search: async (model, _vector, options) => {
				asked.push({ model, ...options });
				return hits;
			},
		};
	};

	it("searches by keyword alone when there is no embedding model", async () => {
		const result = await retrieve("coolant pump bolts", { store });
		expect(result.mode).toBe("keyword");
		expect(result.reranked).toBe(false);
		expect(result.notes).toEqual([]);
		expect(result.hits[0].chunkId).toBe(ids.pump);
		expect(result.hits[0].keywordRank).toBe(1);
		expect(result.hits[0].source).toBe("pump.md");
	});

	it("finds by meaning what the keywords miss, and merges the two", async () => {
		// "overheating" is in no document; the vectors know which one it means.
		const { send, calls } = endpoints();
		const index = vectors([
			{ chunkId: ids.heat, similarity: 0.8 },
			{ chunkId: ids.pump, similarity: 0.6 },
		]);
		const result = await retrieve("overheating coolant", {
			store,
			vectors: index,
			embedding: { ...embedding, queryPrefix: "query: " },
			fetch: send,
		});
		expect(result.mode).toBe("hybrid");
		// The pump is in both rankings; the thermostat only in the vectors'.
		expect(result.hits.map((hit) => hit.chunkId)).toEqual([ids.pump, ids.heat]);
		expect(result.hits[0]).toMatchObject({ keywordRank: 1, vectorRank: 2 });
		expect(result.hits[1].keywordRank).toBeUndefined();
		expect(result.hits[1].similarity).toBe(0.8);
		expect(calls[0].body.input).toEqual(["query: overheating coolant"]);
		expect(index.asked[0]).toMatchObject({ model: "embed", limit: 20 });
	});

	it("slides between the two with the BM25 weight", async () => {
		const { send } = endpoints();
		const index = vectors([{ chunkId: ids.heat, similarity: 0.8 }]);
		const run = (bm25Weight: number) =>
			retrieve("coolant pump", {
				store,
				vectors: index,
				embedding,
				fetch: send,
				bm25Weight,
			});
		expect((await run(0.9)).hits[0].chunkId).toBe(ids.pump);
		expect((await run(0.1)).hits[0].chunkId).toBe(ids.heat);
		const semantic = await run(0);
		expect(semantic.mode).toBe("vector");
		expect(semantic.hits.map((hit) => hit.chunkId)).toEqual([ids.heat]);
		// All the way to lexical, the embedder is not even asked.
		const lexical = endpoints();
		const result = await retrieve("coolant pump", {
			store,
			vectors: index,
			embedding,
			fetch: lexical.send,
			bm25Weight: 1,
		});
		expect(result.mode).toBe("keyword");
		expect(lexical.calls).toHaveLength(0);
	});

	it("is semantic alone with hybrid search off, and holds the threshold against similarity", async () => {
		const { send } = endpoints();
		const result = await retrieve("coolant pump", {
			store,
			vectors: vectors([
				{ chunkId: ids.heat, similarity: 0.8 },
				{ chunkId: ids.oil, similarity: 0.3 },
			]),
			embedding,
			fetch: send,
			hybrid: false,
			relevanceThreshold: 0.5,
		});
		expect(result.mode).toBe("vector");
		expect(result.hits.map((hit) => hit.chunkId)).toEqual([ids.heat]);
	});

	it("lets the reranker reorder, drop below the threshold, and keep the top few", async () => {
		const { send, calls } = endpoints({
			// Logits, as llama.cpp answers: the thermostat is the match.
			rerank: (documents) =>
				documents.map((text) =>
					text.includes("thermostat") ? 6 : text.includes("pump") ? 1 : -6,
				),
		});
		const result = await retrieve("engine oil coolant tyre", {
			store,
			reranker,
			fetch: send,
			topKReranker: 2,
			relevanceThreshold: 0.5,
		});
		expect(result.reranked).toBe(true);
		expect(result.hits.map((hit) => hit.chunkId)).toEqual([ids.heat, ids.pump]);
		expect(result.hits[0].rerankScore).toBeGreaterThan(0.99);
		expect(result.hits[1].rerankScore).toBeCloseTo(0.731, 3);
		const rerankCall = calls.find((call) => call.url.endsWith("/rerank"));
		expect(rerankCall?.body.query).toBe("engine oil coolant tyre");
		expect((rerankCall?.body.documents as string[]).length).toBe(4);
	});

	it("keeps no more than top K before reranking", async () => {
		const { send, calls } = endpoints({
			rerank: (documents) => documents.map(() => 0.5),
		});
		await retrieve("engine oil coolant tyre", {
			store,
			reranker,
			fetch: send,
			topK: 2,
		});
		expect((calls[0].body.documents as string[]).length).toBe(2);
	});

	it("answers by keyword and says so when the embedder is down", async () => {
		const { send } = endpoints({ embedStatus: 400 });
		const result = await retrieve("coolant pump", {
			store,
			vectors: vectors([{ chunkId: ids.heat, similarity: 0.8 }]),
			embedding,
			fetch: send,
		});
		expect(result.mode).toBe("keyword");
		expect(result.hits[0].chunkId).toBe(ids.pump);
		expect(result.notes).toHaveLength(1);
		expect(result.notes[0]).toMatch(/^Semantic search did not run \(.*400/);
	});

	it("says so when nothing is embedded with this model yet", async () => {
		const { send } = endpoints();
		const result = await retrieve("coolant pump", {
			store,
			vectors: vectors([]),
			embedding,
			fetch: send,
		});
		expect(result.mode).toBe("keyword");
		expect(result.notes[0]).toMatch(/embedded with embed yet/);
	});

	it("keeps the search's order and says so when the reranker is down", async () => {
		const { send } = endpoints({ rerankStatus: 400 });
		const result = await retrieve("coolant pump", {
			store,
			reranker,
			fetch: send,
		});
		expect(result.reranked).toBe(false);
		expect(result.hits[0].chunkId).toBe(ids.pump);
		expect(result.notes[0]).toMatch(/^Reranking did not run/);
	});

	it("shortens the documents when one is too long for the reranker, and says so", async () => {
		const collection = store.ensureCollection("manuals");
		const long = `Gearbox oil. ${"The gearbox takes two litres of oil. ".repeat(60)}`;
		store.addDocument(
			collection.id,
			{ source: "gearbox.md", contentHash: "g" },
			chunkText(long, { size: 5000, overlap: 0 }),
		);
		const lengths: number[] = [];
		const send = (async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			const documents = JSON.parse(String(init?.body)).documents as string[];
			const longest = Math.max(...documents.map((text) => text.length));
			lengths.push(longest);
			if (longest > 600) {
				return new Response(
					'{"error":{"message":"input (543 tokens) is too large to process"}}',
					{ status: 400 },
				);
			}
			return Response.json({
				results: documents.map((text, index) => ({
					index,
					relevance_score: text.startsWith("Gearbox") ? 0.9 : 0.1,
				})),
			});
		}) as typeof fetch;
		const result = await retrieve("gearbox oil", {
			store,
			reranker,
			fetch: send,
		});
		expect(result.reranked).toBe(true);
		expect(result.hits[0].source).toBe("gearbox.md");
		// The hit keeps its whole text; only what the reranker read was cut.
		expect(result.hits[0].text.length).toBe(long.trim().length);
		expect(lengths).toEqual([long.trim().length, 1116, 558]);
		expect(result.notes).toEqual([
			"The reranker could not take the longest chunks whole; it read the first 558 characters of each.",
		]);
	});

	it("returns nothing for a query that matches nothing", async () => {
		const { send, calls } = endpoints();
		const result = await retrieve("zeppelin", { store, reranker, fetch: send });
		expect(result.hits).toEqual([]);
		expect(calls).toHaveLength(0);
	});
});
