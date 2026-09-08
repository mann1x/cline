import { describe, expect, it } from "vitest";
import { readEngineTimings } from "../request-timings";
import { llamaCppTimingsMetadataExtractor } from "./llamacpp-timings";

/**
 * llama.cpp puts its `timings` on the last frame of a streamed response, after
 * the usage chunk that OpenAI's own format ends on. The extractor has to
 * survive every earlier frame not having one, and has to end up with the last.
 */
describe("llamaCppTimingsMetadataExtractor", () => {
	const timings = {
		cache_n: 4096,
		prompt_n: 512,
		prompt_ms: 640,
		prompt_per_second: 800,
		predicted_n: 200,
		predicted_ms: 4000,
		predicted_per_second: 49.75,
	};

	it("keeps the timings from the final streamed frame", () => {
		const extractor = llamaCppTimingsMetadataExtractor.createStreamExtractor();
		extractor.processChunk({ choices: [{ delta: { content: "hi" } }] });
		extractor.processChunk({ choices: [], usage: { total_tokens: 712 } });
		extractor.processChunk({ choices: [], timings });

		expect(extractor.buildMetadata()).toEqual({ llamacpp: timings });
		expect(readEngineTimings(extractor.buildMetadata())?.engine).toBe(
			"llamacpp",
		);
	});

	it("takes the last of repeated timings rather than the first", () => {
		// A server configured for per-token timings sends one on every frame,
		// and only the last describes the whole request.
		const extractor = llamaCppTimingsMetadataExtractor.createStreamExtractor();
		extractor.processChunk({ timings: { ...timings, predicted_n: 1 } });
		extractor.processChunk({ timings });

		expect(extractor.buildMetadata()).toEqual({ llamacpp: timings });
	});

	it("reports nothing for a server that sends no timings", () => {
		const extractor = llamaCppTimingsMetadataExtractor.createStreamExtractor();
		extractor.processChunk({ choices: [{ delta: { content: "hi" } }] });
		extractor.processChunk({ choices: [], usage: { total_tokens: 712 } });

		// Every hosted OpenAI-compatible provider takes this path, and an empty
		// metadata object would claim an engine that never answered.
		expect(extractor.buildMetadata()).toBeUndefined();
	});

	it("reads the non-streaming body too", async () => {
		await expect(
			llamaCppTimingsMetadataExtractor.extractMetadata({
				parsedBody: { choices: [], timings },
			}),
		).resolves.toEqual({ llamacpp: timings });
		await expect(
			llamaCppTimingsMetadataExtractor.extractMetadata({ parsedBody: {} }),
		).resolves.toBeUndefined();
	});
});
