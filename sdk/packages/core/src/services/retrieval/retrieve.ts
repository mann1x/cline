/**
 * Retrieval over the Library: keywords, vectors, or both, then a reranker.
 *
 * The shape follows open-webui's, which works well in practice: take
 * candidates from the keyword index and from the vector index, merge the two
 * rankings by weighted reciprocal rank (the "BM25 weight" slides between
 * semantic and lexical), keep the top K, and let a reranking model score
 * those against the query and keep the best few above a threshold.
 *
 * Every stage past the keywords is optional. With no embedding model the
 * search is keywords alone; when an embedder or reranker cannot be reached,
 * the stages that did run still answer and the result says what was skipped.
 */

import {
	embedTexts,
	isInputTooLarge,
	type RetrievalEndpoint,
	rerankDocuments,
} from "./embedding-client";
import type { LibraryHit, LibraryStore } from "./library-store";
import type { VectorSearcher } from "./vector-index";

/** The constant of reciprocal rank fusion: how flat the top of a ranking counts. */
const RRF_K = 60;

/** How many times the documents are halved before reranking is given up. */
const RERANK_SHORTENINGS = 3;

export interface RetrieveOptions {
	store: LibraryStore;
	collectionIds?: readonly number[];
	/** Where vectors are searched. Left out, the search is keywords alone. */
	vectors?: VectorSearcher;
	embedding?: RetrievalEndpoint & {
		/** Put in front of the query, for embedders trained with an instruction. */
		queryPrefix?: string;
	};
	reranker?: RetrievalEndpoint & { batchSize?: number };
	/**
	 * Use the keyword index together with the vectors. Off, a search with
	 * vectors available is semantic alone. Default on.
	 */
	hybrid?: boolean;
	/** 0 is semantic alone, 1 lexical alone. Default 0.5. */
	bm25Weight?: number;
	/** Also match file names, titles and section headers by keyword. Default on. */
	enrich?: boolean;
	/** Chunks kept after merging. Default 5. */
	topK?: number;
	/** Chunks kept after reranking. Default 3. */
	topKReranker?: number;
	/**
	 * Chunks scoring below this are dropped: the reranker's score (0 to 1)
	 * when there is one, the cosine similarity of a semantic-only search
	 * otherwise. A merged ranking has no score to hold against it. Default 0.
	 */
	relevanceThreshold?: number;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

export interface RetrievedHit extends LibraryHit {
	/** Position in the keyword ranking, from 1, when it was found there. */
	keywordRank?: number;
	/** Position in the vector ranking, from 1, when it was found there. */
	vectorRank?: number;
	similarity?: number;
	/** The reranker's score, 0 to 1. */
	rerankScore?: number;
}

export interface RetrieveResult {
	hits: RetrievedHit[];
	/** Which rankings the hits came from. */
	mode: "keyword" | "vector" | "hybrid";
	reranked: boolean;
	/** Stages that were asked for and did not run, and why. */
	notes: string[];
}

/**
 * Rerankers answer on two scales: a probability, or the raw logit behind it
 * (llama.cpp). Anything outside 0..1 marks the second, and is put through
 * the logistic function so that one threshold means the same on both.
 */
export function normalizeRerankScores(scores: readonly number[]): number[] {
	if (scores.every((score) => score >= 0 && score <= 1)) {
		return [...scores];
	}
	return scores.map((score) => 1 / (1 + Math.exp(-score)));
}

/**
 * Merge rankings by weighted reciprocal rank. Each ranking is a list of ids,
 * best first; the result is the ids with their merged score, best first.
 */
export function fuseRankings(
	rankings: readonly { ids: readonly number[]; weight: number }[],
): { id: number; score: number }[] {
	const scores = new Map<number, number>();
	for (const { ids, weight } of rankings) {
		if (weight <= 0) continue;
		ids.forEach((id, index) => {
			scores.set(id, (scores.get(id) ?? 0) + weight / (RRF_K + index + 1));
		});
	}
	return [...scores.entries()]
		.map(([id, score]) => ({ id, score }))
		.sort((a, b) => b.score - a.score || a.id - b.id);
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function retrieve(
	query: string,
	options: RetrieveOptions,
): Promise<RetrieveResult> {
	const notes: string[] = [];
	const topK = Math.max(1, options.topK ?? 5);
	const threshold = options.relevanceThreshold ?? 0;
	const weight = Math.min(1, Math.max(0, options.bm25Weight ?? 0.5));
	// Each ranking is asked for more than is kept: a chunk that is fifth in
	// both rankings beats one that is first in a single one.
	const candidates = Math.max(topK * 4, 20);
	const shared = { signal: options.signal, fetch: options.fetch };

	let vectorHits: { chunkId: number; similarity: number }[] | undefined;
	if (options.vectors && options.embedding && weight < 1) {
		try {
			const embedded = await embedTexts(options.embedding, [query], {
				...shared,
				prefix: options.embedding.queryPrefix,
			});
			vectorHits = await options.vectors.search(
				options.embedding.model,
				embedded.vectors[0],
				{ collectionIds: options.collectionIds, limit: candidates },
			);
			if (vectorHits.length === 0) {
				notes.push(
					`Nothing in these collections is embedded with ${options.embedding.model} yet; searched by keyword.`,
				);
				vectorHits = undefined;
			}
		} catch (error) {
			notes.push(
				`Semantic search did not run (${describe(error)}); searched by keyword.`,
			);
		}
	}

	const useKeywords = !vectorHits || ((options.hybrid ?? true) && weight > 0);
	const keywordHits = useKeywords
		? options.store.searchKeywords(query, {
				collectionIds: options.collectionIds,
				limit: candidates,
				contextWeight: (options.enrich ?? true) ? undefined : 0,
			})
		: [];

	const mode: RetrieveResult["mode"] = !vectorHits
		? "keyword"
		: useKeywords
			? "hybrid"
			: "vector";

	const keywordRank = new Map(
		keywordHits.map((hit, index) => [hit.chunkId, index + 1]),
	);
	const vectorRank = new Map(
		(vectorHits ?? []).map((hit, index) => [hit.chunkId, index + 1]),
	);
	const similarity = new Map(
		(vectorHits ?? []).map((hit) => [hit.chunkId, hit.similarity]),
	);

	let ranked: { id: number; score: number }[];
	if (mode === "keyword") {
		ranked = keywordHits.map((hit) => ({ id: hit.chunkId, score: hit.score }));
	} else if (mode === "vector") {
		ranked = (vectorHits ?? [])
			.filter((hit) => hit.similarity >= threshold)
			.map((hit) => ({ id: hit.chunkId, score: hit.similarity }));
	} else {
		ranked = fuseRankings([
			{ ids: keywordHits.map((hit) => hit.chunkId), weight },
			{ ids: (vectorHits ?? []).map((hit) => hit.chunkId), weight: 1 - weight },
		]);
	}
	ranked = ranked.slice(0, topK);

	const scoreOf = new Map(ranked.map((entry) => [entry.id, entry.score]));
	let hits: RetrievedHit[] = options.store
		.getChunks(ranked.map((entry) => entry.id))
		.map((hit) => ({
			...hit,
			score: scoreOf.get(hit.chunkId) ?? 0,
			keywordRank: keywordRank.get(hit.chunkId),
			vectorRank: vectorRank.get(hit.chunkId),
			similarity: similarity.get(hit.chunkId),
		}));

	let reranked = false;
	if (options.reranker && hits.length > 0) {
		const documents = hits.map((hit) =>
			hit.headings.length > 0
				? `${hit.headings.join(" > ")}\n${hit.text}`
				: hit.text,
		);
		// A reranker reads the query and a document together, in a window that
		// is often small (512 tokens is llama.cpp's default). One chunk too
		// long for it fails the whole request, so the documents are cut shorter
		// and asked again: the head of a chunk still says what it is about.
		let limit = Math.max(...documents.map((text) => text.length));
		for (let attempt = 0; ; attempt++) {
			try {
				const scores = normalizeRerankScores(
					await rerankDocuments(
						options.reranker,
						query,
						documents.map((text) => text.slice(0, limit)),
						{ ...shared, batchSize: options.reranker.batchSize },
					),
				);
				hits = hits
					.map((hit, index) => ({
						...hit,
						rerankScore: scores[index],
						score: scores[index],
					}))
					.filter((hit) => hit.score >= threshold)
					.sort((a, b) => b.score - a.score)
					.slice(0, Math.max(1, options.topKReranker ?? 3));
				reranked = true;
				if (attempt > 0) {
					notes.push(
						`The reranker could not take the longest chunks whole; it read the first ${limit} characters of each.`,
					);
				}
				break;
			} catch (error) {
				if (
					attempt < RERANK_SHORTENINGS &&
					isInputTooLarge(error) &&
					limit > 200
				) {
					limit = Math.floor(limit / 2);
					continue;
				}
				notes.push(
					`Reranking did not run (${describe(error)}); the order is the search's own.`,
				);
				break;
			}
		}
	}

	return { hits, mode, reranked, notes };
}
