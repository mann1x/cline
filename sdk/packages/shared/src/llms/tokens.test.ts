import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	anchoredRequestTokens,
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

	it("keeps the provider's count when only the pairing looks wrong", () => {
		// Above the ceiling the count is small against the characters, which an
		// unusual tokenizer can do. The pairing is rejected; the count stands.
		observeRequestTokens(1_000, 1); // 1000 chars/token, rejected
		expect(charsPerToken()).toBe(CHARS_PER_TOKEN);
		expect(lastObservedRequestTokens()).toBe(1);
	});

	it("drops a count that claims a token per character", () => {
		// Measured on pandorum session 1789201117876_5t3as: one usage event
		// reported 138,549 input tokens for 138,262 characters. No tokenizer
		// does that, so the count is the impossible term -- and the compaction
		// trigger reads it in preference to its own estimate, so keeping it
		// compacted a 45,783-token transcript and told the user it was 138.5k.
		observeRequestTokens(353_282, 100_182); // a real request first
		const calibrated = charsPerToken();
		observeRequestTokens(138_262, 138_549);
		expect(charsPerToken()).toBe(calibrated);
		expect(lastObservedRequestTokens()).toBe(100_182);
	});

	it("drops a count larger than the context window", () => {
		// Measured on harness run 20260918-010944-0364, iteration 81: the
		// provider reported 166,848 input tokens against a 131,072-token
		// window. A prompt that large was never served -- it would not fit --
		// and the ratio was 441,771/166,848 = 2.65, comfortably inside the
		// 1.2-16 band, so the pairing guards saw nothing wrong. The count
		// became the anchor and iteration 82 estimated 116,890 tokens for a
		// request the provider then counted at 56,800: a 2.06x overestimate
		// that tripped the overflow check at 43% of the window.
		observeRequestTokens(353_282, 100_182); // a real request first
		const calibrated = charsPerToken();
		observeRequestTokens(441_771, 166_848, undefined, undefined, 131_072);
		expect(charsPerToken()).toBe(calibrated);
		expect(lastObservedRequestTokens()).toBe(100_182);
	});

	it("keeps a count that fills the context window exactly", () => {
		// The bound is the window itself, not a share of it: a request that
		// fills the window is the ordinary state just before compaction, and
		// refusing it would blind the trigger at the moment it matters most.
		observeRequestTokens(393_216, 131_072, undefined, undefined, 131_072);
		expect(lastObservedRequestTokens()).toBe(131_072);
		expect(charsPerToken()).toBeCloseTo(3.0, 2);
	});

	it("keeps a count when no window is known", () => {
		// Only the caller holding the model definition can supply the window,
		// and `seedRequestTokenCalibration` does not have one. An absent bound
		// must not become a refusal.
		observeRequestTokens(441_771, 166_848);
		expect(lastObservedRequestTokens()).toBe(166_848);
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

/**
 * The estimator's behaviour measured live on 2026-09-17, across the v9-agentic
 * sessions on pandorum. `charsPerToken` swung 3.00 -> 13.13 -> 3.04 *within
 * single sessions* and the estimate ran between 0.73x and 3.30x the provider's
 * own count, the worst being 270,826 estimated against 117,430 measured.
 *
 * The cause is structural, not a bad constant: `observeRequestTokens` charges
 * reasoning at a fixed rate and back-solves the content ratio from what is
 * left, so every error in the reasoning term is pushed into `charsPerToken` --
 * and because the divisor is a difference, the push grows as the reasoning
 * share grows. The same file already warns against exactly this shape for
 * `requestOverheadTokens`: "Measured directly, not left over from a
 * subtraction."
 *
 * Two changes below. The estimate is anchored to the last request that was
 * actually counted, so only the delta is ever projected; and an observation
 * whose reasoning term has eaten the whole count is refused, because its
 * residual carries no signal about the rest of the request.
 */
describe("anchoredRequestTokens", () => {
	beforeEach(() => {
		resetTokenCalibration();
	});

	it("charges growth that is all reasoning at the reasoning rate", () => {
		// The caller computes `reasoningChars` and the call site's own comment
		// says reasoning "is counted at its own rate" -- but once an anchor
		// existed the whole-request ratio was applied to the entire delta and
		// the parameter was never read. On any provider that transmits
		// reasoning history (mode "all": Anthropic, OpenAI, opencoti) a turn
		// that added nothing but a long think was priced as if it were prose.
		observeRequestTokens(400_000, 100_000, 200_000, "s1");
		// 50,000 characters added, all of them reasoning. At the reasoning
		// rate that is 50_000 / 2.7 = 18,519 tokens; at the request's blended
		// 4.0 it would be 12,500, understating a reasoning-heavy turn by a
		// third in the direction that hides an overflow.
		expect(anchoredRequestTokens(450_000, 250_000, "s1")).toBe(118_519);
	});

	it("is unchanged when neither side carries reasoning", () => {
		// The split has to degenerate exactly to the previous arithmetic, or
		// it regresses ollama -- which transmits no reasoning history at all,
		// so `reasoningChars` is always 0 there and this is the only path that
		// runs on the harness lane.
		observeRequestTokens(360_000, 100_000, 0, "s1");
		expect(anchoredRequestTokens(396_000, 0, "s1")).toBe(110_000);
	});

	it("falls back when the anchor's reasoning would consume its whole count", () => {
		// A count this small against that much reasoning is already refused as
		// a ratio, but it is still kept as the anchor, so the split must not
		// run off into a negative content base.
		observeRequestTokens(400_000, 10_000, 300_000, "s1");
		expect(anchoredRequestTokens(440_000, 300_000, "s1")).toBe(11_000);
	});

	it("falls back to the plain estimate before anything is measured", () => {
		expect(anchoredRequestTokens(30_000, 0, "s1")).toBe(estimateTokens(30_000));
	});

	it("counts only the characters added since the last measured request", () => {
		// 400,000 chars really cost 70,000 tokens: 5.71 chars/token.
		observeRequestTokens(400_000, 70_000, 0, "s1");
		// 20,000 chars later, the answer must be near 70,000 -- not a fresh
		// projection of all 420,000.
		const anchored = anchoredRequestTokens(420_000, 0, "s1");
		expect(anchored).toBeGreaterThan(70_000);
		expect(anchored).toBeLessThan(76_000);
	});

	it("does not drift when the ratio is wrong, because the anchor is not", () => {
		observeRequestTokens(400_000, 70_000, 0, "s1");
		// Even with a ratio that would project 2x, the anchor holds the answer
		// to the measured count plus the delta.
		expect(anchoredRequestTokens(400_000, 0, "s1")).toBe(70_000);
	});

	it("shrinks with the transcript after a compaction", () => {
		observeRequestTokens(400_000, 70_000, 0, "s1");
		const anchored = anchoredRequestTokens(150_000, 0, "s1");
		expect(anchored).toBeLessThan(70_000);
		expect(anchored).toBeGreaterThan(0);
	});

	it("ignores an anchor belonging to another conversation", () => {
		observeRequestTokens(400_000, 70_000, 0, "s1");
		expect(anchoredRequestTokens(420_000, 0, "s2")).toBe(
			estimateTokens(420_000),
		);
	});
});

describe("observeRequestTokens with a dominant reasoning share", () => {
	beforeEach(() => {
		resetTokenCalibration();
	});

	it("refuses an observation whose reasoning term has eaten the count", () => {
		const before = charsPerToken();
		// 300,000 reasoning chars at the 2.7 default claim 111,111 tokens
		// against a measured 120,000, leaving 8,889 to explain 100,000 other
		// characters -- a ratio of 11.25 that says nothing about the content.
		observeRequestTokens(400_000, 120_000, 300_000, "s1");
		expect(charsPerToken()).toBe(before);
	});

	it("still takes an observation where the residual carries signal", () => {
		observeRequestTokens(400_000, 120_000, 40_000, "s1");
		expect(charsPerToken()).not.toBe(CHARS_PER_TOKEN);
	});

	it("keeps the count even when it refuses the ratio", () => {
		observeRequestTokens(400_000, 120_000, 300_000, "s1");
		expect(lastObservedRequestTokens("s1")).toBe(120_000);
	});
});
