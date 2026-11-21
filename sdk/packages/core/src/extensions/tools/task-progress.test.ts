import { describe, expect, it } from "vitest";
import {
	buildTaskProgressState,
	findLatestTaskProgress,
	parseTaskProgress,
	readTaskProgress,
	TASK_PROGRESS_PARAM,
} from "./task-progress";

// The checklist is gone (4.100.292); what is tested here is reading one: an
// old conversation's, imported onto the board on resume, and a habitual send.

describe("parseTaskProgress", () => {
	it("reads checked and unchecked items", () => {
		expect(parseTaskProgress("- [x] read the file\n- [ ] fix the bug")).toEqual(
			[
				{ text: "read the file", done: true },
				{ text: "fix the bug", done: false },
			],
		);
	});

	it("accepts an uppercase X", () => {
		expect(parseTaskProgress("- [X] done")).toEqual([
			{ text: "done", done: true },
		]);
	});

	// Models wrap the list in prose constantly. Counting those lines as pending
	// items would report work that does not exist and never reach complete.
	it("ignores lines that are not checklist items", () => {
		expect(
			parseTaskProgress(
				"Here is my plan:\n\n## Steps\n- [ ] real item\n- not an item\nsome trailing text",
			),
		).toEqual([{ text: "real item", done: false }]);
	});

	it("ignores an item with no text", () => {
		expect(parseTaskProgress("- [ ]   \n- [x] real")).toEqual([
			{ text: "real", done: true },
		]);
	});
});

describe("readTaskProgress", () => {
	it("reads a string value", () => {
		expect(readTaskProgress({ [TASK_PROGRESS_PARAM]: "- [ ] a" })).toBe(
			"- [ ] a",
		);
	});

	it("ignores blanks and shapes that carry no checklist", () => {
		// An array of lines used to be refused here on the reasoning that it was
		// not a checklist. Measured on 240 sessions it is the checklist, minus
		// the newlines -- see readTaskProgress.
		expect(readTaskProgress({ [TASK_PROGRESS_PARAM]: ["- [ ] a"] })).toBe(
			"- [ ] a",
		);
		expect(readTaskProgress({ [TASK_PROGRESS_PARAM]: "   " })).toBeUndefined();
		expect(readTaskProgress({})).toBeUndefined();
		expect(readTaskProgress(undefined)).toBeUndefined();
	});
});

describe("buildTaskProgressState", () => {
	it("counts completed against total", () => {
		const state = buildTaskProgressState("- [x] a\n- [x] b\n- [ ] c");
		expect(state.completed).toBe(2);
		expect(state.total).toBe(3);
		expect(state.markdown).toBe("- [x] a\n- [x] b\n- [ ] c");
	});
});

describe("surviving a session restore", () => {
	const transcript = [
		{ content: "fix the bugs" },
		{
			content: [
				{
					type: "tool_use",
					input: { [TASK_PROGRESS_PARAM]: "- [ ] a\n- [ ] b" },
				},
			],
		},
		{
			content: [
				{ type: "text", text: "thinking" },
				{
					type: "tool_use",
					input: { [TASK_PROGRESS_PARAM]: "- [x] a\n- [ ] b" },
				},
			],
		},
	];

	it("finds the newest checklist in the transcript", () => {
		expect(findLatestTaskProgress(transcript)).toBe("- [x] a\n- [ ] b");
	});

	it("returns nothing when no call ever carried one", () => {
		expect(findLatestTaskProgress([{ content: "hi" }])).toBeUndefined();
		expect(findLatestTaskProgress(undefined)).toBeUndefined();
		expect(
			findLatestTaskProgress([{ content: [null, "x", { type: "text" }] }]),
		).toBeUndefined();
	});
});

describe("checklists sent in a container other than a string", () => {
	it("joins an array of checklist lines", () => {
		expect(
			readTaskProgress({
				task_progress: [
					"- [x] Analyze the error",
					"- [ ] Fix the syntax errors",
				],
			}),
		).toBe("- [x] Analyze the error\n- [ ] Fix the syntax errors");
	});

	it("unwraps the field nested inside itself", () => {
		expect(
			readTaskProgress({
				task_progress: { task_progress: ["- [ ] Verify the fix"] },
			}),
		).toBe("- [ ] Verify the fix");
	});

	it("unwraps a nested string too", () => {
		expect(
			readTaskProgress({ task_progress: { task_progress: "- [ ] Verify" } }),
		).toBe("- [ ] Verify");
	});

	it("reads items given as objects rather than markdown", () => {
		expect(
			readTaskProgress({
				task_progress: [
					{ text: "Analyze the error", done: true },
					{ text: "Fix the syntax errors" },
				],
			}),
		).toBe("- [x] Analyze the error\n- [ ] Fix the syntax errors");
	});

	it("still refuses a shape that carries no checklist", () => {
		expect(readTaskProgress({ task_progress: 42 })).toBeUndefined();
		expect(readTaskProgress({ task_progress: [] })).toBeUndefined();
		expect(readTaskProgress({ task_progress: {} })).toBeUndefined();
	});
});

/**
 * Every list deepseek-v4 sent on pandorum (4.100.242, session ujw41): real
 * arrays to the task_progress tool, the JSON text of an array to the library
 * tools, and never a box. All of them parsed to zero items, so the panel drew
 * nothing and every third library report ended "Task progress (0/0 done)".
 */
describe("lists sent without boxes", () => {
	const sent = [
		"Verify epub-parse fix on previously-failed epubs",
		"Data & AI: import remaining books",
		"Report",
	];
	const open = sent.map((item) => `- [ ] ${item}`).join("\n");

	it("reads every entry of an array as an open item", () => {
		expect(readTaskProgress({ task_progress: sent })).toBe(open);
		expect(buildTaskProgressState(open)).toMatchObject({
			total: 3,
			completed: 0,
		});
	});

	it("reads the JSON text of an array as the array", () => {
		expect(readTaskProgress({ task_progress: JSON.stringify(sent) })).toBe(
			open,
		);
	});

	it("keeps a mark an entry carries, with or without the dash, and drops bullets", () => {
		expect(
			readTaskProgress({
				task_progress: ["[x] Inventory", "- [X] Check", "1. Add", "* Report"],
			}),
		).toBe("- [x] Inventory\n- [x] Check\n- [ ] Add\n- [ ] Report");
	});

	it("does not tick an item from its wording", () => {
		expect(
			readTaskProgress({ task_progress: ["Data & AI: done (all imported)"] }),
		).toBe("- [ ] Data & AI: done (all imported)");
	});

	it("reads lines with no box as open items, but one sentence as no list", () => {
		expect(
			readTaskProgress({ task_progress: "- Inventory\n- Add books\nReport" }),
		).toBe("- [ ] Inventory\n- [ ] Add books\n- [ ] Report");
		expect(
			buildTaskProgressState(
				readTaskProgress({ task_progress: "I am working on it" }) ?? "",
			).total,
		).toBe(0);
	});

	it("leaves a list with boxes as written, heading and all", () => {
		const written = "Plan:\n- [x] a\n- [ ] b";
		expect(readTaskProgress({ task_progress: written })).toBe(written);
	});
});
