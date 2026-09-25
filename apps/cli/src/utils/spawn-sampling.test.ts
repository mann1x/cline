import { describe, expect, it } from "vitest";
import { formatSpawnSampling, spawnSamplingLines } from "./spawn-sampling";

describe("formatSpawnSampling", () => {
	it("carries the drawn detail on the line, having no tooltip", () => {
		expect(
			formatSpawnSampling({
				seed: 2847193,
				seedRandom: true,
				temperature: 0.713,
				temperatureBase: 0.7,
				temperatureRange: 2,
			}),
		).toBe("seed 2847193 (random) · T 0.713 (0.7 ±2%)");
		expect(formatSpawnSampling({ seed: 7, temperature: 0.2 })).toBe(
			"seed 7 · T 0.2",
		);
	});

	it("says the model's temperature stood when it could not be randomized", () => {
		expect(
			formatSpawnSampling({
				temperatureRange: 2,
				note: "model temperature unknown; kept the model's sampler",
			}),
		).toBe("T model (model temperature unknown; kept the model's sampler)");
	});

	it("is nothing for an agent spawned without a sampler", () => {
		expect(formatSpawnSampling(undefined)).toBeUndefined();
		expect(formatSpawnSampling({})).toBeUndefined();
	});
});

describe("spawnSamplingLines", () => {
	it("lists each member's line in member order", () => {
		expect(
			spawnSamplingLines({
				samplings: { "1": "seed 22 · T 0.69", "0": "seed 11 · T 0.71" },
			}),
		).toEqual(["#1 seed 11 · T 0.71", "#2 seed 22 · T 0.69"]);
		expect(spawnSamplingLines({ samplings: { "0": "seed 1" } })).toEqual([
			"seed 1",
		]);
	});

	it("falls back to the result: one agent's, or each worker's", () => {
		expect(
			spawnSamplingLines({
				result: { rawOutput: { text: "x", sampling: { seed: 3 } } },
			}),
		).toEqual(["seed 3"]);
		expect(
			spawnSamplingLines({
				result: {
					rawOutput: {
						digest: "d",
						results: [{ name: "w1", sampling: { seed: 1 } }, { name: "w2" }],
					},
				},
			}),
		).toEqual(["w1 seed 1"]);
		expect(spawnSamplingLines({})).toEqual([]);
	});
});
