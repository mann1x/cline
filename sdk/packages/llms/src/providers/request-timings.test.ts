import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

	// Measured on a real session: 91,738 prompt tokens against 63.6 ms of
	// prompt_eval_duration, reported as 1.44 million tokens a second. The
	// clock covers only what was evaluated, so the rate has to as well.
	it("rates Ollama's prefill on the tokens it actually evaluated", () => {
		const timings = readEngineTimings({
			ollama: {
				responseId: "resp_cached",
				prompt_eval_count: 91_738,
				prompt_eval_cached_count: 91_000,
				prompt_eval_duration: 63_600_000,
				eval_count: 10,
				eval_duration: 1_000_000_000,
			},
		});

		// The prompt is still the whole prompt; only the rate changes.
		expect(timings?.promptTokens).toBe(91_738);
		expect(timings?.cachedTokens).toBe(91_000);
		// 738 evaluated in 63.6ms, not 91,738 in 63.6ms.
		expect(timings?.promptPerSecond).toBeCloseTo(11_603.8, 0);
	});

	// An absent field is unknown, not "nothing was cached": a server that does
	// not report it must not have its whole prompt counted as evaluated in one
	// direction or as zero-evaluated in the other.
	it("falls back to the whole prompt when Ollama reports no cached count", () => {
		const timings = readEngineTimings({
			ollama: {
				responseId: "resp_nocache",
				prompt_eval_count: 900,
				prompt_eval_duration: 1_000_000_000,
				eval_count: 1,
				eval_duration: 1_000_000_000,
			},
		});

		expect(timings?.cachedTokens).toBeUndefined();
		expect(timings?.promptPerSecond).toBeCloseTo(900, 0);
	});

	// A fully cached prompt evaluated nothing, so there is no rate to report.
	// Zero tokens in some milliseconds is not "infinitely fast".
	it("reports no prefill rate when the whole prompt was cached", () => {
		const timings = readEngineTimings({
			ollama: {
				responseId: "resp_allcached",
				prompt_eval_count: 4_096,
				prompt_eval_cached_count: 4_096,
				prompt_eval_duration: 12_000_000,
				eval_count: 5,
				eval_duration: 1_000_000_000,
			},
		});

		expect(timings?.promptTokens).toBe(4_096);
		expect(timings?.cachedTokens).toBe(4_096);
		expect(timings?.promptPerSecond).toBeUndefined();
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

/**
 * The gap every test above sat over.
 *
 * `readOllamaTimings` is exercised with a hand-built metadata object, so it
 * passes whether or not the provider ever delivers those fields. It did not:
 * `prompt_eval_cached_count` was added to this reader on 2026-09-10 and was
 * absent from both the zod schemas and the forwarding whitelist in
 * `patches/ollama-ai-provider-v2@4.0.1.patch`, so zod stripped it and
 * `cachedTokens` was `undefined` on every single request. The reader then took
 * its documented fallback -- the whole prompt divided by the evaluated
 * duration -- which is the 613,878 tok/s prefill the fix was written to remove.
 * Two green tests above assert that fallback, so nothing failed.
 *
 * This reads the patch and checks the other half: every field this module
 * consumes has to survive the provider. Reading the patch rather than the
 * installed package on purpose -- the patch is what is committed, and a
 * reinstall rebuilds node_modules from it.
 */
describe("the ollama provider patch", () => {
	const here = dirname(fileURLToPath(import.meta.url));
	const patch = readFileSync(
		join(
			here,
			"..",
			"..",
			"..",
			"..",
			"..",
			"patches",
			"ollama-ai-provider-v2@4.0.1.patch",
		),
		"utf8",
	);

	const CONSUMED = [
		"total_duration",
		"load_duration",
		"prompt_eval_count",
		"prompt_eval_cached_count",
		"prompt_eval_duration",
		"eval_count",
		"eval_duration",
	];

	it.each(CONSUMED)("forwards %s, which readOllamaTimings reads", (field) => {
		// In the whitelist the patched processor copies from. Matched without a
		// trailing comma: the last element of the array has none.
		expect(patch).toMatch(new RegExp(`^\\+\\s*"${field}",?\\s*$`, "m"));
	});

	// Being in the whitelist is not enough: the object handed to it is already
	// zod-parsed, and an unknown key is stripped before it is ever seen.
	it("admits the cached count through the zod schemas as well", () => {
		const declarations = patch.match(
			/^\+\s*prompt_eval_cached_count: .*number\(\)/gm,
		);

		// One per schema that already declares `prompt_eval_count`, in each of
		// the CJS and ESM builds.
		expect(declarations?.length).toBeGreaterThanOrEqual(2);
	});
});
