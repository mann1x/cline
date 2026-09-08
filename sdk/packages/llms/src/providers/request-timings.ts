import type { RequestTimings } from "@cline/shared";

/**
 * The engine's own timing report, read out of provider metadata.
 *
 * Two local engines publish what they spent on a request, and they are the two
 * where the answer matters most: a hosted model's latency is somebody else's
 * problem, but a local one that suddenly takes four times as long is the user's
 * to diagnose, and "it was slow" is not a diagnosis. The split between prompt
 * and generation is what separates a cache that stopped hitting from a model
 * that is simply thinking more -- see `iq4_nl is clock-bound` for how easily
 * those two are confused when only the total is visible.
 *
 * Neither engine is asked for anything: both already put these fields on the
 * last frame of a normal streamed response. All this does is stop throwing
 * them away.
 */

/** Ollama reports every duration in nanoseconds. */
const NS_PER_MS = 1_000_000;

function positive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

/**
 * Zero is a real answer for a count, unlike a duration.
 *
 * A request that generated no tokens (a tool call that came back empty, a stop
 * on the first token) reports `eval_count: 0`, and showing nothing there reads
 * as "not reported" when it is in fact the finding.
 */
function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function ms(nanoseconds: unknown): number | undefined {
	const value = positive(nanoseconds);
	return value === undefined ? undefined : value / NS_PER_MS;
}

/** Tokens per second, from a count and a duration that both have to be real. */
function rate(tokens: number | undefined, durationMs: number | undefined) {
	if (tokens === undefined || tokens <= 0 || !durationMs) {
		return undefined;
	}
	return (tokens * 1000) / durationMs;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Ollama's `/api/chat` final chunk, as the patched vendor forwards it.
 *
 * `prompt_eval_count` is the whole prompt, cached prefix included -- Ollama
 * does not say how much of it it skipped, which is why `cachedTokens` stays
 * empty here and is filled in on the llama.cpp path, where the server does.
 */
function readOllamaTimings(
	metadata: Record<string, unknown>,
): RequestTimings | undefined {
	const promptTokens = count(metadata.prompt_eval_count);
	const generateTokens = count(metadata.eval_count);
	const promptMs = ms(metadata.prompt_eval_duration);
	const generateMs = ms(metadata.eval_duration);
	const loadMs = ms(metadata.load_duration);
	const engineTotalMs = ms(metadata.total_duration);
	if (
		promptTokens === undefined &&
		generateTokens === undefined &&
		promptMs === undefined &&
		generateMs === undefined &&
		engineTotalMs === undefined
	) {
		return undefined;
	}
	return {
		engine: "ollama",
		...(loadMs !== undefined ? { loadMs } : {}),
		...(promptTokens !== undefined ? { promptTokens } : {}),
		...(promptMs !== undefined ? { promptMs } : {}),
		...(rate(promptTokens, promptMs) !== undefined
			? { promptPerSecond: rate(promptTokens, promptMs) }
			: {}),
		...(generateTokens !== undefined ? { generateTokens } : {}),
		...(generateMs !== undefined ? { generateMs } : {}),
		...(rate(generateTokens, generateMs) !== undefined
			? { generatePerSecond: rate(generateTokens, generateMs) }
			: {}),
		...(engineTotalMs !== undefined ? { engineTotalMs } : {}),
	};
}

/**
 * llama.cpp's `timings` object, which it already computes the rates for.
 *
 * Its own rates are used rather than recomputed: the server divides generated
 * tokens by *decode steps*, excluding the first token that comes free with the
 * prompt batch, and with speculative decoding on that distinction is the whole
 * measurement. Dividing tokens by milliseconds here would quietly report a
 * different number than the server's own logs.
 */
function readLlamaCppTimings(
	metadata: Record<string, unknown>,
): RequestTimings | undefined {
	const promptTokens = count(metadata.prompt_n);
	const generateTokens = count(metadata.predicted_n);
	const promptMs = positive(metadata.prompt_ms);
	const generateMs = positive(metadata.predicted_ms);
	if (
		promptTokens === undefined &&
		generateTokens === undefined &&
		promptMs === undefined &&
		generateMs === undefined
	) {
		return undefined;
	}
	const promptPerSecond =
		positive(metadata.prompt_per_second) ?? rate(promptTokens, promptMs);
	const generatePerSecond =
		positive(metadata.predicted_per_second) ?? rate(generateTokens, generateMs);
	const cachedTokens = count(metadata.cache_n);
	const draftTokens = count(metadata.draft_n);
	const draftAcceptedTokens = count(metadata.draft_n_accepted);
	return {
		engine: "llamacpp",
		...(promptTokens !== undefined ? { promptTokens } : {}),
		...(promptMs !== undefined ? { promptMs } : {}),
		...(promptPerSecond !== undefined ? { promptPerSecond } : {}),
		...(generateTokens !== undefined ? { generateTokens } : {}),
		...(generateMs !== undefined ? { generateMs } : {}),
		...(generatePerSecond !== undefined ? { generatePerSecond } : {}),
		// The server reports prompt and generation separately and no total, so
		// the total it would have reported is the sum of the two it does.
		...(promptMs !== undefined || generateMs !== undefined
			? { engineTotalMs: (promptMs ?? 0) + (generateMs ?? 0) }
			: {}),
		...(cachedTokens !== undefined ? { cachedTokens } : {}),
		...(draftTokens !== undefined ? { draftTokens } : {}),
		...(draftAcceptedTokens !== undefined ? { draftAcceptedTokens } : {}),
	};
}

/**
 * Read whichever engine's timings are in this request's provider metadata.
 *
 * Returns nothing for every provider that reports none, which is most of them.
 * That absence is carried through to the UI as an absence: Cline's own
 * `requestMs` still stands on its own, and inventing a prompt/generation split
 * from it would be a guess presented as a measurement.
 */
export function readEngineTimings(
	providerMetadata: unknown,
): RequestTimings | undefined {
	const metadata = asRecord(providerMetadata);
	if (!metadata) {
		return undefined;
	}
	const ollama = asRecord(metadata.ollama);
	if (ollama) {
		const timings = readOllamaTimings(ollama);
		if (timings) {
			return timings;
		}
	}
	// Under the key the opencoti metadata extractor writes. Named for the
	// engine rather than the provider because llama.cpp's own server, opencoti
	// and any other build of it all answer with the same `timings` object, and
	// a user reading "llamacpp" learns something a provider id would not tell
	// them.
	const llamaCpp = asRecord(metadata.llamacpp);
	if (llamaCpp) {
		return readLlamaCppTimings(llamaCpp);
	}
	return undefined;
}

/**
 * Combine what Cline measured with what the engine reported.
 *
 * Cline's numbers are never overwritten by the engine's: they answer different
 * questions, and a request whose measured wall time exceeds the engine's total
 * spent that gap waiting to be admitted -- which is exactly the thing a user
 * chasing a slow local model needs to see.
 */
export function mergeRequestTimings(
	measured: RequestTimings,
	engine: RequestTimings | undefined,
): RequestTimings {
	return engine ? { ...engine, ...measured } : measured;
}
