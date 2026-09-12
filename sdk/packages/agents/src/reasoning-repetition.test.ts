import { describe, expect, it } from "vitest";
import {
	createRepetitionNudger,
	DEFAULT_REASONING_REPETITION,
	describeRepetition,
	isRepetitionLoop,
	measureReasoningRepetition,
} from "./reasoning-repetition";

/**
 * Fixtures are the shapes measured in the corpora, not invented ones:
 *
 *  - LOOP: pandorum session 1789026721979_kessj msg 30, where one paragraph
 *    recurred seven times in 65.
 *  - CODE_QUOTING: the false positive a naive metric produces -- `zssdm` msg 17
 *    and `swpvy` msg 284 repeat a source block five and eight times while
 *    comparing candidate edits, and are legitimate.
 *  - LONG_HEALTHY: `q29ta` msg 33, 21,907 characters with no duplicate at all.
 */

const LOOP_PARAGRAPH =
	"Actually, I think I found it! In JavaScript, `Math.random()` is a function call that returns a number between 0 and 1. But in the code there are comparisons like this. These should all be fine. Let me look more carefully...";

const FILLER = (n: number) =>
	Array.from(
		{ length: n },
		(_, index) =>
			`This is a distinct paragraph number ${index} and it needs to be long enough to be counted at all by the measurement.`,
	);

/**
 * The measured shape of `kessj` msg 30: 65 counted paragraphs, 41 distinct,
 * 24 duplicates, and the most-repeated one appearing 7 times. A single
 * paragraph repeated 7 times would only be frac 0.09 -- real loops repeat
 * several things, which is what the fraction is measuring.
 */
const REPEATED = [
	[LOOP_PARAGRAPH, 7],
	[
		"The parser sees a function call and then a comparison operator, so that part of the code is fine.",
		5,
	],
	[
		"But if the code has something like a comparison without a space, the parser might read it differently.",
		5,
	],
	[
		"Let me look at the code more carefully to find the missing parenthesis.",
		4,
	],
	[
		"Wait, that does not make sense either, because the space is optional there.",
		3,
	],
	[
		"Let me try a different approach and just count the parentheses in the file.",
		3,
	],
	[
		"Actually, I think I should just run the linter to get a more specific error message.",
		3,
	],
	[
		"These should all be fine, so there must be something else going on here.",
		2,
	],
] as const;

const LOOP = [
	...REPEATED.flatMap(([text, times]) => Array(times).fill(text) as string[]),
	...FILLER(33),
].join("\n\n");

const CODE_BLOCK =
	"```javascript\n    dPw(c,x){this.pw.forEach(p=>{if(!p.cl){const px=p.x-x,py=p.y;c.fillStyle='#f08';c.beginPath();}}});}\n```";

/** 8 copies of a bare code quote among 60 paragraphs: legitimate. */
const CODE_QUOTING = [...Array(8).fill(CODE_BLOCK), ...FILLER(52)].join("\n\n");

const LONG_HEALTHY = FILLER(200).join("\n\n");

describe("measureReasoningRepetition", () => {
	it("does not judge a block under the size floor", () => {
		expect(measureReasoningRepetition("short")).toBeUndefined();
	});

	it("counts verbatim duplicate paragraphs", () => {
		const measured = measureReasoningRepetition(LOOP);

		expect(measured?.maxRepeat).toBe(7);
		expect(measured?.duplicates).toBe(24);
		expect(measured?.paragraphs).toBe(65);
		expect(measured?.duplicateFraction).toBeCloseTo(24 / 65, 3);
		expect(measured?.sample).toContain("I think I found it");
	});

	// The false positive a naive metric produces. A model quoting the same
	// source while comparing candidate edits is working, not looping.
	it("does not count a bare code quote", () => {
		const measured = measureReasoningRepetition(CODE_QUOTING);

		expect(measured?.maxRepeat).toBe(1);
		expect(isRepetitionLoop(measured)).toBe(false);
	});

	// ...but prose that carries code along with it is exactly the loop shape
	// seen in `n1iy5` msg 63, so it must still be counted.
	it("counts prose that has code inside it", () => {
		const withCode =
			"I will try to replace line 94 with `dPw(c,x){this.pw.forEach(p=>{});}` and see if that is the fix. (Wait, no)";
		const text = [...Array(5).fill(withCode), ...FILLER(40)].join("\n\n");

		expect(measureReasoningRepetition(text)?.maxRepeat).toBe(5);
	});

	it("finds nothing in a long block that never repeats", () => {
		const measured = measureReasoningRepetition(LONG_HEALTHY);

		expect(measured?.duplicates).toBe(0);
		expect(isRepetitionLoop(measured)).toBe(false);
	});
});

describe("isRepetitionLoop", () => {
	it("fires on the measured loop", () => {
		expect(isRepetitionLoop(measureReasoningRepetition(LOOP))).toBe(true);
	});

	// Both signals are required. On the labelled corpus the legitimate blocks
	// reach frac 0.21 and maxRepeat 10 on their own, so either alone lets them
	// through.
	it("needs the duplicate fraction as well as the repeat count", () => {
		// One paragraph 10 times, but buried in 200 distinct ones: frac 0.045.
		const diffuse = [...Array(10).fill(LOOP_PARAGRAPH), ...FILLER(200)].join(
			"\n\n",
		);
		const measured = measureReasoningRepetition(diffuse);

		expect(measured?.maxRepeat).toBe(10);
		expect(measured?.duplicateFraction).toBeLessThan(0.25);
		expect(isRepetitionLoop(measured)).toBe(false);
	});

	it("needs the repeat count as well as the fraction", () => {
		// Many paragraphs twice each: frac 0.5, but nothing recurs 4 times.
		const paired = FILLER(30)
			.flatMap((p) => [p, p])
			.join("\n\n");
		const measured = measureReasoningRepetition(paired);

		expect(measured?.duplicateFraction).toBeGreaterThanOrEqual(0.25);
		expect(measured?.maxRepeat).toBe(2);
		expect(isRepetitionLoop(measured)).toBe(false);
	});
});

describe("describeRepetition", () => {
	it("quotes the passage back and asks for a concrete step", () => {
		// Asserted rather than `!`-ed: if the measure ever stops recognising LOOP
		// this should fail naming that, not throw inside describeRepetition.
		const measured = measureReasoningRepetition(LOOP);
		expect(measured).toBeDefined();
		const message = describeRepetition(
			measured as NonNullable<typeof measured>,
		);

		expect(message).toContain("7 times");
		expect(message).toContain("I think I found it");
		expect(message).toContain("is visible to the user");
		expect(message).toMatch(/run the check|make the change/);
	});
});

describe("createRepetitionNudger", () => {
	// A nudge is pressure on a small model. It may interrupt a cycle; it must
	// not narrate one.
	// One per run by default, the same budget and the same measured reason as
	// `DEFAULT_MAX_NO_TOOL_CALL_NUDGES`: the second nudge has never changed an
	// outcome. A run that loops all day is told once.
	it("spends one nudge per run and then stays quiet", () => {
		const nudger = createRepetitionNudger();

		expect(DEFAULT_REASONING_REPETITION.maxNudges).toBe(1);
		expect(nudger.inspect(LOOP, 1)).toBeDefined();
		for (const turn of [4, 7, 10, 13, 16, 100]) {
			expect(nudger.inspect(LOOP, turn)).toBeUndefined();
		}
		expect(nudger.spent).toBe(1);
	});

	// The cooldown almost never binds at a budget of one, but a host that
	// raises the budget must not get two nudges in consecutive turns.
	it("rations a raised budget by cooldown", () => {
		const nudger = createRepetitionNudger({
			...DEFAULT_REASONING_REPETITION,
			maxNudges: 3,
		});

		expect(nudger.inspect(LOOP, 1)).toBeDefined();
		expect(nudger.inspect(LOOP, 2)).toBeUndefined();
		expect(nudger.inspect(LOOP, 3)).toBeUndefined();
		expect(nudger.inspect(LOOP, 4)).toBeDefined();
		expect(nudger.spent).toBe(2);
	});

	it("stays silent on healthy reasoning however long", () => {
		const nudger = createRepetitionNudger();

		expect(nudger.inspect(LONG_HEALTHY, 1)).toBeUndefined();
		expect(nudger.inspect(CODE_QUOTING, 5)).toBeUndefined();
		expect(nudger.spent).toBe(0);
	});
});

/**
 * Earning the nudge back.
 *
 * The budget was one per run, on the measurement that a second nudge into the
 * same unbroken loop never changed an outcome. That still holds — the cooldown
 * enforces it. What the flat cap also refused was a nudge into a *different*
 * loop, much later, after real work.
 *
 * Measured on pandorum session 1789122866533_br1d0: the one nudge fired on a
 * 63,272-character block with a paragraph repeated 91 times, and the run
 * recovered immediately — mean reasoning per turn 2,068 chars → 503, with 26
 * more tool calls after. A guard that works that well should be reachable
 * twice in a 340-message run.
 */
describe("recovering the nudge budget", () => {
	const CLEAN = FILLER(40).join("\n\n");

	it("gives the budget back after enough non-looping reasoning", () => {
		const nudger = createRepetitionNudger();

		expect(nudger.inspect(LOOP, 1)).toBeDefined();
		expect(nudger.spent).toBe(1);

		// Clean turns, past the recovery window and the cooldown.
		let turn = 4;
		let fed = 0;
		const needed = DEFAULT_REASONING_REPETITION.recoveryTokens * 4;
		while (fed < needed) {
			expect(nudger.inspect(CLEAN, turn)).toBeUndefined();
			fed += CLEAN.length;
			turn += 1;
		}

		expect(nudger.spent).toBe(0);
		expect(nudger.inspect(LOOP, turn + 10)).toBeDefined();
	});

	// The guarantee that keeps the original measurement intact: a model still
	// looping cannot buy its way back to a fresh budget, because a block that
	// trips the thresholds contributes nothing to the window.
	it("does not let a still-looping model earn the budget back", () => {
		const nudger = createRepetitionNudger();

		expect(nudger.inspect(LOOP, 1)).toBeDefined();
		for (const turn of [4, 8, 12, 16, 20, 24, 28, 32, 36, 40]) {
			expect(nudger.inspect(LOOP, turn)).toBeUndefined();
		}

		expect(nudger.spent).toBe(1);
	});

	// A little clean reasoning is not recovery — that is what would let the
	// model alternate one tidy turn with one loop and be nudged every time.
	it("does not give it back on a short quiet spell", () => {
		const nudger = createRepetitionNudger();

		expect(nudger.inspect(LOOP, 1)).toBeDefined();
		expect(nudger.inspect(CLEAN, 5)).toBeUndefined();
		expect(nudger.spent).toBe(1);
		expect(nudger.inspect(LOOP, 9)).toBeUndefined();
	});

	it("keeps the old behaviour when recovery is switched off", () => {
		const nudger = createRepetitionNudger({
			...DEFAULT_REASONING_REPETITION,
			recoveryTokens: 0,
		});

		expect(nudger.inspect(LOOP, 1)).toBeDefined();
		for (let turn = 4; turn < 60; turn += 4) {
			nudger.inspect(FILLER(40).join("\n\n"), turn);
		}

		expect(nudger.spent).toBe(1);
		expect(nudger.inspect(LOOP, 100)).toBeUndefined();
	});
});
