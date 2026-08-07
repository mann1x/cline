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

		for (let round = 0; round < 5; round += 1) {
			expect(tracker.inspect(call).kind).not.toBe("hard");
			tracker.noteOutcome(false);
			// The interruption that used to reset everything.
			tracker.inspect(other);
			tracker.noteOutcome(true);
		}

		const verdict = tracker.inspect(call);
		expect(verdict.kind).toBe("hard");
		expect(verdict.message).toContain("already been made 5 times and failed");
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
	// minutes, no edit, and the run ended on the loop stop anyway.
	it("is stopped on its first repeat, not its fifth", () => {
		const tracker = new LoopDetectionTracker();

		expect(tracker.inspect(call).kind).toBe("ok");
		tracker.noteOutcome(false, true);

		const verdict = tracker.inspect(call);
		expect(verdict.kind).toBe("hard");
		expect(verdict.message).toContain("character-for-character");
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
