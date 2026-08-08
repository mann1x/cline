import { describe, expect, it } from "vitest";
import { LoopDetectionTracker } from "./loop-detection";

/**
 * The case these cover is the one the consecutive counter missed.
 *
 * Measured on a live session: the same `editor` call — same path, same range,
 * the same 684 characters — was sent twelve times and answered "No change"
 * every time. Two calls to a different line in the middle reset the
 * consecutive count twice, so the run continued for another forty messages
 * before the hard stop arrived.
 */
describe("LoopDetectionTracker", () => {
	const call = { name: "editor", input: { path: "a.ts", start_line: 94 } };
	const other = { name: "editor", input: { path: "a.ts", start_line: 112 } };

	// Interleaved deliberately: without something in between, the consecutive
	// rule fires first and these tests would not be exercising the new one.
	function failTimes(tracker: LoopDetectionTracker, times: number) {
		for (let attempt = 0; attempt < times; attempt += 1) {
			tracker.inspect(call);
			tracker.noteOutcome(false);
			tracker.inspect(other);
			tracker.noteOutcome(true);
		}
	}

	it("stops a call that keeps failing even when other calls interrupt it", () => {
		const tracker = new LoopDetectionTracker();

		for (let round = 0; round < 6; round += 1) {
			expect(tracker.inspect(call).kind).not.toBe("hard");
			tracker.noteOutcome(false);
			// The interruption that used to reset everything.
			tracker.inspect(other);
			tracker.noteOutcome(true);
		}

		const verdict = tracker.inspect(call);
		expect(verdict.kind).toBe("hard");
		expect(verdict.message).toContain("already been made 6 times and failed");
	});

	it("counts the failures down out loud before it stops", () => {
		const tracker = new LoopDetectionTracker();

		// The first failure gets no countdown: one failure is ordinary.
		expect(tracker.inspect(call).kind).toBe("ok");
		tracker.noteOutcome(false);

		const remaining: string[] = [];
		for (let round = 0; round < 5; round += 1) {
			const verdict = tracker.inspect(call);
			expect(verdict.kind).toBe("soft");
			remaining.push(verdict.message ?? "");
			tracker.noteOutcome(false);
			tracker.inspect(other);
			tracker.noteOutcome(true);
		}

		expect(remaining[0]).toContain("only 5 strikes left");
		expect(remaining[3]).toContain("only 2 strikes left");
		expect(remaining[4]).toContain("this is the LAST strike");
		expect(tracker.inspect(call).kind).toBe("hard");
	});

	it("never counts a call that worked", () => {
		const tracker = new LoopDetectionTracker();

		for (let round = 0; round < 20; round += 1) {
			expect(tracker.inspect(call).kind).toBe("ok");
			tracker.noteOutcome(true);
			// Something else in between, so the consecutive rule stays quiet too.
			tracker.inspect(other);
			tracker.noteOutcome(true);
		}
	});

	it("forgives a call that starts working again", () => {
		const tracker = new LoopDetectionTracker();

		failTimes(tracker, 4);
		// The edit-fix-retry cycle: it failed, the cause was addressed, it works.
		tracker.inspect(call);
		tracker.noteOutcome(true);

		failTimes(tracker, 4);
		expect(tracker.inspect(call).kind).not.toBe("hard");
	});

	it("keeps the consecutive rule for a call whose outcome never arrives", () => {
		const tracker = new LoopDetectionTracker();

		let verdict = tracker.inspect(call);
		for (let attempt = 1; attempt < 5; attempt += 1) {
			verdict = tracker.inspect(call);
		}

		expect(verdict.kind).toBe("hard");
		expect(verdict.message).toContain("consecutive identical calls");
	});

	it("forgets everything on reset", () => {
		const tracker = new LoopDetectionTracker();

		failTimes(tracker, 6);
		tracker.reset();

		expect(tracker.inspect(call).kind).toBe("ok");
	});
});

describe("a call the tool has declared a no-op", () => {
	const call = {
		name: "editor",
		input: { path: "game.html", start_line: 94, end_line: 96, new_text: "…" },
	};

	// Measured: this exact shape was sent seven times against six "No change"
	// refusals, with the whole file re-read between four of them. Twenty-four
	// minutes, no edit, and the run ended on the loop stop anyway. That budget
	// is what the strike count spends — the difference is that every refusal
	// after the first now says how much of it is left.
	it("explains the first repeat, then counts down to the stop", () => {
		const tracker = new LoopDetectionTracker();

		expect(tracker.inspect(call).kind).toBe("ok");
		tracker.noteOutcome(false, true);

		const warned = tracker.inspect(call);
		expect(warned.kind).toBe("soft");
		expect(warned.message).toContain("refused as a no-op");
		expect(warned.message).toContain("already in place");
		expect(warned.message).toContain("only 5 strikes left");
		tracker.noteOutcome(false, true);

		const later: string[] = [];
		for (let strike = 2; strike < 6; strike += 1) {
			const verdict = tracker.inspect(call);
			expect(verdict.kind).toBe("soft");
			later.push(verdict.message ?? "");
			tracker.noteOutcome(false, true);
		}

		expect(later[0]).toContain("only 4 strikes left");
		expect(later[3]).toContain("this is the LAST strike");

		const verdict = tracker.inspect(call);
		expect(verdict.kind).toBe("hard");
		expect(verdict.message).toContain("character-for-character");
		expect(verdict.message).toContain("refused 6 times");
	});

	it("gives a payload that goes futile again its own warning", () => {
		// The warning belongs to the episode, not to the payload for the rest of
		// the session: an edit that starts working again has changed situation.
		const tracker = new LoopDetectionTracker();

		tracker.inspect(call);
		tracker.noteOutcome(false, true);
		expect(tracker.inspect(call).kind).toBe("soft");
		tracker.noteOutcome(true);

		expect(tracker.inspect(call).kind).toBe("ok");
		tracker.noteOutcome(false, true);
		const fresh = tracker.inspect(call);
		expect(fresh.kind).toBe("soft");
		// The strikes go with it: the new episode gets the whole budget.
		expect(fresh.message).toContain("only 5 strikes left");
	});

	// Measured: `editor` applied lines 94-97, then the identical call was sent
	// twice more. The second was refused as a no-op and the third stopped the
	// run -- with two successful edits among the four turns before it. The model
	// was told the text matched the file, which reads like a failure, and never
	// that its own edit had put it there.
	it("says the work already landed before it stops a repeat of a success", () => {
		const tracker = new LoopDetectionTracker();

		expect(tracker.inspect(call).kind).toBe("ok");
		tracker.noteOutcome(true);

		expect(tracker.inspect(call).kind).toBe("ok");
		tracker.noteOutcome(false, true);

		const first = tracker.inspect(call);
		expect(first.kind).toBe("soft");
		expect(first.message).toContain("already succeeded");
		tracker.noteOutcome(false, true);

		// Said once, because it answers a question the later warnings do not:
		// after that the countdown carries the message.
		const second = tracker.inspect(call);
		expect(second.message).not.toContain("already succeeded");
		expect(second.message).toContain("unchanged from the one that was just refused");
	});

	// An ordinary failure may stop failing — a range that had moved, a read that
	// had gone stale. Only a no-op is answerable in advance.
	it("does not shorten the leash for an ordinary failure", () => {
		const tracker = new LoopDetectionTracker();

		tracker.inspect(call);
		tracker.noteOutcome(false);
		expect(tracker.inspect(call).kind).not.toBe("hard");
	});

	it("only binds the identical payload", () => {
		const tracker = new LoopDetectionTracker();

		tracker.inspect(call);
		tracker.noteOutcome(false, true);

		const different = {
			name: "editor",
			input: { ...call.input, new_text: "something else" },
		};
		expect(tracker.inspect(different).kind).toBe("ok");
	});

	it("is forgiven once that payload does something", () => {
		const tracker = new LoopDetectionTracker();

		tracker.inspect(call);
		tracker.noteOutcome(false, true);
		tracker.inspect(call);
		tracker.noteOutcome(true);

		expect(tracker.inspect(call).kind).toBe("ok");
	});

	it("is cleared by reset, so a new task starts even", () => {
		const tracker = new LoopDetectionTracker();

		tracker.inspect(call);
		tracker.noteOutcome(false, true);
		tracker.reset();

		expect(tracker.inspect(call).kind).toBe("ok");
	});
});
