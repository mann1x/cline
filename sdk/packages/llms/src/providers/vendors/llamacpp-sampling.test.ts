import { describe, expect, it } from "vitest";
import {
	buildLlamaCppSamplingOptions,
	resolveLlamaCppThinkBudgetTokens,
	resolveLlamaCppThinkBudgetWindow,
} from "./llamacpp-sampling";

describe("the llama.cpp sampler mapping", () => {
	it("sends nothing when nothing was configured", () => {
		// The generic openai-compatible path also carries hosted providers, which
		// reject most of these names. An unset sampler has to leave the request
		// exactly as it was.
		expect(buildLlamaCppSamplingOptions(undefined)).toEqual({});
		expect(buildLlamaCppSamplingOptions({})).toEqual({});
	});

	it("uses the names llama.cpp's request schema declares", () => {
		expect(
			buildLlamaCppSamplingOptions({
				temperature: 0.8,
				topK: 20,
				topP: 0.95,
				minP: 0.05,
				typicalP: 1,
				repeatLastN: 96,
				repeatPenalty: 1.05,
				presencePenalty: 0,
				frequencyPenalty: 0.3,
				seed: 42,
				numPredict: 4096,
				numKeep: 8,
				stop: ["</done>"],
			}),
		).toEqual({
			temperature: 0.8,
			top_k: 20,
			top_p: 0.95,
			min_p: 0.05,
			typical_p: 1,
			repeat_last_n: 96,
			repeat_penalty: 1.05,
			presence_penalty: 0,
			frequency_penalty: 0.3,
			seed: 42,
			n_predict: 4096,
			n_keep: 8,
			stop: ["</done>"],
		});
	});

	it("does not send num_gpu, which llama.cpp takes at startup", () => {
		// `-ngl` is a server flag. Sending it per request is a field the server
		// never reads, which looks identical to one it read and ignored.
		expect(buildLlamaCppSamplingOptions({ numGpu: 99 })).toEqual({});
	});

	it("drops an empty stop list rather than clearing the server's", () => {
		expect(buildLlamaCppSamplingOptions({ stop: [] })).toEqual({});
	});

	it("carries the cap message under llama.cpp's name", () => {
		expect(
			buildLlamaCppSamplingOptions({ thinkBudgetMessage: "Answer now." }),
		).toEqual({ reasoning_budget_message: "Answer now." });
	});

	describe("the thinking budget", () => {
		it("passes a token count straight through", () => {
			expect(
				buildLlamaCppSamplingOptions(
					{ thinkBudget: "12288" },
					{ contextWindow: 262_144 },
				),
			).toEqual({ reasoning_budget_tokens: 12_288 });
		});

		it("resolves an effort level with Ollama's own fractions", () => {
			// The table is ported from the Ollama server so that one setting means
			// one budget whichever engine answers. 128k on `medium` is a quarter.
			expect(resolveLlamaCppThinkBudgetTokens("medium", 128_000)).toBe(32_000);
			expect(resolveLlamaCppThinkBudgetTokens("high", 128_000)).toBe(64_000);
			expect(resolveLlamaCppThinkBudgetTokens("max", 128_000)).toBe(102_400);
			expect(resolveLlamaCppThinkBudgetTokens("low", 128_000)).toBe(16_000);
			expect(resolveLlamaCppThinkBudgetTokens("minimal", 128_000)).toBe(8_000);
		});

		it("accepts the AI SDK's spelling of the strongest level", () => {
			expect(resolveLlamaCppThinkBudgetTokens("xhigh", 128_000)).toBe(
				resolveLlamaCppThinkBudgetTokens("max", 128_000),
			);
		});

		it("takes its share of the output cap, not the context, when both are set", () => {
			// A share of the context can equal or exceed the output cap and then
			// bounds nothing: the model spends the whole response thinking and
			// stops at the cap with no answer.
			expect(resolveLlamaCppThinkBudgetWindow(262_144, 8_192)).toBe(8_192);
			expect(resolveLlamaCppThinkBudgetWindow(262_144, undefined)).toBe(
				262_144,
			);
			expect(resolveLlamaCppThinkBudgetWindow(undefined, 8_192)).toBe(8_192);

			expect(
				buildLlamaCppSamplingOptions(
					{ thinkBudget: "medium", numPredict: 8_192 },
					{ contextWindow: 262_144 },
				),
			).toEqual({ n_predict: 8_192, reasoning_budget_tokens: 2_048 });
		});

		it("says nothing for a level it cannot size", () => {
			// `0` would read as "no thinking at all", which is the opposite of what
			// an effort level asks for.
			expect(resolveLlamaCppThinkBudgetTokens("medium", 0)).toBeUndefined();
			expect(
				resolveLlamaCppThinkBudgetTokens("enthusiastic", 128_000),
			).toBeUndefined();
			expect(
				resolveLlamaCppThinkBudgetTokens(undefined, 128_000),
			).toBeUndefined();
			expect(resolveLlamaCppThinkBudgetTokens("", 128_000)).toBeUndefined();
			expect(resolveLlamaCppThinkBudgetTokens("0", 128_000)).toBeUndefined();
		});
	});
});
