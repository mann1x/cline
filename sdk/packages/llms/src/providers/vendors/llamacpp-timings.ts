/**
 * Keep llama.cpp's `timings` object, which the compatible provider drops.
 *
 * The server puts it on the last frame of every streamed response --
 * `prompt_n`/`prompt_ms`, `predicted_n`/`predicted_ms`, the rates it computed
 * itself, `cache_n` for the prefix it did not have to re-read, and the
 * speculative-decoding counters when a draft model is attached. None of that
 * is standard OpenAI, so `@ai-sdk/openai-compatible` parses past it; a metadata
 * extractor is that package's supported way to keep a field it does not know,
 * which is why this path needs no patched dependency the way Ollama's does.
 *
 * Its own module rather than opencoti's because both the PolyKV vendor and the
 * generic OpenAI-compatible one use it, and the generic path must not pull in
 * opencoti's pool bookkeeping to get a timings reader.
 *
 * Keyed `llamacpp` because the shape belongs to the engine: llama.cpp's own
 * server answers with exactly this, so anything built on it is read by the
 * same code.
 */

function readTimingsField(
	body: unknown,
): { llamacpp: Record<string, unknown> } | undefined {
	if (!body || typeof body !== "object") {
		return undefined;
	}
	const timings = (body as { timings?: unknown }).timings;
	if (!timings || typeof timings !== "object" || Array.isArray(timings)) {
		return undefined;
	}
	return { llamacpp: timings as Record<string, unknown> };
}

export const llamaCppTimingsMetadataExtractor = {
	extractMetadata: async ({ parsedBody }: { parsedBody: unknown }) =>
		readTimingsField(parsedBody),
	createStreamExtractor: () => {
		let timings: Record<string, unknown> | undefined;
		return {
			processChunk(parsedChunk: unknown) {
				// Last one wins. The field rides the final frame, but a server
				// configured for per-token timings sends it repeatedly and only
				// the last is complete.
				const next = readTimingsField(parsedChunk);
				if (next) {
					timings = next.llamacpp;
				}
			},
			buildMetadata: () => (timings ? { llamacpp: timings } : undefined),
		};
	},
};
