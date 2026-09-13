import type { MessageWithMetadata } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { scaleEstimateToObserved } from "./compaction";
import {
	COMPACTION_TRIGGER_RATIO,
	DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
	MAX_SUMMARY_OUTPUT_TOKENS,
	resolveCompactionTriggerTokens,
	resolveDefaultMaxOutputTokens,
	resolveObservedOutputTokens,
	resolveSummaryMaxOutputTokens,
	SUMMARY_OUTPUT_WINDOW_SHARE,
} from "./compaction-shared";

describe("the compaction trigger", () => {
	it("keeps a full turn's output inside the window", () => {
		// The live failure: 110,000 window, 32,000 cap. The ratio alone put the
		// trigger at 99,000, leaving 11,000 for a reply that could ask for 32,000.
		//
		// Reserving the whole cap was itself too much, though: it took 21% of the
		// window away from the transcript on every turn to pay for an output that
		// almost never arrived. The reservation is capped at a quarter of the
		// window, which still leaves room for a reply of any ordinary size.
		expect(
			resolveCompactionTriggerTokens({
				maxInputTokens: 110_000,
				contextWindow: 110_000,
				modelMaxTokens: 32_000,
			}),
		).toBe(82_500);
	});

	it("never sits above the window it is meant to protect", () => {
		// The window the wire carried was 110,000 while the trigger was computed
		// from a stale 128,000, putting it 5,200 tokens past the end.
		const trigger = resolveCompactionTriggerTokens({
			maxInputTokens: 128_000,
			contextWindow: 110_000,
			modelMaxTokens: 32_000,
		});
		expect(trigger).toBeLessThan(110_000);
	});

	it("falls back to the gateway's own default cap", () => {
		// Which is a share of the window, and the same share this reserves at
		// cold start: 50,000 of 200,000, not the 32,000 anchor.
		expect(
			resolveCompactionTriggerTokens({
				maxInputTokens: 200_000,
				contextWindow: 200_000,
			}),
		).toBe(200_000 - resolveDefaultMaxOutputTokens({ contextWindow: 200_000 }));
	});

	it("does not let an outsized cap collapse a small window", () => {
		// A 32,000 cap against a 40,000 window would trigger at 8,000 and compact
		// almost every turn; the cap is the unreasonable figure there. The quarter
		// ceiling now catches this before the floor has to: 10,000 reserved, not
		// 32,000.
		expect(
			resolveCompactionTriggerTokens({
				maxInputTokens: 40_000,
				contextWindow: 40_000,
				modelMaxTokens: 32_000,
			}),
		).toBe(30_000);
	});

	it("keeps the ratio as the bound when it is the smaller one", () => {
		expect(
			resolveCompactionTriggerTokens({
				maxInputTokens: 100_000,
				contextWindow: 1_000_000,
				modelMaxTokens: 8_000,
			}),
		).toBe(100_000 * COMPACTION_TRIGGER_RATIO);
	});

	it("is the plain ratio when no window is reported", () => {
		expect(resolveCompactionTriggerTokens({ maxInputTokens: 64_000 })).toBe(
			64_000 * COMPACTION_TRIGGER_RATIO,
		);
	});
});

describe("the compaction summary budget", () => {
	// Measured: a 67,363-character transcript went into a 110,000-token window
	// and the summarizer was given 1,024 tokens to answer in, leaving roughly
	// 87,000 unused on the one generation every later turn reads.
	it("buys a full summary when the window can afford one", () => {
		expect(resolveSummaryMaxOutputTokens(110_000)).toBe(
			MAX_SUMMARY_OUTPUT_TOKENS,
		);
	});

	it("scales down with the window rather than filling it", () => {
		expect(resolveSummaryMaxOutputTokens(32_000)).toBe(2_560);
	});

	// A summary becomes the context every turn after it carries, so it cannot be
	// allowed to grow into the space compaction just freed.
	it("never spends more than its share", () => {
		for (const window of [40_000, 128_000, 1_000_000]) {
			expect(resolveSummaryMaxOutputTokens(window)).toBeLessThanOrEqual(
				Math.max(
					MAX_SUMMARY_OUTPUT_TOKENS,
					window * SUMMARY_OUTPUT_WINDOW_SHARE,
				),
			);
			expect(resolveSummaryMaxOutputTokens(window)).toBeLessThanOrEqual(
				MAX_SUMMARY_OUTPUT_TOKENS,
			);
		}
	});

	it("keeps the old default as a floor, and when nothing is known", () => {
		expect(resolveSummaryMaxOutputTokens(8_000)).toBe(
			DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
		);
		expect(resolveSummaryMaxOutputTokens(undefined)).toBe(
			DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
		);
		expect(resolveSummaryMaxOutputTokens(0)).toBe(
			DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
		);
	});
});

describe("scaling an estimate onto the provider's ruler", () => {
	// Measured live: 89,881 observed before, 93,844 estimated after, printed as a
	// compaction that made the context larger. The next response counted 80,317.
	it("makes a before and an after comparable", () => {
		expect(scaleEstimateToObserved(93_844, 104_010, 89_881)).toBe(81_096);
	});

	it("leaves the estimate alone when nothing has been counted yet", () => {
		expect(scaleEstimateToObserved(50_000, 60_000, undefined)).toBe(50_000);
		expect(scaleEstimateToObserved(50_000, 0, 40_000)).toBe(50_000);
		expect(scaleEstimateToObserved(50_000, 60_000, 0)).toBe(50_000);
	});

	it("scales up as readily as down", () => {
		expect(scaleEstimateToObserved(100, 100, 130)).toBe(130);
	});
});

/**
 * Two models, opposite needs, same window. One answers a tool call in 24 to
 * 2,164 output tokens and never reasons at length; the other opens 35,000 to
 * 45,000 characters of thinking on most turns. A single fraction of the window
 * either starves the second or robs the first, and the transcript already says
 * which one is running.
 */
describe("output room sized from what the session actually produces", () => {
	const turn = (outputTokens: number) =>
		({
			role: "assistant",
			content: [{ type: "text", text: "x" }],
			metrics: { outputTokens },
		}) as unknown as MessageWithMetadata;

	it("reads the high-water turn, not the average", () => {
		expect(
			resolveObservedOutputTokens([
				turn(100),
				turn(17_000),
				turn(120),
				turn(90),
			]),
		).toBe(17_000);
	});

	it("says nothing until there is a pattern", () => {
		// The first turn of a session is routinely the smallest it will produce,
		// and sizing a whole session's budget off it is how the second turn
		// overflows.
		expect(resolveObservedOutputTokens([])).toBeUndefined();
		expect(resolveObservedOutputTokens([turn(500)])).toBeUndefined();
	});

	it("follows a model that changes register", () => {
		// Twelve turns of sample: a run that reasoned in three lines for twenty
		// turns and then opened a long think has changed what it needs.
		const quiet = Array.from({ length: 30 }, () => turn(200));
		expect(resolveObservedOutputTokens([...quiet, turn(40_000)])).toBe(40_000);
		expect(resolveObservedOutputTokens([turn(40_000), ...quiet])).toBe(200);
	});

	it("hands a terse model back the window a big cap was holding", () => {
		// Measured: turns of 24-2,164 output tokens against a 32,000 num_predict.
		// The declared cap would reserve 32,000 of a 110,000 window for an output
		// that never arrives.
		expect(
			resolveCompactionTriggerTokens({
				maxInputTokens: 99_000,
				contextWindow: 110_000,
				modelMaxTokens: 32_000,
				observedOutputTokens: 2_164,
			}),
		).toBe(89_100);
	});

	it("reserves for a model that really does think that long", () => {
		// 17,000 tokens of reasoning on most turns: half again on top is 25,500,
		// and the trigger comes down to make room for it.
		expect(
			resolveCompactionTriggerTokens({
				maxInputTokens: 99_000,
				contextWindow: 110_000,
				modelMaxTokens: 32_000,
				observedOutputTokens: 17_000,
			}),
		).toBe(84_500);
	});

	it("never reserves past the model's own cap", () => {
		expect(
			resolveCompactionTriggerTokens({
				maxInputTokens: 99_000,
				contextWindow: 110_000,
				modelMaxTokens: 8_000,
				observedOutputTokens: 40_000,
			}),
		).toBe(89_100);
	});
});
