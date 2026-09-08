import { describe, expect, it } from "vitest";
import { mergeRequestTimings, readEngineTimings } from "./request-timings";

/**
 * The two engines that report their own timings, read from the metadata each
 * one actually sends. The fixtures are the real field names and units --
 * Ollama in nanoseconds on its `done` chunk, llama.cpp in milliseconds in its
 * `timings` object -- because the conversion between them is the whole job of
 * this module and a fixture in the wrong unit would prove nothing.
 */
describe("readEngineTimings", () => {
	it("converts Ollama's nanoseconds and derives its rates", () => {
		const timings = readEngineTimings({
			ollama: {
				responseId: "resp_1",
				total_duration: 46_322_892_038,
				load_duration: 672_995_263,
				prompt_eval_count: 15_696,
				prompt_eval_duration: 17_799_125_000,
				eval_count: 2141,
				eval_duration: 27_776_027_000,
			},
		});

		expect(timings?.engine).toBe("ollama");
		expect(timings?.engineTotalMs).toBeCloseTo(46_322.892, 1);
		expect(timings?.loadMs).toBeCloseTo(672.995, 1);
		expect(timings?.promptTokens).toBe(15_696);
		expect(timings?.promptMs).toBeCloseTo(17_799.125, 1);
		// 15696 tokens in 17.799s
		expect(timings?.promptPerSecond).toBeCloseTo(881.8, 0);
		expect(timings?.generateTokens).toBe(2141);
		// 2141 tokens in 27.776s
		expect(timings?.generatePerSecond).toBeCloseTo(77.1, 0);
	});

	it("keeps llama.cpp's own rates rather than recomputing them", () => {
		// The server divides by decode steps, not by generated tokens: the
		// first token comes free with the prompt batch. Recomputing here would
		// report a different number than the server's own logs, and with a
		// draft model attached that difference is the measurement.
		const timings = readEngineTimings({
			llamacpp: {
				cache_n: 4096,
				prompt_n: 512,
				prompt_ms: 640,
				prompt_per_second: 800,
				predicted_n: 200,
				predicted_ms: 4000,
				predicted_per_second: 49.75,
				draft_n: 120,
				draft_n_accepted: 90,
			},
		});

		expect(timings?.engine).toBe("llamacpp");
		expect(timings?.promptPerSecond).toBe(800);
		expect(timings?.generatePerSecond).toBe(49.75);
		expect(timings?.cachedTokens).toBe(4096);
		expect(timings?.draftTokens).toBe(120);
		expect(timings?.draftAcceptedTokens).toBe(90);
		// No total is reported, so it is the two halves that are.
		expect(timings?.engineTotalMs).toBe(4640);
	});

	it("reports a turn that generated nothing as zero, not as unreported", () => {
		const timings = readEngineTimings({
			ollama: {
				prompt_eval_count: 900,
				prompt_eval_duration: 1_000_000_000,
				eval_count: 0,
				eval_duration: 0,
			},
		});

		expect(timings?.generateTokens).toBe(0);
		// A rate needs a duration; there is none, and inventing one would
		// report a speed for a thing that never ran.
		expect(timings?.generatePerSecond).toBeUndefined();
	});

	it("returns nothing for a provider that reports no timings", () => {
		expect(readEngineTimings(undefined)).toBeUndefined();
		expect(readEngineTimings({})).toBeUndefined();
		expect(
			readEngineTimings({ anthropic: { cacheCreation: 12 } }),
		).toBeUndefined();
		// The response id alone is what the unpatched Ollama vendor sends.
		expect(
			readEngineTimings({ ollama: { responseId: "resp_1" } }),
		).toBeUndefined();
	});
});

describe("mergeRequestTimings", () => {
	it("keeps Cline's own measurements over the engine's", () => {
		// They answer different questions: the gap between the two totals is
		// time the request spent waiting to be admitted, and overwriting one
		// with the other would erase exactly that.
		const merged = mergeRequestTimings(
			{ requestMs: 12_000, firstTokenMs: 900 },
			{ engine: "ollama", engineTotalMs: 8000, generateTokens: 100 },
		);

		expect(merged.requestMs).toBe(12_000);
		expect(merged.engineTotalMs).toBe(8000);
		expect(merged.generateTokens).toBe(100);
	});

	it("stands alone when the engine reported nothing", () => {
		const merged = mergeRequestTimings({ requestMs: 500 }, undefined);
		expect(merged).toEqual({ requestMs: 500 });
	});
});
