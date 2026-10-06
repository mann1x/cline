/**
 * Embedding and reranking over HTTP, for the Library and the memory store.
 *
 * One wire format each, the ones every server in use speaks:
 *
 * - embeddings: OpenAI's `POST <base>/embeddings` with `{model, input: []}`,
 *   answered by `{data: [{index, embedding}]}`. Ollama, llama.cpp, opencoti,
 *   LM Studio, vLLM, TEI and OpenAI itself all serve it.
 * - reranking: `POST <base>/rerank` with `{model, query, documents, top_n}`,
 *   answered by `{results: [{index, relevance_score}]}` (Jina's and Cohere's
 *   shape; llama.cpp with `--reranking`, vLLM and Infinity serve it). TEI's
 *   bare array of `{index, score}` is read too.
 *
 * A server that is busy is not a failure: 429 and 5xx are retried with a
 * growing wait before the error is passed on.
 */

export interface RetrievalEndpoint {
	/** With or without a trailing `/v1`; `/v1` is added when the path has none. */
	baseUrl: string;
	model: string;
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface EmbedOptions {
	/** Texts per request. Default 64. */
	batchSize?: number;
	/** Requests in flight at once. 0 means no limit of ours. Default 4. */
	concurrency?: number;
	/**
	 * Text put in front of every input. Instruction-tuned embedders want one
	 * for queries and usually none for documents.
	 */
	prefix?: string;
	signal?: AbortSignal;
	fetch?: typeof fetch;
	/** Attempts per request before a busy or failing server is reported. Default 4. */
	maxAttempts?: number;
	/** First wait between attempts, doubled each time. Default 500. */
	retryDelayMs?: number;
}

export interface EmbedResult {
	vectors: Float32Array[];
	dimension: number;
	/** The model as the server named it, when it did. */
	model?: string;
	promptTokens?: number;
}

export interface RerankOptions {
	/** Documents per request. Default 32. */
	batchSize?: number;
	signal?: AbortSignal;
	fetch?: typeof fetch;
	maxAttempts?: number;
	retryDelayMs?: number;
}

export class RetrievalEndpointError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly body?: string,
	) {
		super(message);
		this.name = "RetrievalEndpointError";
	}
}

/** `http://host:1234` and `http://host:1234/v1/` both become `http://host:1234/v1`. */
export function resolveRetrievalBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (!trimmed) {
		throw new RetrievalEndpointError("No endpoint URL is set.");
	}
	let path: string;
	try {
		path = new URL(trimmed).pathname.replace(/\/+$/, "");
	} catch {
		throw new RetrievalEndpointError(`Not a URL: ${baseUrl}`);
	}
	return path === "" ? `${trimmed}/v1` : trimmed;
}

function requestHeaders(endpoint: RetrievalEndpoint): Record<string, string> {
	return {
		"content-type": "application/json",
		...(endpoint.apiKey ? { authorization: `Bearer ${endpoint.apiKey}` } : {}),
		...endpoint.headers,
	};
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function postJson(
	url: string,
	endpoint: RetrievalEndpoint,
	body: unknown,
	options: {
		signal?: AbortSignal;
		fetch?: typeof fetch;
		maxAttempts?: number;
		retryDelayMs?: number;
	},
): Promise<unknown> {
	const send = options.fetch ?? fetch;
	const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
	let delay = options.retryDelayMs ?? 500;
	for (let attempt = 1; ; attempt++) {
		let failure: RetrievalEndpointError;
		try {
			const response = await send(url, {
				method: "POST",
				headers: requestHeaders(endpoint),
				body: JSON.stringify(body),
				signal: options.signal,
			});
			if (response.ok) {
				return await response.json();
			}
			const text = await response.text().catch(() => "");
			failure = new RetrievalEndpointError(
				`${url} answered ${response.status}${text ? `: ${text.slice(0, 300)}` : ""}`,
				response.status,
				text,
			);
			// The request itself is wrong: asking again changes nothing.
			if (response.status !== 429 && response.status < 500) {
				throw failure;
			}
		} catch (error) {
			if (options.signal?.aborted) throw error;
			if (error instanceof RetrievalEndpointError && error.status) {
				if (error.status !== 429 && error.status < 500) throw error;
				failure = error;
			} else {
				failure = new RetrievalEndpointError(
					`${url} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (attempt >= maxAttempts) {
			throw failure;
		}
		await wait(delay, options.signal);
		delay *= 2;
	}
}

async function inBatches<T>(
	count: number,
	concurrency: number,
	run: (index: number) => Promise<T>,
): Promise<T[]> {
	const results = new Array<T>(count);
	let next = 0;
	const workers = Array.from(
		{ length: concurrency <= 0 ? count : Math.min(concurrency, count) },
		async () => {
			while (next < count) {
				const index = next++;
				results[index] = await run(index);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

/**
 * Embed texts, in the order given. Every vector has the same length, and
 * there is exactly one per text, or this throws: a short or ragged answer
 * written to an index is worse than no answer.
 */
export async function embedTexts(
	endpoint: RetrievalEndpoint,
	texts: readonly string[],
	options: EmbedOptions = {},
): Promise<EmbedResult> {
	if (texts.length === 0) {
		return { vectors: [], dimension: 0 };
	}
	const url = `${resolveRetrievalBaseUrl(endpoint.baseUrl)}/embeddings`;
	const batchSize = Math.max(1, options.batchSize ?? 64);
	const prefix = options.prefix ?? "";
	const batches: string[][] = [];
	for (let start = 0; start < texts.length; start += batchSize) {
		batches.push(
			texts.slice(start, start + batchSize).map((text) => prefix + text),
		);
	}

	let model: string | undefined;
	let promptTokens = 0;
	let sawTokens = false;
	const perBatch = await inBatches(
		batches.length,
		options.concurrency ?? 4,
		async (index) => {
			const input = batches[index];
			const answer = (await postJson(
				url,
				endpoint,
				{ model: endpoint.model, input },
				options,
			)) as {
				model?: string;
				data?: { index?: number; embedding?: number[] }[];
				usage?: { prompt_tokens?: number };
			};
			const data = answer?.data;
			if (!Array.isArray(data) || data.length !== input.length) {
				throw new RetrievalEndpointError(
					`${url} returned ${Array.isArray(data) ? data.length : "no"} embeddings for ${input.length} texts.`,
				);
			}
			model ??= answer.model;
			if (typeof answer.usage?.prompt_tokens === "number") {
				promptTokens += answer.usage.prompt_tokens;
				sawTokens = true;
			}
			const ordered = new Array<Float32Array>(input.length);
			data.forEach((item, position) => {
				const at = typeof item.index === "number" ? item.index : position;
				if (!Array.isArray(item.embedding) || at < 0 || at >= input.length) {
					throw new RetrievalEndpointError(
						`${url} returned a malformed embedding.`,
					);
				}
				ordered[at] = Float32Array.from(item.embedding);
			});
			return ordered;
		},
	);

	const vectors = perBatch.flat();
	const dimension = vectors[0]?.length ?? 0;
	if (
		dimension === 0 ||
		vectors.some((vector) => !vector || vector.length !== dimension)
	) {
		throw new RetrievalEndpointError(
			`${url} returned embeddings of differing or zero length.`,
		);
	}
	return {
		vectors,
		dimension,
		model,
		promptTokens: sawTokens ? promptTokens : undefined,
	};
}

/**
 * Score each document against the query. One score per document, in the
 * order the documents were given; higher is more relevant.
 */
export async function rerankDocuments(
	endpoint: RetrievalEndpoint,
	query: string,
	documents: readonly string[],
	options: RerankOptions = {},
): Promise<number[]> {
	if (documents.length === 0) {
		return [];
	}
	const url = `${resolveRetrievalBaseUrl(endpoint.baseUrl)}/rerank`;
	const batchSize = Math.max(1, options.batchSize ?? 32);
	const scores = new Array<number>(documents.length);
	for (let start = 0; start < documents.length; start += batchSize) {
		const batch = documents.slice(start, start + batchSize);
		const answer = (await postJson(
			url,
			endpoint,
			{
				model: endpoint.model,
				query,
				documents: batch,
				top_n: batch.length,
			},
			options,
		)) as
			| { results?: unknown; data?: unknown }
			| { index?: number; score?: number }[];
		const rows = Array.isArray(answer)
			? answer
			: Array.isArray(answer?.results)
				? answer.results
				: Array.isArray(answer?.data)
					? answer.data
					: undefined;
		if (!rows || rows.length !== batch.length) {
			throw new RetrievalEndpointError(
				`${url} returned ${rows ? rows.length : "no"} scores for ${batch.length} documents.`,
			);
		}
		const seen = new Set<number>();
		for (const row of rows as {
			index?: number;
			relevance_score?: number;
			score?: number;
		}[]) {
			const score = row.relevance_score ?? row.score;
			if (
				typeof row.index !== "number" ||
				typeof score !== "number" ||
				row.index < 0 ||
				row.index >= batch.length ||
				seen.has(row.index)
			) {
				throw new RetrievalEndpointError(`${url} returned a malformed score.`);
			}
			seen.add(row.index);
			scores[start + row.index] = score;
		}
	}
	return scores;
}
