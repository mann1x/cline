import { describe, expect, it } from "vitest";
import { describeAbortSource } from "./format";

describe("describeAbortSource", () => {
	it.each([
		[
			"a timeout",
			{ abortRequested: false, timedOut: true },
			"aborted after timeout",
		],
		["a local abort", { abortRequested: true, timedOut: false }, "aborted"],
	])("names %s from what this process knows", (_label, input, expected) => {
		expect(describeAbortSource(input)).toBe(expected);
	});

	// The two causes above are the only ones a host can see for itself, so
	// everything else came out as "another client" — including a stop the run
	// asked for. Measured: a run ended by `consecutive mistakes reached (6/6) in
	// yolo mode` reported "aborted by another client" on the JSON stream, and
	// there is no other client in a headless run.
	it("prefers the reason the run itself gave", () => {
		expect(
			describeAbortSource({
				abortRequested: false,
				timedOut: false,
				abortReason: "max consecutive mistakes reached (6/6) in yolo mode",
			}),
		).toBe("max consecutive mistakes reached (6/6) in yolo mode");
	});

	// A local abort is still a local abort: the operator pressed the key, and
	// saying what the runtime made of it afterwards would be less useful.
	it("keeps the local abort ahead of a reason", () => {
		expect(
			describeAbortSource({
				abortRequested: true,
				timedOut: false,
				abortReason: "loop guard stopped the run",
			}),
		).toBe("aborted");
	});

	it("falls back only when nothing accounts for the stop", () => {
		expect(
			describeAbortSource({ abortRequested: false, timedOut: false }),
		).toBe("aborted by another client");
	});
});
