import { describe, expect, it } from "vitest";
import {
	buildUnparsedToolCallNudge,
	describeUnreadableToolCallStub,
	UNPARSED_TOOL_CALL_NUDGE_PREFIX,
	unparsedToolCallInText,
} from "./format";

/**
 * The shapes measured on pandorum, 2026-10-10: 21 calls xOllama's gemma parser
 * could not read and handed back as text, each of which was answered with
 * "your last message contained no tool calls". Reduced, with the defect kept.
 */
const Q = '<|"|>';
const call = (args: string) => `<|tool_call>call:editor{${args}}<tool_call|>`;

/** 15 of the 21: the string is closed with a backtick. */
const BACKTICK = call(
	`end_line:516,new_text:${Q}<script>\nstartGame();\n</script>\n</html>\`,path:${Q}manic_miner.html${Q},start_line:30`,
);
/** 2 of the 21: no comma between two arguments. */
const NO_COMMA = call(
	`end_line:96,intent:${Q}Define missing functions${Q}new_text:${Q}}\nconst keys = {};${Q},path:${Q}manic_miner.html${Q},start_line:96`,
);
/** 1 of the 21: a value that closes a string it never opened. */
const UNOPENED = call(
	`new_text:${Q}x${Q},path:${Q}a.html${Q},task_progress:[{item:${Q}Verify${Q},status:${Q}pending${Q}},{item:- Complete task${Q},status:${Q}pending${Q}}]`,
);
/** 2 of the 21: a second call begun inside a string that was never closed. */
const RESTARTED = `<|tool_call>call:editor{new_text:${Q}<!DOCTYPE html>\n... (this is the whole file)\n<channel|>${call(
	`new_text:${Q}<!DOCTYPE html>${Q},path:${Q}manic_miner.html${Q}`,
)}`;

describe("an unreadable gemma tool call", () => {
	it("is recognised, which the qwen scan alone did not do", () => {
		const found = unparsedToolCallInText(BACKTICK);
		expect(found?.dialect).toBe("gemma");
		expect(found?.name).toBe("editor");
		expect(found?.restarts).toBe(0);
	});

	it("names the string that was closed with a backtick", () => {
		const defect = unparsedToolCallInText(BACKTICK)?.defect ?? "";
		expect(defect).toContain("`new_text`");
		expect(defect).toContain("never closed");
		expect(defect).toContain("`path`");
		expect(defect).toContain("</html>`");
	});

	it("names the two arguments with no comma between them", () => {
		expect(unparsedToolCallInText(NO_COMMA)?.defect).toContain(
			"no comma between `intent` and `new_text`",
		);
	});

	it("names a value that closes a string it never opened", () => {
		const defect = unparsedToolCallInText(UNOPENED)?.defect ?? "";
		expect(defect).toContain("`item`");
		expect(defect).toContain("never opened");
	});

	it("reads a second call inside an open string as a restart", () => {
		const found = unparsedToolCallInText(RESTARTED);
		expect(found?.blocks).toBe(2);
		expect(found?.restarts).toBe(1);
	});

	it("is not found in prose that only mentions the marker", () => {
		expect(
			unparsedToolCallInText(
				"Gemma opens a call with <|tool_call> and a name.",
			),
		).toBeUndefined();
	});

	it("is answered with the defect and never with the delimiter token itself", () => {
		const nudge = buildUnparsedToolCallNudge(
			unparsedToolCallInText(BACKTICK) ?? { blocks: 1, restarts: 0 },
		);
		expect(nudge.startsWith(UNPARSED_TOOL_CALL_NUDGE_PREFIX)).toBe(true);
		expect(nudge).toContain("never closed");
		expect(nudge).toContain("Nothing ran");
		expect(nudge).toContain("not in this conversation any more");
		// A literal delimiter in a user message is a special token in the
		// prompt, not a description of one.
		expect(nudge).not.toContain(Q);
		expect(nudge).not.toContain("<|tool_call>");
	});

	it("leaves a stub that names the tool and carries none of the call", () => {
		const stub = describeUnreadableToolCallStub(
			unparsedToolCallInText(BACKTICK) ?? { blocks: 1, restarts: 0 },
		);
		expect(stub).toContain("`editor`");
		expect(stub).not.toContain("startGame");
		expect(unparsedToolCallInText(stub)).toBeUndefined();
	});
});
