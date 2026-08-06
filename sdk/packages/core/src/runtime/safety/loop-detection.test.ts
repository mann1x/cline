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
