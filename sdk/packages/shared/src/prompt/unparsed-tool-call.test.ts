import { describe, expect, it } from "vitest";
import {
	buildUnparsedToolCallNudge,
	NO_TOOL_CALL_NUDGE_MESSAGE,
	UNPARSED_TOOL_CALL_NUDGE_PREFIX,
	unparsedToolCallInText,
} from "./format";
import { MEASURED_TURNS } from "./unparsed-tool-call-fixtures";

/**
 * The shape measured on pandorum, 2026-09-05: the model opens a call, gets
 * part-way through a parameter, abandons it without a closing tag and starts
 * the whole call again. Ollama's qwen parser cannot tell the abandoned attempt
 * from the value of the parameter it was abandoned inside, so it hands the
 * whole block back as content — and the turn then looks like a model that
 * called nothing.
 */
const RESTARTED = `I made it worse. Let me fix it properly:<tool_call>
<function=editor>
<parameter=end_line>
90
</parameter>
<parameter=new_text>
    sX(){return -1;}}
<tool_call>
<function=editor>
<parameter=new_text>
    sX(){return -1;}
</parameter>
<parameter=path>
c:\\Users\\manni\\game.html
</parameter>
</function>
</tool_call>`;

describe("a tool call the provider handed back as text", () => {
	it("names the restart, which is the whole diagnosis", () => {
		const found = unparsedToolCallInText(RESTARTED);

		expect(found).toMatchObject({ blocks: 2, restarts: 1, name: "editor" });
	});

	it("counts one restart per abandoned parameter, however many there are", () => {
		// Measured: one turn restarted four times, and the count of restarts
		// matched the count of unterminated parameters exactly in all eight.
		const text =
			"<tool_call><function=editor><parameter=a>\n1\n" +
			"<tool_call><function=editor><parameter=b>\n2\n" +
			"<tool_call><function=editor><parameter=c>\n3\n</parameter></function></tool_call>";

		expect(unparsedToolCallInText(text)).toMatchObject({
			blocks: 3,
			restarts: 2,
		});
	});

	it("says nothing about ordinary prose, or about a turn with no block at all", () => {
		expect(unparsedToolCallInText("I will now edit the file.")).toBeUndefined();
		expect(unparsedToolCallInText(undefined)).toBeUndefined();
		expect(unparsedToolCallInText("")).toBeUndefined();
	});

	it("says nothing about prose that merely mentions the tag", () => {
		// A model asked how tool calls work writes the opening tag in a
		// sentence. Nudging it about a call it never attempted is the same class
		// of false message this exists to remove.
		expect(
			unparsedToolCallInText(
				"A call is wrapped in <tool_call> and </tool_call> tags, like XML.",
			),
		).toBeUndefined();
	});

	it("does not mistake a closed parameter that quotes the syntax for a restart", () => {
		// A model editing a file about tool calls writes this legitimately. The
		// parameter is closed, so nothing was abandoned.
		const text =
			"<tool_call><function=editor><parameter=new_text>\n" +
			"the tag is <tool_call> and it opens a call\n" +
			"</parameter></function></tool_call>";

		expect(unparsedToolCallInText(text)).toMatchObject({ restarts: 0 });
	});
});

describe("what the model is told about it", () => {
	it("says the call was read, not that nothing was sent", () => {
		// The generic nudge is false here in the one way most likely to make the
		// model repeat itself: it says the message contained no tool calls.
		const said = buildUnparsedToolCallNudge({
			blocks: 2,
			restarts: 1,
			name: "editor",
		});

		expect(said.startsWith(UNPARSED_TOOL_CALL_NUDGE_PREFIX)).toBe(true);
		expect(said).not.toBe(NO_TOOL_CALL_NUDGE_MESSAGE);
		expect(said).not.toContain("contained no tool calls");
		expect(said).toContain("`editor`");
		expect(said).toContain("never closed");
		// It has to say nothing ran, or the model may edit around a change it
		// believes it already made.
		expect(said).toContain("nothing has changed on disk");
	});

	it("counts the restarts back when there was more than one", () => {
		expect(
			buildUnparsedToolCallNudge({ blocks: 5, restarts: 4, name: "editor" }),
		).toContain("4 times over");
	});

	it("still says something useful when the block named no function", () => {
		const said = buildUnparsedToolCallNudge({ blocks: 1, restarts: 0 });

		expect(said).toContain("a tool");
		expect(said).toContain("not well formed");
	});
});

describe("the eight turns this was built from", () => {
	// The measurement, kept: every one of these was a real turn on pandorum
	// that Cline told "your last message contained no tool calls".
	// The name is the one the *last* attempt gave, which is the call the model
	// meant: two of these gave up on an edit and asked to read the file again.
	const expected: Record<
		number,
		{ blocks: number; restarts: number; name: string }
	> = {
		261: { blocks: 2, restarts: 1, name: "editor" },
		287: { blocks: 4, restarts: 3, name: "read_files" },
		291: { blocks: 5, restarts: 4, name: "editor" },
		298: { blocks: 2, restarts: 1, name: "editor" },
		300: { blocks: 2, restarts: 1, name: "editor" },
		328: { blocks: 2, restarts: 1, name: "editor" },
		346: { blocks: 3, restarts: 2, name: "read_files" },
		352: { blocks: 2, restarts: 1, name: "editor" },
	};

	it.each(MEASURED_TURNS)("recognises turn $idx", ({ idx, text }) => {
		const found = unparsedToolCallInText(text);

		expect(found).toBeDefined();
		expect(found).toMatchObject(expected[idx]);
	});

	it("would have replaced the false message on every one of them", () => {
		for (const { text } of MEASURED_TURNS) {
			const found = unparsedToolCallInText(text);
			if (!found) throw new Error("not detected");
			expect(buildUnparsedToolCallNudge(found)).not.toBe(
				NO_TOOL_CALL_NUDGE_MESSAGE,
			);
		}
	});
});
