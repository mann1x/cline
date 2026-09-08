import { afterEach, describe, expect, it } from "vitest";
import {
	CHARS_PER_TOKEN,
	charsPerToken,
	consumeContextOverflow,
	estimateRequestInputTokens,
	estimateTokens,
	lastObservedRequestTokens,
	lastOutputCap,
	measureRequestInputChars,
	noteContextOverflow,
	noteOutputCap,
	observeRequestTokens,
	observeThinkingTokens,
	resetTokenCalibration,
	THINKING_CHARS_PER_TOKEN,
	thinkingCharsPerToken,
} from "./tokens";

afterEach(() => {
	resetTokenCalibration();
});

describe("token calibration", () => {
	it("uses the conservative default until a provider reports a count", () => {
		expect(charsPerToken()).toBe(CHARS_PER_TOKEN);
		expect(estimateTokens(300)).toBe(100);
	});

	it("takes the first observation whole, since the default is a guess", () => {
		// one real request: 353,282 characters cost 100,182 input tokens
		observeRequestTokens(353_282, 100_182);
		expect(charsPerToken()).toBeCloseTo(3.53, 2);
	});

	it("smooths later observations so one odd request cannot move it far", () => {
		observeRequestTokens(3_000, 1_000); // 3.0
		observeRequestTokens(8_000, 1_000); // 8.0, at the upper bound
		expect(charsPerToken()).toBeCloseTo(3 * 0.7 + 8 * 0.3, 5);
	});

	it("discards ratios that describe a broken measurement, not content", () => {
		observeRequestTokens(3_000, 1_000);
		const calibrated = charsPerToken();
		observeRequestTokens(1_000, 1); // 1000 chars/token
		observeRequestTokens(1_000, 1_000_000); // 0.001 chars/token
		expect(charsPerToken()).toBe(calibrated);
	});

	it("keeps a serialized request from a large-vocabulary tokenizer", () => {
		// Measured live: Gemma-4 counted 78,138 prompt tokens for a 645,803
		// character serialized request. At the old ceiling of 8 this observation
		// and every later one was thrown away as broken.
		observeRequestTokens(645_803, 78_138);
		expect(charsPerToken()).toBeCloseTo(8.26, 2);
	});

	it("keeps the provider's count even when the ratio is rejected", () => {
		// Only the pairing can be wrong. The count is what the provider counted.
		observeRequestTokens(1_000, 1); // 1000 chars/token, rejected
		expect(charsPerToken()).toBe(CHARS_PER_TOKEN);
		expect(lastObservedRequestTokens()).toBe(1);
	});

	it("ignores absent, zero and negative counts", () => {
		observeRequestTokens(3_000, 0);
		observeRequestTokens(3_000, -5);
		observeRequestTokens(0, 1_000);
		observeRequestTokens(Number.NaN, 1_000);
		observeRequestTokens(3_000, Number.POSITIVE_INFINITY);
		expect(charsPerToken()).toBe(CHARS_PER_TOKEN);
	});

	it("estimates against the calibrated ratio once it has one", () => {
		expect(estimateTokens(35_300)).toBe(11_767); // ceil(35300 / 3)
		observeRequestTokens(353_282, 100_182);
		expect(estimateTokens(35_300)).toBe(10_011); // ceil(35300 / 3.52643)
	});

	it("never estimates below one token", () => {
		expect(estimateTokens(0)).toBe(1);
		expect(estimateTokens(1)).toBe(1);
	});
});

describe("request measurement", () => {
	const request = {
		systemPrompt: "you are a coding agent",
		messages: [{ role: "user", content: "hello" }],
		tools: [{ name: "read_files" }],
	};

	it("reports the serialized size the token estimate is derived from", () => {
		const chars = measureRequestInputChars(request);
		expect(chars).toBeGreaterThan(0);
		expect(estimateRequestInputTokens(request)).toBe(estimateTokens(chars));
	});

	it("tracks the calibrated ratio", () => {
		const chars = measureRequestInputChars(request);
		const before = estimateRequestInputTokens(request);
		observeRequestTokens(chars, Math.ceil(chars / 6));
		expect(measureRequestInputChars(request)).toBe(chars);
		expect(estimateRequestInputTokens(request)).toBeLessThan(before);
	});

	it("survives a payload that cannot be serialized", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() =>
			measureRequestInputChars({ messages: [circular as unknown] }),
		).not.toThrow();
		expect(
			measureRequestInputChars({ messages: [circular as unknown] }),
		).toBeGreaterThan(0);
	});
});

describe("the last observed request", () => {
	it("is unknown until a provider reports one", () => {
		expect(lastObservedRequestTokens()).toBeUndefined();
	});

	it("is the provider's count, not the estimate", () => {
		observeRequestTokens(353_282, 100_182);
		expect(lastObservedRequestTokens()).toBe(100_182);
	});

	it("survives an observation whose ratio was discarded", () => {
		// A ratio out of range means the character count did not belong with this
		// token count. The token count is still what the provider counted, and the
		// compaction trigger reads it -- holding it back freezes the trigger on a
		// stale number for as long as the ratios keep landing out of range.
		observeRequestTokens(3_000, 1_000);
		observeRequestTokens(1_000, 1); // out of range
		expect(lastObservedRequestTokens()).toBe(1);
	});

	it("is still ignored when the report itself is unusable", () => {
		observeRequestTokens(3_000, 1_000);
		observeRequestTokens(3_000, 0);
		observeRequestTokens(3_000, -5);
		observeRequestTokens(3_000, Number.NaN);
		expect(lastObservedRequestTokens()).toBe(1_000);
	});

	it("follows the context down after it shrinks", () => {
		observeRequestTokens(353_282, 100_182);
		observeRequestTokens(80_000, 22_661); // post-compaction
		expect(lastObservedRequestTokens()).toBe(22_661);
	});
});

describe("calibration state across module copies", () => {
	// The bundler produces more than one copy of this module: `@cline/llms`
	// inlines internal workspace code, `@cline/core` imports the published
	// package. A second copy addressing its own module variables is what let
	// the gateway record counts the compaction pipeline never saw.
	const STATE_KEY = Symbol.for("cline.shared.tokenCalibration");

	it("keeps the observation where a second copy of this module can read it", () => {
		resetTokenCalibration();
		observeRequestTokens(35_000, 10_000);

		// Stand in for the other copy: same registered symbol, no shared closure.
		const foreign = (globalThis as unknown as Record<symbol, unknown>)[
			STATE_KEY
		] as { charsPerToken?: number; requestTokens?: number } | undefined;

		expect(foreign?.requestTokens).toBe(10_000);
		expect(foreign?.charsPerToken).toBeCloseTo(3.5, 5);
		expect(lastObservedRequestTokens()).toBe(10_000);
	});

	it("reads an observation a second copy recorded", () => {
		resetTokenCalibration();
		(globalThis as unknown as Record<symbol, unknown>)[STATE_KEY] = {
			charsPerToken: 5.9,
			requestTokens: 128_000,
		};

		expect(lastObservedRequestTokens()).toBe(128_000);
		expect(charsPerToken()).toBeCloseTo(5.9, 5);
		resetTokenCalibration();
	});
});

/**
 * One ratio for a whole request is an average over two populations that do not
 * tokenize alike, and the mix moves every turn. The consequence is not
 * symmetric: a reasoning-heavy request is *under*counted, which is the
 * direction that lets one be built too large. Measured live at 71,610
 * estimated tokens for a request the server rejected against a 110,000 window.
 */
describe("counting reasoning apart from the rest", () => {
	afterEach(() => {
		resetTokenCalibration();
	});

	const request = (reasoningChars: number, otherChars: number) => ({
		messages: [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "x".repeat(reasoningChars) },
					{ type: "text", text: "y".repeat(otherChars) },
				],
			},
		],
	});

	it("charges reasoning at its own rate", () => {
		// Calibrated on a request that is mostly JSON and code.
		observeRequestTokens(420_000, 100_000);

		const heavy = estimateRequestInputTokens(request(40_000, 1_000));
		const light = estimateRequestInputTokens(request(1_000, 40_000));

		// Same total characters, very different token cost — which is the whole
		// point, and is invisible to a single ratio.
		expect(heavy).toBeGreaterThan(light * 1.3);
	});

	it("does not let both halves account for the same characters", () => {
		// The general ratio is calibrated on what is left once reasoning has
		// been charged, so the split does not silently inflate every estimate.
		observeRequestTokens(100_000, 25_000, 40_000);

		expect(charsPerToken()).toBeGreaterThan(0);
		expect(charsPerToken()).toBeLessThan(16);
	});

	it("keeps its old behaviour for a request with no reasoning in it", () => {
		observeRequestTokens(400_000, 100_000);
		const chars = measureRequestInputChars({
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
		});

		expect(
			estimateRequestInputTokens({
				messages: [
					{ role: "user", content: [{ type: "text", text: "hello" }] },
				],
			}),
		).toBe(estimateTokens(chars));
	});

	it("answers a session only with counts from that session's own requests", () => {
		// The slot is process-wide and everything that streams shares it. A count
		// left by another session -- a delegated agent, a second task -- is a
		// true measurement of the wrong request, and the compaction trigger reads
		// it as "how full am I".
		observeRequestTokens(360_000, 100_000, undefined, "session-a");

		expect(lastObservedRequestTokens("session-a")).toBe(100_000);
		expect(lastObservedRequestTokens("session-b")).toBeUndefined();
	});

	it("keeps answering a caller that cannot name its session", () => {
		// A missing id must cost an estimate at worst, never a measurement that
		// was already in hand: the trigger falls back to a character count that
		// runs roughly double, which compacts transcripts with room to spare.
		observeRequestTokens(360_000, 100_000, undefined, "session-a");
		expect(lastObservedRequestTokens()).toBe(100_000);

		resetTokenCalibration();
		observeRequestTokens(360_000, 100_000);
		expect(lastObservedRequestTokens("session-a")).toBe(100_000);
	});

	it("scopes the output cap and the overflow report the same way", () => {
		// Both are read to decide whether the *window* is what truncated a turn.
		// Another request's answer to that question suppresses the compaction the
		// retry needs (mann1x/cline#68).
		noteOutputCap(
			{ maxTokens: 4_000, source: "remaining-context", windowBound: true },
			"session-a",
		);
		expect(lastOutputCap("session-a")).toMatchObject({ windowBound: true });
		expect(lastOutputCap("session-b")).toBeUndefined();

		noteContextOverflow(
			{
				contextWindow: 262_144,
				estimatedInputTokens: 262_000,
				reserveTokens: 0,
				remainingContext: 144,
				minOutputTokens: 1_024,
			},
			"session-a",
		);
		expect(consumeContextOverflow("session-b")).toBeUndefined();
		// Not consumed by the session it did not belong to, so it is still there
		// for the one it did.
		expect(consumeContextOverflow("session-a")).toMatchObject({
			contextWindow: 262_144,
		});
	});

	it("learns the reasoning ratio from a turn that reported its own cost", () => {
		expect(thinkingCharsPerToken()).toBe(THINKING_CHARS_PER_TOKEN);

		observeThinkingTokens(43_000, 16_000);

		expect(thinkingCharsPerToken()).toBeCloseTo(43_000 / 16_000, 5);
	});
});
