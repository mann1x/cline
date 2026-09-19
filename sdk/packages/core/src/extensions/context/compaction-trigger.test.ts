import type { MessageWithMetadata } from "@cline/shared";
import {
	anchoredRequestTokens,
	observeRequestTokens,
	resetTokenCalibration,
} from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	resolveMessageTargetOnTriggerScale,
	resolveMessageTargetTokens,
	scaleEstimateToObserved,
} from "./compaction";
import {
	COMPACTION_TRIGGER_RATIO,
	DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS,
	MAX_SUMMARY_OUTPUT_TOKENS,
	resolveCompactionTriggerTokens,
	resolveDefaultMaxOutputTokens,
	resolveObservedOutputTokens,
	resolveOutputRoomTokens,
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

	// The reservation and the trigger have to be the same number read from two
	// ends: the trigger decides when to compact *before* a turn, and the
	// starved-cap check decides whether the turn that just ran had room. Two
	// figures here is the disagreement this file exists to end.
	it("reserves exactly what the trigger holds back", () => {
		const input = {
			maxInputTokens: 128_000,
			contextWindow: 128_000,
			modelMaxTokens: 32_000,
		};

		expect(resolveCompactionTriggerTokens(input)).toBe(
			input.contextWindow - resolveOutputRoomTokens(input),
		);
	});

	// pandorum 2026-09-18: a session's measured turns ran to ~12,000 tokens, so
	// the room it needs is ~18,000 -- and the cap it was actually given on the
	// turn that emitted a pathless `editor` call was 12,286.
	it("sizes the room from what the session's turns actually cost", () => {
		expect(
			resolveOutputRoomTokens({
				contextWindow: 128_000,
				modelMaxTokens: 96_000,
				observedOutputTokens: 12_000,
			}),
		).toBe(18_000);
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

	// The floor and the no-information default are different numbers now. A
	// window small enough to scale below the floor still gets the floor; a
	// caller with no window at all gets the larger default, because a reasoning
	// model given too small a budget spends it all thinking and returns no
	// summary text at all.
	it("keeps a floor for a small window, and asks for more when nothing is known", () => {
		expect(resolveSummaryMaxOutputTokens(8_000)).toBe(1_024);
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

	// The trigger compares the provider's own count against the threshold; the
	// planner then measures the transcript with the estimator. When those two
	// scales disagree the target has to be brought onto the estimator's, or the
	// compaction is told to reach a number it is already past.
	//
	// The numbers are pandorum's, 2026-09-19 iteration 10: ollama counted the
	// request at 58,328 and the estimator read the same request as 36,826.
	// Target 40,275, overhead 23,796, transcript 13,045.
	it("puts the target on the scale the trigger fired on", () => {
		const unscaled = 40_275 - 23_796;
		expect(unscaled).toBe(16_479);
		// 16,479 is above the 13,045 the planner measures, so unscaled it asks
		// for no cut at all -- which is the no-op compaction the user saw.
		expect(unscaled).toBeGreaterThan(13_045);

		const target = resolveMessageTargetOnTriggerScale({
			requestTargetTokens: 40_275,
			requestOverheadTokens: 23_796,
			requestInputTokens: 36_826,
			triggerInputTokens: 58_328,
		});
		// 40,275 x (36,826 / 58,328) = 25,428, less the overhead.
		expect(target).toBe(1_632);
		expect(target).toBeLessThan(13_045);
	});

	it("changes nothing when the estimate and the provider agree", () => {
		expect(
			resolveMessageTargetOnTriggerScale({
				requestTargetTokens: 40_000,
				requestOverheadTokens: 10_000,
				requestInputTokens: 50_000,
				triggerInputTokens: 50_000,
			}),
		).toBe(30_000);
	});

	// The target is a share of the CONTENT, not of the window.
	//
	// The window is not what a compaction can spend. The system prompt, the
	// tool schemas and any MCP tools are paid before a single message exists
	// and compaction cannot touch a token of them -- measured on pandorum
	// 2026-09-19, 21,000-24,000 tokens of a 65,536 window, about a third of it,
	// of which the system prompt is only 1,607.
	//
	// Taking the share from the window instead made the target incoherent: a
	// quarter of 65,536 is 16,384, which is *below* the fixed price, so the
	// transcript budget floored at nothing and every compaction became a full
	// one. Taking it from what is left is the question actually being asked --
	// "how much conversation may survive" -- and it is always answerable.
	it("takes its share of what is left after the fixed price", () => {
		expect(
			resolveMessageTargetTokens({
				maxInputTokens: 65_536,
				requestOverheadTokens: 21_500,
			}),
		).toBe(11_009);
	});

	it("is unaffected by a window the fixed price would have swallowed", () => {
		// 25% of this window is 4,000, less than the 9,000 of schemas. The old
		// arithmetic returned 1; this returns a quarter of the 7,000 that is
		// actually free.
		expect(
			resolveMessageTargetTokens({
				maxInputTokens: 16_000,
				requestOverheadTokens: 9_000,
			}),
		).toBe(1_750);
	});

	it("still returns something usable when the fixed price fills the window", () => {
		expect(
			resolveMessageTargetTokens({
				maxInputTokens: 20_000,
				requestOverheadTokens: 21_000,
			}),
		).toBe(1);
	});

	// The request estimate has to be the one the request path uses.
	//
	// `estimateRequestInputTokens` is chars x a single smoothed ratio and
	// nothing anchors it, so its error compounds with the transcript. Measured
	// over the 192-turn pandorum run of 2026-09-19 (4.100.137): the ratio of
	// ollama's count to this estimate starts near 0.95 after every compaction
	// and decays to 0.58 as tool results accumulate -- the estimate reading
	// 1.7x the truth by the time the trigger fires. The gateway does not have
	// this problem because it calls `anchoredRequestTokens`, which prices only
	// the characters added since the provider's last count and leaves
	// everything before them as measurement.
	//
	// Two paths, two numbers, and the compaction budget was computed from the
	// wrong one.
	it("prices the request the way the request path does", () => {
		resetTokenCalibration();
		// The provider counted 51,230 for a request the serializer read as
		// 180,000 characters: 3.51 chars per token.
		observeRequestTokens(180_000, 51_230, 0, "estimator-anchor");

		// One more turn adds 10,000 characters. Anchored, that is 51,230 plus
		// 10,000/3.51; unanchored it is the whole 190,000 at the session ratio.
		const anchored = anchoredRequestTokens(190_000, 0, "estimator-anchor");
		expect(anchored).toBeGreaterThan(51_230);
		expect(anchored).toBeLessThan(56_000);
	});

	// The other direction, which must not move. A thin output cap forces a
	// compaction on a transcript the estimator reads at 2.7x the provider's
	// count; scaling the target up by that would hand back a bigger budget than
	// the trigger was asking for and the compaction would find nothing to cut.
	it("never loosens the target when the estimator over-reads", () => {
		expect(
			resolveMessageTargetOnTriggerScale({
				requestTargetTokens: 40_000,
				requestOverheadTokens: 10_000,
				requestInputTokens: 110_000,
				triggerInputTokens: 41_000,
			}),
		).toBe(30_000);
	});

	it("falls back to the plain subtraction with nothing to calibrate", () => {
		expect(
			resolveMessageTargetOnTriggerScale({
				requestTargetTokens: 40_000,
				requestOverheadTokens: 10_000,
				requestInputTokens: 50_000,
				triggerInputTokens: undefined,
			}),
		).toBe(30_000);
	});

	// Overhead alone can exceed the scaled target -- a system prompt and tool
	// schemas worth 24k against a 65k window get there easily. The floor is 1
	// rather than 0 so the caller still has a positive budget to plan against;
	// the recency tail is what actually stops the cut going too far.
	it("floors at one rather than going negative", () => {
		expect(
			resolveMessageTargetOnTriggerScale({
				requestTargetTokens: 30_000,
				requestOverheadTokens: 28_000,
				requestInputTokens: 30_000,
				triggerInputTokens: 60_000,
			}),
		).toBe(1);
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
/**
 * Pandorum, 2026-09-19, session `1789804328761_v0sqz`. A turn hit the thinking
 * budget and was billed 30,786 output tokens, ~28,000 of which was reasoning the
 * condenser then replaced with a 624-character note. Nothing rewrote
 * `metrics.outputTokens`, so the reservation went on being sized from reasoning
 * that no longer existed: 30,786 x 1.5 clamps to half of a 65,536 window, which
 * put the trigger on its 50% floor for the next twelve turns. The two turns
 * immediately after produced 130 and 144 tokens, and the turn after that -- a
 * 12.5 KB tool result, no long think anywhere -- measured 33,884 and compacted
 * 1,116 tokens over a threshold that should have been 58,982.
 *
 * The bill describes what was generated once. The reservation is about what the
 * context carries now, and those stopped being the same number the moment
 * anything condensed a turn.
 */
describe("output room is sized from the context, not the bill", () => {
	const assistant = (contextTokens: number, billedTokens: number) =>
		({
			role: "assistant",
			content: [{ type: "text", text: "x".repeat(contextTokens) }],
			metrics: { outputTokens: billedTokens },
		}) as unknown as MessageWithMetadata;
	/** One character to the token, so a turn's size is readable in the test. */
	const measure = (message: MessageWithMetadata) =>
		((message.content as { text?: string }[])[0]?.text ?? "").length;

	it("ignores reasoning the transcript no longer carries", () => {
		const capped = assistant(1_780, 30_786);
		expect(
			resolveObservedOutputTokens(
				[assistant(900, 523), capped, assistant(400, 130)],
				measure,
			),
		).toBe(1_780);
	});

	it("lifts the trigger off its floor after a condensed think", () => {
		// The run above, replayed. With the bill out of it the reservation is
		// 1,780 x 1.5 = 2,670, which the 8,000 floor lifts to 8,000 -- so the
		// trigger is 65,536 - 8,000 rather than the 32,768 the bill produced, and
		// the 33,884-token turn that compacted no longer does.
		const trigger = resolveCompactionTriggerTokens({
			maxInputTokens: 65_536,
			contextWindow: 65_536,
			observedOutputTokens: 1_780,
		});
		expect(trigger).toBe(57_536);
		expect(33_884).toBeLessThan(trigger);
	});

	it("still reserves for a model that really does think at length", () => {
		// The floor is a floor, not a ceiling: a session whose turns genuinely
		// occupy 24,000 tokens of context each still gets half the window held
		// back, which is the reservation this was built for.
		expect(
			resolveCompactionTriggerTokens({
				maxInputTokens: 65_536,
				contextWindow: 65_536,
				modelMaxTokens: 32_768,
				observedOutputTokens: 24_000,
			}),
		).toBe(32_768);
	});
});

describe("output room sized from what the session actually produces", () => {
	// The bill is deliberately wrong by two orders of magnitude, so a reading
	// that went back to `metrics.outputTokens` could not pass these.
	const turn = (contextTokens: number) =>
		({
			role: "assistant",
			content: [{ type: "text", text: "x".repeat(contextTokens) }],
			metrics: { outputTokens: contextTokens * 99 },
		}) as unknown as MessageWithMetadata;
	const measure = (message: MessageWithMetadata) =>
		((message.content as { text?: string }[])[0]?.text ?? "").length;

	it("reads the high-water turn, not the average", () => {
		expect(
			resolveObservedOutputTokens(
				[turn(100), turn(17_000), turn(120), turn(90)],
				measure,
			),
		).toBe(17_000);
	});

	it("says nothing until there is a pattern", () => {
		// The first turn of a session is routinely the smallest it will produce,
		// and sizing a whole session's budget off it is how the second turn
		// overflows.
		expect(resolveObservedOutputTokens([], measure)).toBeUndefined();
		expect(resolveObservedOutputTokens([turn(500)], measure)).toBeUndefined();
	});

	it("follows a model that changes register", () => {
		// Twelve turns of sample: a run that reasoned in three lines for twenty
		// turns and then opened a long think has changed what it needs.
		const quiet = Array.from({ length: 30 }, () => turn(200));
		expect(resolveObservedOutputTokens([...quiet, turn(40_000)], measure)).toBe(
			40_000,
		);
		expect(resolveObservedOutputTokens([turn(40_000), ...quiet], measure)).toBe(
			200,
		);
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
