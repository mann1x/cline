import { describe, expect, it } from "vitest";
import {
	embedTexts,
	RetrievalEndpointError,
	rerankDocuments,
	resolveRetrievalBaseUrl,
} from "./embedding-client";

const endpoint = { baseUrl: "http://host:1", model: "embed" };

type Call = { url: string; body: any; headers: Record<string, string> };
function stub(
	answer: (call: Call, n: number) => { status?: number; json?: unknown },
) {
	const calls: Call[] = [];
	const fetchStub = (async (url: string, init: RequestInit) => {
		const call = {
			url,
			body: JSON.parse(String(init.body)),
			headers: init.headers as Record<string, string>,
		};
		calls.push(call);
		const { status = 200, json } = answer(call, calls.length);
		return new Response(JSON.stringify(json ?? {}), { status });
	}) as unknown as typeof fetch;
	return { calls, fetch: fetchStub };
}

/** A vector that names its text, so order can be checked. */
const vectorOf = (text: string) => [text.length, text.charCodeAt(0) || 0];
const embedAnswer = (call: Call, shuffle = false) => {
	const data = (call.body.input as string[]).map((text, index) => ({
		index,
		embedding: vectorOf(text),
	}));
	return { json: { model: "served", data: shuffle ? data.reverse() : data } };
};

describe("resolveRetrievalBaseUrl", () => {
	it("adds /v1 only when the URL has no path", () => {
		expect(resolveRetrievalBaseUrl("http://h:1")).toBe("http://h:1/v1");
		expect(resolveRetrievalBaseUrl("http://h:1/")).toBe("http://h:1/v1");
		expect(resolveRetrievalBaseUrl("http://h:1/v1/")).toBe("http://h:1/v1");
		expect(resolveRetrievalBaseUrl("https://h/api/v3")).toBe(
			"https://h/api/v3",
		);
		expect(() => resolveRetrievalBaseUrl(" ")).toThrow(RetrievalEndpointError);
		expect(() => resolveRetrievalBaseUrl("nonsense")).toThrow("Not a URL");
	});
});

describe("embedTexts", () => {
	it("keeps the order of the texts across batches, whatever order the server answers in", async () => {
		const texts = ["a", "bb", "ccc", "dddd", "eeeee"];
		const { calls, fetch } = stub((call) => embedAnswer(call, true));
		const result = await embedTexts(endpoint, texts, {
			batchSize: 2,
			concurrency: 0,
			fetch,
		});
		expect(calls).toHaveLength(3);
		expect(calls[0].url).toBe("http://host:1/v1/embeddings");
		expect(result.vectors.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
		expect(result.dimension).toBe(2);
		expect(result.model).toBe("served");
	});

	it("puts the prefix in front of every text and sends the key", async () => {
		const { calls, fetch } = stub((call) => embedAnswer(call));
		await embedTexts({ ...endpoint, apiKey: "k" }, ["x"], {
			prefix: "query: ",
			fetch,
		});
		expect(calls[0].body).toEqual({ model: "embed", input: ["query: x"] });
		expect(calls[0].headers.authorization).toBe("Bearer k");
	});

	it("asks again when the server is busy, and not when the request is wrong", async () => {
		const busy = stub((call, n) =>
			n < 3 ? { status: 503, json: { error: "loading" } } : embedAnswer(call),
		);
		const result = await embedTexts(endpoint, ["x"], {
			fetch: busy.fetch,
			retryDelayMs: 1,
		});
		expect(busy.calls).toHaveLength(3);
		expect(result.vectors).toHaveLength(1);

		const wrong = stub(() => ({
			status: 400,
			json: { error: "no such model" },
		}));
		await expect(
			embedTexts(endpoint, ["x"], { fetch: wrong.fetch, retryDelayMs: 1 }),
		).rejects.toThrow("answered 400");
		expect(wrong.calls).toHaveLength(1);
	});

	it("gives up on a server that stays busy, with its answer", async () => {
		const { calls, fetch } = stub(() => ({ status: 429 }));
		await expect(
			embedTexts(endpoint, ["x"], { fetch, retryDelayMs: 1, maxAttempts: 3 }),
		).rejects.toMatchObject({ status: 429 });
		expect(calls).toHaveLength(3);
	});

	it("refuses a short answer and vectors of differing length", async () => {
		const short = stub(() => ({
			json: { data: [{ index: 0, embedding: [1] }] },
		}));
		await expect(
			embedTexts(endpoint, ["a", "b"], { fetch: short.fetch }),
		).rejects.toThrow("1 embeddings for 2 texts");

		const ragged = stub(() => ({
			json: {
				data: [
					{ index: 0, embedding: [1, 2] },
					{ index: 1, embedding: [1] },
				],
			},
		}));
		await expect(
			embedTexts(endpoint, ["a", "b"], { fetch: ragged.fetch }),
		).rejects.toThrow("differing or zero length");
	});

	it("returns nothing for no texts without calling the server", async () => {
		const { calls, fetch } = stub(() => ({}));
		expect(await embedTexts(endpoint, [], { fetch })).toEqual({
			vectors: [],
			dimension: 0,
		});
		expect(calls).toHaveLength(0);
	});
});

describe("rerankDocuments", () => {
	it("returns one score per document in the order given, across batches", async () => {
		const documents = ["a", "bb", "ccc"];
		const { calls, fetch } = stub((call) => ({
			json: {
				// Sorted by relevance, as real servers answer.
				results: (call.body.documents as string[])
					.map((text, index) => ({ index, relevance_score: text.length }))
					.reverse(),
			},
		}));
		const scores = await rerankDocuments(endpoint, "q", documents, {
			batchSize: 2,
			fetch,
		});
		expect(scores).toEqual([1, 2, 3]);
		expect(calls[0].url).toBe("http://host:1/v1/rerank");
		expect(calls[0].body).toEqual({
			model: "embed",
			query: "q",
			documents: ["a", "bb"],
			top_n: 2,
		});
	});

	it("reads a bare array of index and score", async () => {
		const { fetch } = stub(() => ({
			json: [
				{ index: 1, score: 0.9 },
				{ index: 0, score: 0.1 },
			],
		}));
		expect(await rerankDocuments(endpoint, "q", ["a", "b"], { fetch })).toEqual(
			[0.1, 0.9],
		);
	});

	it("refuses an answer that does not score every document once", async () => {
		const { fetch } = stub(() => ({
			json: {
				results: [
					{ index: 0, relevance_score: 1 },
					{ index: 0, relevance_score: 2 },
				],
			},
		}));
		await expect(
			rerankDocuments(endpoint, "q", ["a", "b"], { fetch }),
		).rejects.toThrow("malformed score");
	});
});
