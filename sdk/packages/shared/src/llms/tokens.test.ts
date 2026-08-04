import { afterEach, describe, expect, it } from "vitest";
import {
	CHARS_PER_TOKEN,
	charsPerToken,
	estimateRequestInputTokens,
	estimateTokens,
	lastObservedRequestTokens,
	measureRequestInputChars,
	observeRequestTokens,
	resetTokenCalibration,
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

	it("is not updated by an observation that was discarded", () => {
		observeRequestTokens(3_000, 1_000);
		observeRequestTokens(1_000, 1); // out of range
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
