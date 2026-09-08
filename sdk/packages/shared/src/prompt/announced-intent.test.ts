import { describe, expect, it } from "vitest";
import {
	announcedIntentWithoutActing,
	buildAnnouncedIntentNudge,
} from "./format";

/**
 * The case this was built from: a live run where the model wrote "Let me
 * propose a check, then fix them", called nothing, was nudged, wrote the same
 * kind of sentence again, and the run was reported Completed with the file
 * untouched and no check ever proposed.
 */
describe("announcedIntentWithoutActing", () => {
	it("recognises the sentence that ended the run", () => {
		const text =
			"I see several bugs — missing function definitions that would crash on load. Let me propose a check, then fix them.";
		expect(announcedIntentWithoutActing(text)).toBe(text);
	});

	it.each([
		"I'll start by reading the file.",
		"Now I will edit the collision handler.",
		"I'm going to run the check first.",
		"Next, I'll fix the remaining brace.",
	])("recognises %j", (text) => {
		expect(announcedIntentWithoutActing(text)).toBe(text);
	});

	// The whole reason the nudge budget is one: a model that says it is done
	// has answered the question, and asking again has never changed an outcome.
	it.each([
		"The task is complete — manic_miner.html loads with no console errors.",
		"All done; nothing else to do here.",
		"I'm finished. The file is now working.",
		"The game is now working correctly.",
	])("stays silent for a completion claim: %j", (text) => {
		expect(announcedIntentWithoutActing(text)).toBeUndefined();
	});

	it("ignores an announcement buried far above the end of a long message", () => {
		// A turn that said what it would do, did it, and closed with a summary
		// is not a turn that stopped at the announcement.
		const text = `Let me fix the collision handler.\n\n${"The edit is applied and the brace count is now balanced. ".repeat(20)}`;
		expect(announcedIntentWithoutActing(text)).toBeUndefined();
	});

	it("has nothing to say about an empty turn", () => {
		expect(announcedIntentWithoutActing(undefined)).toBeUndefined();
		expect(announcedIntentWithoutActing("   ")).toBeUndefined();
	});
});

describe("buildAnnouncedIntentNudge", () => {
	it("quotes the model its own sentence and names the gap", () => {
		const nudge = buildAnnouncedIntentNudge(
			"Let me propose a check, then fix them.",
		);

		expect(nudge).toContain('"Let me propose a check, then fix them."');
		expect(nudge).toContain("called nothing");
		expect(nudge).toContain("second turn running");
	});

	it("does not paste an entire message back into the prompt", () => {
		const nudge = buildAnnouncedIntentNudge("Let me ".repeat(200));
		expect(nudge.length).toBeLessThan(600);
	});
});
