/**
 * What the struggle detector must and must not fire on.
 *
 * The operating point it ships at was chosen from 360 replayed runs, and every
 * clause of the conjunction is there because one of the two halves alone was
 * measured and rejected: lexical evidence fires on 46% of successful runs by
 * the good models, and behavioural evidence alone arrives with a sixth of the
 * budget left. The tests below are those clauses.
 */

import type { AgentEvent } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	createStruggleFeed,
	STRUGGLE_DISTRESS_HITS,
	STRUGGLE_FAILED_CALLS,
	STRUGGLE_MAX_PER_TASK,
	STRUGGLE_MIN_ITERATION,
	StruggleDetector,
	type StruggleVerdict,
} from "./struggle-detector";

/** A turn that hedges as hard as the opening did, with no distress language. */
const HEDGED =
	"Wait. Hmm, that is unexpected. Wait, let me look at the file again.";
/** The same volume of words with none of the markers. */
const CALM =
	"The row index is clamped in step, so the collision check reads the board.";

/**
 * A detector whose baseline is established, which is what every case needs.
 *
 * The opening hedges, because the comparison is a ratio against it: a run that
 * opened with no hedging at all has no rate to divide by, and the detector
 * treats that as "no signal" rather than as an infinite one -- a zero opening
 * rate is far more often a provider that reports no reasoning than a model
 * that was perfectly calm.
 */
function detector(): StruggleDetector {
	const struggle = new StruggleDetector();
	// Ten opening iterations, which is what freezes the run's own baseline.
	for (let iteration = 1; iteration <= 10; iteration += 1) {
		struggle.noteTurn({ iteration, reasoning: HEDGED });
	}
	return struggle;
}

/** Drive the window to `iteration` with the failures and reasoning given. */
function windowUpTo(
	struggle: StruggleDetector,
	iteration: number,
	input: { failures: number; reasoning: string },
): void {
	for (let at = iteration - 9; at <= iteration; at += 1) {
		struggle.noteTurn({ iteration: at, reasoning: input.reasoning });
	}
	for (let failure = 0; failure < input.failures; failure += 1) {
		struggle.noteToolOutcome({ iteration, failed: true });
	}
}

describe("what earns a suggestion", () => {
	it("fires on failures plus the model saying it is stuck", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: STRUGGLE_FAILED_CALLS,
			reasoning: "I'm stuck. The edit keeps failing.",
		});

		const verdict = struggle.inspect({ iteration: 24 });

		expect(verdict.kind).toBe("suggest");
		expect(verdict.message).toContain(`${STRUGGLE_FAILED_CALLS} tool calls`);
	});

	// The half that needs no cross-model calibration: the run is compared with
	// how it opened, not with any other model's rate.
	it("fires on failures plus hedging that has not decayed", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: STRUGGLE_FAILED_CALLS,
			reasoning: HEDGED,
		});

		const verdict = struggle.inspect({ iteration: 24 });

		expect(verdict.kind).toBe("suggest");
		expect(verdict.signals?.hedgingRatio).toBeGreaterThanOrEqual(1);
	});

	// Measured: 62% of successful runs, 46% of successful runs by the models
	// that should never be told they are struggling.
	it("says nothing about distress language on its own", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: 1,
			reasoning: "I'm stuck. This keeps failing.",
		});

		expect(struggle.inspect({ iteration: 24 }).kind).toBe("ok");
	});

	// Failures alone are the late-and-precise operating point this exists to
	// improve on. A run whose hedging is collapsing is converging.
	//
	// They now earn the quieter verdict rather than silence -- a nudge states
	// what was counted and proposes nothing -- but never the offer, which is
	// what this test has always been about.
	it("offers nothing on failures alone, and nudges instead", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: STRUGGLE_FAILED_CALLS + 2,
			reasoning: CALM,
		});

		expect(struggle.inspect({ iteration: 24 }).kind).toBe("nudge");
	});

	it("says nothing before the run has had a chance to read the problem", () => {
		const struggle = detector();
		windowUpTo(struggle, 15, {
			failures: STRUGGLE_FAILED_CALLS + 2,
			reasoning: "I'm stuck. This keeps failing.",
		});

		expect(struggle.inspect({ iteration: 15 }).kind).toBe("ok");
	});
});

describe("how often it may say it", () => {
	it("says it at most once in a transaction", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: STRUGGLE_FAILED_CALLS,
			reasoning: "I'm stuck, this keeps failing.",
		});
		expect(struggle.inspect({ iteration: 24 }).kind).toBe("suggest");

		windowUpTo(struggle, 30, {
			failures: STRUGGLE_FAILED_CALLS,
			reasoning: "I'm stuck, this keeps failing.",
		});
		expect(struggle.inspect({ iteration: 30 }).kind).toBe("ok");
	});

	it("says it at most twice in a task", () => {
		const struggle = detector();
		for (let round = 0; round < STRUGGLE_MAX_PER_TASK; round += 1) {
			struggle.noteTransaction(round + 1);
			windowUpTo(struggle, 24 + round * 10, {
				failures: STRUGGLE_FAILED_CALLS,
				reasoning: "I'm stuck, this keeps failing.",
			});
			struggle.noteFileChanged(`file-${round}.js`);
			expect(struggle.inspect({ iteration: 24 + round * 10 }).kind).toBe(
				"suggest",
			);
		}

		struggle.noteTransaction(99);
		struggle.noteFileChanged("file-later.js");
		windowUpTo(struggle, 90, {
			failures: STRUGGLE_FAILED_CALLS,
			reasoning: "I'm stuck, this keeps failing.",
		});

		// Spent for the task. What is left is the nudge, which proposes
		// nothing and so has nothing to spend.
		expect(struggle.inspect({ iteration: 90 }).kind).not.toBe("suggest");
	});

	// A model told it is struggling, which then changes nothing, has been told
	// everything this can tell it.
	it("does not repeat a diagnosis over an unchanged file set", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: STRUGGLE_FAILED_CALLS,
			reasoning: "I'm stuck, this keeps failing.",
		});
		struggle.noteFileChanged("game.js");
		expect(struggle.inspect({ iteration: 24 }).kind).toBe("suggest");

		struggle.noteTransaction(2);
		windowUpTo(struggle, 34, {
			failures: STRUGGLE_FAILED_CALLS,
			reasoning: "I'm stuck, this keeps failing.",
		});

		expect(struggle.inspect({ iteration: 34 }).kind).not.toBe("suggest");

		// The same diagnosis over a file set that has moved is a new one.
		struggle.noteFileChanged("board.js");
		expect(struggle.inspect({ iteration: 34 }).kind).toBe("suggest");
	});

	// 545 compactions in the corpus. The reasoning the window counted is no
	// longer in the conversation, so the model would be reading the diagnosis
	// for something it can no longer see.
	it("does not fire across a compaction", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: STRUGGLE_FAILED_CALLS,
			reasoning: "I'm stuck, this keeps failing.",
		});
		struggle.noteCompaction();

		expect(struggle.inspect({ iteration: 24 }).kind).toBe("ok");
	});
});

/**
 * The turn before the offer.
 *
 * The offer costs money, so it fires late and on a disjunction. That made the
 * turn before it silent, and the turn before it is where saying something is
 * cheapest. The nudge is derived from the trigger -- one failure short of it
 * -- so it moves whenever the trigger is reconfigured.
 */
describe("the nudge below the offer", () => {
	it("speaks one failure short of the trigger", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: STRUGGLE_FAILED_CALLS - 1,
			reasoning: CALM,
		});

		const verdict = struggle.inspect({ iteration: 24 });

		expect(verdict.kind).toBe("nudge");
		expect(verdict.message).toContain(`${STRUGGLE_FAILED_CALLS - 1} tool call`);
	});

	it("stays quiet one failure below that", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: STRUGGLE_FAILED_CALLS - 2,
			reasoning: CALM,
		});

		expect(struggle.inspect({ iteration: 24 }).kind).toBe("ok");
	});

	// A host that sets its own trigger moves the nudge with it: the whole point
	// of the quieter verdict is to be the turn before the offer, wherever that
	// turn is. Written against a threshold of its own so it says something
	// whatever the shipped default becomes.
	it("moves with the threshold rather than sitting on a number of its own", () => {
		const struggle = new StruggleDetector({ failedCalls: 9 });
		for (let iteration = 1; iteration <= 10; iteration += 1) {
			struggle.noteTurn({ iteration, reasoning: CALM });
		}
		windowUpTo(struggle, 24, { failures: 7, reasoning: CALM });
		expect(struggle.inspect({ iteration: 24 }).kind).toBe("ok");

		windowUpTo(struggle, 24, { failures: 1, reasoning: CALM });
		expect(struggle.inspect({ iteration: 24 }).kind).toBe("nudge");
	});

	// There is no turn before the first one.
	it("has nothing to say when the trigger is one failure", () => {
		const struggle = new StruggleDetector({ failedCalls: 1, maxPerTask: 0 });
		for (let iteration = 1; iteration <= 10; iteration += 1) {
			struggle.noteTurn({ iteration, reasoning: CALM });
		}
		windowUpTo(struggle, 24, { failures: 3, reasoning: CALM });

		expect(struggle.inspect({ iteration: 24 }).kind).toBe("ok");
	});

	// The caller has to read the files to say anything about them, and the
	// detector never touches a disk.
	it("hands over the files the session has changed", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: STRUGGLE_FAILED_CALLS - 1,
			reasoning: CALM,
		});
		struggle.noteFileChanged("src/game.html");

		expect(struggle.inspect({ iteration: 24 }).files).toEqual([
			"src/game.html",
		]);
	});

	// Once the offer has been made there is nothing left to work up to, and a
	// nudge behind it would be the same measurement said twice.
	it("stops once the offer has been made in this transaction", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: STRUGGLE_FAILED_CALLS,
			reasoning: "I'm stuck, this keeps failing.",
		});
		expect(struggle.inspect({ iteration: 24 }).kind).toBe("suggest");

		expect(struggle.inspect({ iteration: 25 }).kind).toBe("ok");
	});

	it("says nothing before the run has had a chance to read the problem", () => {
		const struggle = detector();
		windowUpTo(struggle, 15, {
			failures: STRUGGLE_FAILED_CALLS - 1,
			reasoning: CALM,
		});

		expect(struggle.inspect({ iteration: 15 }).kind).toBe("ok");
	});
});

describe("the distress lexicon", () => {
	// 1,628 hits in the corpus, and the same regex catches a model correctly
	// noticing it mixed up two names. Counting that as distress counts
	// competence as distress.
	it("separates confusing myself from confusing one thing with another", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: STRUGGLE_FAILED_CALLS,
			reasoning: "I'm confusing the board array with the sprite array.",
		});
		// Not the offer. The failures still earn the quieter verdict, which is
		// what four failed calls are worth on their own.
		expect(struggle.inspect({ iteration: 24 }).kind).toBe("nudge");

		const stuck = detector();
		windowUpTo(stuck, 24, {
			failures: STRUGGLE_FAILED_CALLS,
			reasoning: "I'm confusing myself. I'm confusing myself again.",
		});
		expect(stuck.inspect({ iteration: 24 }).kind).toBe("suggest");
	});
});

describe("driving the detector from the session's own events", () => {
	/** One turn: reasoning, a failing tool call, and the turn's end. */
	function turn(
		feed: { observe(event: AgentEvent): void },
		iteration: number,
		reasoning: string,
		failures: number,
	): void {
		feed.observe({ type: "iteration_start", iteration });
		feed.observe({ type: "content_end", contentType: "reasoning", reasoning });
		for (let failure = 0; failure < failures; failure += 1) {
			feed.observe({
				type: "content_end",
				contentType: "tool",
				toolName: "editor",
				error: "No replacement performed",
			});
		}
		feed.observe({
			type: "iteration_end",
			iteration,
			hadToolCalls: failures > 0,
			toolCallCount: failures,
		});
	}

	it("suggests at the end of a turn, once the evidence is there", () => {
		const detector = new StruggleDetector();
		const seen: StruggleVerdict[] = [];
		const feed = createStruggleFeed(detector, (verdict) => seen.push(verdict));

		for (let iteration = 1; iteration <= 10; iteration += 1) {
			turn(feed, iteration, HEDGED, 0);
		}
		for (let iteration = 11; iteration <= 24; iteration += 1) {
			turn(feed, iteration, "I'm stuck, this keeps failing.", 1);
		}

		// The nudges below it arrive first and repeat as the streak of refused
		// edits lengthens; the offer is made exactly once.
		expect(seen.filter((verdict) => verdict.kind === "suggest")).toHaveLength(
			1,
		);
		expect(seen.at(-1)?.kind).toBe("suggest");
	});

	// This used to be "says nothing between the tool calls of one turn", on the
	// argument that a diagnosis arriving mid-reply lands in the middle of work
	// the model has already decided on. The argument was wrong about where the
	// message goes -- the caller holds it and attaches it to the next tool
	// result -- and it cost the whole signal on a looping run, which can spend
	// hundreds of calls without ever ending a turn.
	it("speaks on the tool result, without waiting for the turn to end", () => {
		const detector = new StruggleDetector();
		const seen: StruggleVerdict[] = [];
		const feed = createStruggleFeed(detector, (verdict) => seen.push(verdict));

		feed.observe({ type: "iteration_start", iteration: 1 });
		for (let call = 1; call <= 2; call += 1) {
			feed.observe({
				type: "content_end",
				contentType: "tool",
				toolName: "editor",
				output: { success: false, error: "No replacement performed" },
			});
		}
		expect(seen).toHaveLength(0);

		feed.observe({
			type: "content_end",
			contentType: "tool",
			toolName: "editor",
			output: { success: false, error: "No replacement performed" },
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]?.kind).toBe("nudge");
		expect(seen[0]?.reason).toBe("edit-streak");
		expect(seen[0]?.message).toContain("3 attempts");
	});

	it("counts the refusal a tool hides inside a successful result", () => {
		const detector = new StruggleDetector();
		const feed = createStruggleFeed(detector, () => undefined);

		for (let call = 1; call <= 4; call += 1) {
			feed.observe({ type: "iteration_start", iteration: 20 + call });
			feed.observe({
				type: "content_end",
				contentType: "tool",
				toolName: "read_files",
				// No `error` on the event at all: the runtime called this a
				// success, and only the body says otherwise.
				output: [
					{ query: "a.js", result: "", error: "no such file", success: false },
				],
			});
		}
		expect(detector.signalsAt(24).failedCalls).toBe(4);
	});

	it("does not count a partial result as a refusal", () => {
		const detector = new StruggleDetector();
		const feed = createStruggleFeed(detector, () => undefined);

		feed.observe({ type: "iteration_start", iteration: 21 });
		feed.observe({
			type: "content_end",
			contentType: "tool",
			toolName: "read_files",
			output: [
				{ query: "a.js", result: "", error: "no such file", success: false },
				{ query: "b.js", result: "ok", success: true },
			],
		});
		expect(detector.signalsAt(21).failedCalls).toBe(0);
	});

	it("reads the message as reasoning only while the model reports none", () => {
		const thinking = new StruggleDetector();
		const open = new StruggleDetector();
		const both = [thinking, open].map((detector) =>
			createStruggleFeed(detector, () => undefined),
		);
		for (const feed of both) {
			feed.observe({ type: "iteration_start", iteration: 1 });
		}
		// The thinking model reports reasoning, so its reply is the answer.
		both[0]?.observe({
			type: "content_end",
			contentType: "reasoning",
			reasoning: "Checking the bracket balance.",
		});
		for (const feed of both) {
			feed.observe({
				type: "content_end",
				contentType: "text",
				text: "I'm stuck and I'm confused.",
			});
		}
		expect(thinking.signalsAt(1).distress).toBe(0);
		expect(open.signalsAt(1).distress).toBe(2);
	});

	it("reads the file set from the calls that change files", () => {
		const detector = new StruggleDetector();
		const feed = createStruggleFeed(detector, () => undefined);

		feed.observe({
			type: "content_start",
			contentType: "tool",
			toolName: "editor",
			input: { path: "src/game.js", new_text: "x" },
		});
		feed.observe({
			type: "content_start",
			contentType: "tool",
			toolName: "read_files",
			input: { path: "src/board.js" },
		});

		// Only the changing call moved the set, so the second diagnosis below
		// is the one the file-set rule lets through.
		for (let iteration = 1; iteration <= 10; iteration += 1) {
			turn(feed, iteration, HEDGED, 0);
		}
		for (let iteration = 11; iteration <= 24; iteration += 1) {
			turn(feed, iteration, "I'm stuck, this keeps failing.", 1);
		}
		detector.noteTransaction(2);
		expect(detector.inspect({ iteration: 25 }).kind).not.toBe("suggest");

		feed.observe({
			type: "content_start",
			contentType: "tool",
			toolName: "editor",
			input: { path: "src/board.js" },
		});
		expect(detector.inspect({ iteration: 25 }).kind).toBe("suggest");
	});
});

describe("the lexicon reaches the words models actually use", () => {
	/** Signals at the iteration floor, for a run whose window says `reasoning`. */
	function signalsFor(reasoning: string) {
		const struggle = detector();
		windowUpTo(struggle, STRUGGLE_MIN_ITERATION, {
			failures: STRUGGLE_FAILED_CALLS,
			reasoning,
		});
		return struggle.signalsAt(STRUGGLE_MIN_ITERATION);
	}

	it("reads a model reporting it has lost ground as distress", () => {
		// The four shapes the plugin corpus actually contains. The subject
		// varies -- the model, its edits, the file, the task -- which is why
		// the pattern is the participle alone and not a first-person frame.
		for (const said of [
			"I keep regressing. Let me try the edit again.",
			"My edits keep regressing, so the file is worse than before.",
			"The file keeps regressing every time I touch line 90.",
			"Previous edits have been regressing the fix.",
		]) {
			expect(signalsFor(said).distress).toBeGreaterThanOrEqual(
				STRUGGLE_DISTRESS_HITS,
			);
		}
	});

	it("does not read the noun as distress", () => {
		// `regression` is a different word, and a run writing or discussing
		// regression tests is not in trouble for saying so.
		expect(
			signalsFor("The regression suite covers this, so add a regression test.")
				.distress,
		).toBe(0);
	});

	// Hedging is only ever exposed as a ratio to the run's opening rate, and
	// the rate is per 1,000 words -- so every sentence compared here is six
	// words long, and only the marker differs.
	it("counts going in circles, however it is introduced", () => {
		// The phrase in the corpus is always `going in circles` -- 335 of 335
		// occurrences across 198 plugin sessions -- so the pattern is the
		// preposition, and the verb in front of it does not matter.
		const going = signalsFor("I am going in circles here");
		const round = signalsFor("I am round in circles here");
		const calm = signalsFor("I am reading the board again");

		expect(calm.hedgingRatio).toBe(0);
		expect(going.hedgingRatio).toBeGreaterThan(0);
		expect(round.hedgingRatio).toBe(going.hedgingRatio);
	});
});

/**
 * The signal the change protocol actually emits.
 *
 * Measured over 335 harness runs with a verdict: a discarded transaction and an
 * empty submission occur in runs that end badly and, at two of them, in no run
 * that reached FIXED at all -- 0 of 236. The failed-call window cannot see
 * this, because a model failing the protocol calls its tools successfully and
 * is told by the *result* that the check did not pass.
 */
describe("transactions the protocol threw away", () => {
	it("speaks once two attempts have been thrown away", () => {
		const struggle = detector();
		struggle.noteTransactionOutcome("discarded");

		expect(struggle.inspect({ iteration: 11 }).kind).toBe("ok");

		struggle.noteTransactionOutcome("discarded");
		const verdict = struggle.inspect({ iteration: 11 });

		expect(verdict.kind).toBe("nudge");
		expect(verdict.reason).toBe("transactions");
	});

	// An empty submission is the same waste by a different route: the attempt
	// was spent and nothing was changed.
	it("counts an empty submission as a thrown-away attempt", () => {
		const struggle = detector();
		struggle.noteTransactionOutcome("discarded");
		struggle.noteTransactionOutcome("empty");

		expect(struggle.inspect({ iteration: 11 }).reason).toBe("transactions");
	});

	// The count is of what the run has spent, not of what it spent in a row --
	// that is what was measured, and a kept transaction does not give back the
	// two that were discarded before it.
	it("is not reset by a transaction that passed", () => {
		const struggle = detector();
		struggle.noteTransactionOutcome("discarded");
		struggle.noteTransactionOutcome("kept");
		struggle.noteTransactionOutcome("discarded");

		expect(struggle.inspect({ iteration: 11 }).reason).toBe("transactions");
	});

	// `minIteration` exists because a hedging rate at iteration 12 is
	// indistinguishable from a model still reading the problem. Two discarded
	// transactions are not: they mean the same thing whenever they happen.
	it("does not wait for the iteration floor", () => {
		const struggle = new StruggleDetector({ minIteration: 500 });
		struggle.noteTransactionOutcome("discarded");
		struggle.noteTransactionOutcome("discarded");

		expect(struggle.inspect({ iteration: 3 }).reason).toBe("transactions");
	});

	it("says it once per new pair rather than on every inspection", () => {
		const struggle = detector();
		struggle.noteTransactionOutcome("discarded");
		struggle.noteTransactionOutcome("discarded");

		expect(struggle.inspect({ iteration: 11 }).kind).toBe("nudge");
		expect(struggle.inspect({ iteration: 11 }).kind).toBe("ok");

		struggle.noteTransactionOutcome("discarded");
		expect(struggle.inspect({ iteration: 11 }).kind).toBe("ok");

		struggle.noteTransactionOutcome("discarded");
		expect(struggle.inspect({ iteration: 11 }).kind).toBe("nudge");
	});
});
