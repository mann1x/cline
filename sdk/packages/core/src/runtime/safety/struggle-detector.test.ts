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
	STRUGGLE_MAX_PER_TASK,
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
			failures: 4,
			reasoning: "I'm stuck. The edit keeps failing.",
		});

		const verdict = struggle.inspect({ iteration: 24 });

		expect(verdict.kind).toBe("suggest");
		expect(verdict.message).toContain("4 tool calls");
	});

	// The half that needs no cross-model calibration: the run is compared with
	// how it opened, not with any other model's rate.
	it("fires on failures plus hedging that has not decayed", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, { failures: 4, reasoning: HEDGED });

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
	it("says nothing about failures on their own", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, { failures: 6, reasoning: CALM });

		expect(struggle.inspect({ iteration: 24 }).kind).toBe("ok");
	});

	it("says nothing before the run has had a chance to read the problem", () => {
		const struggle = detector();
		windowUpTo(struggle, 15, {
			failures: 6,
			reasoning: "I'm stuck. This keeps failing.",
		});

		expect(struggle.inspect({ iteration: 15 }).kind).toBe("ok");
	});
});

describe("how often it may say it", () => {
	it("says it at most once in a transaction", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: 4,
			reasoning: "I'm stuck, this keeps failing.",
		});
		expect(struggle.inspect({ iteration: 24 }).kind).toBe("suggest");

		windowUpTo(struggle, 30, {
			failures: 4,
			reasoning: "I'm stuck, this keeps failing.",
		});
		expect(struggle.inspect({ iteration: 30 }).kind).toBe("ok");
	});

	it("says it at most twice in a task", () => {
		const struggle = detector();
		for (let round = 0; round < STRUGGLE_MAX_PER_TASK; round += 1) {
			struggle.noteTransaction(round + 1);
			windowUpTo(struggle, 24 + round * 10, {
				failures: 4,
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
			failures: 4,
			reasoning: "I'm stuck, this keeps failing.",
		});

		expect(struggle.inspect({ iteration: 90 }).kind).toBe("ok");
	});

	// A model told it is struggling, which then changes nothing, has been told
	// everything this can tell it.
	it("does not repeat a diagnosis over an unchanged file set", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: 4,
			reasoning: "I'm stuck, this keeps failing.",
		});
		struggle.noteFileChanged("game.js");
		expect(struggle.inspect({ iteration: 24 }).kind).toBe("suggest");

		struggle.noteTransaction(2);
		windowUpTo(struggle, 34, {
			failures: 4,
			reasoning: "I'm stuck, this keeps failing.",
		});

		expect(struggle.inspect({ iteration: 34 }).kind).toBe("ok");

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
			failures: 4,
			reasoning: "I'm stuck, this keeps failing.",
		});
		struggle.noteCompaction();

		expect(struggle.inspect({ iteration: 24 }).kind).toBe("ok");
	});
});

describe("the distress lexicon", () => {
	// 1,628 hits in the corpus, and the same regex catches a model correctly
	// noticing it mixed up two names. Counting that as distress counts
	// competence as distress.
	it("separates confusing myself from confusing one thing with another", () => {
		const struggle = detector();
		windowUpTo(struggle, 24, {
			failures: 4,
			reasoning: "I'm confusing the board array with the sprite array.",
		});
		expect(struggle.inspect({ iteration: 24 }).kind).toBe("ok");

		const stuck = detector();
		windowUpTo(stuck, 24, {
			failures: 4,
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

		expect(seen).toHaveLength(1);
		expect(seen[0]?.kind).toBe("suggest");
	});

	// A diagnosis delivered between two tool calls of one reply arrives in the
	// middle of work the model has already decided on. The turn's end is the
	// only boundary this fires on.
	it("says nothing between the tool calls of one turn", () => {
		const detector = new StruggleDetector();
		const seen: StruggleVerdict[] = [];
		const feed = createStruggleFeed(detector, (verdict) => seen.push(verdict));

		for (let iteration = 1; iteration <= 10; iteration += 1) {
			turn(feed, iteration, HEDGED, 0);
		}
		// Everything the trigger wants, held below the iteration floor.
		for (let iteration = 11; iteration <= 19; iteration += 1) {
			turn(feed, iteration, "I'm stuck, this keeps failing.", 1);
		}
		expect(seen).toHaveLength(0);

		feed.observe({ type: "iteration_start", iteration: 20 });
		feed.observe({
			type: "content_end",
			contentType: "reasoning",
			reasoning: "I'm stuck, this keeps failing.",
		});
		feed.observe({
			type: "content_end",
			contentType: "tool",
			toolName: "editor",
			error: "No replacement performed",
		});
		expect(seen).toHaveLength(0);

		feed.observe({
			type: "iteration_end",
			iteration: 20,
			hadToolCalls: true,
			toolCallCount: 1,
		});
		expect(seen).toHaveLength(1);
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
		expect(detector.inspect({ iteration: 25 }).kind).toBe("ok");

		feed.observe({
			type: "content_start",
			contentType: "tool",
			toolName: "editor",
			input: { path: "src/board.js" },
		});
		expect(detector.inspect({ iteration: 25 }).kind).toBe("suggest");
	});
});
