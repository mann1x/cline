import { describe, expect, it } from "vitest";
import {
	cutEchoedTranscript,
	DEFAULT_REPLAY_COMPACTION_PROMPT,
	REPLAY_BLOCK_LIMITS,
	trimReplayOverflow,
} from "./replay-compaction";

describe("the replay speaks in the present", () => {
	// A replay prepended to the model's own remaining turns is read as the
	// state of play, not as history. Past tense tells the model the facts are
	// old and may no longer hold, and it re-checks what it already knows or
	// treats a live warning as something that once happened. Reported from a
	// 29-minute pandorum run: "The user asked me" should be "The user is
	// asking me", "I started by" should be "Let me start by", "the editor then
	// warned me" should be "the editor is warning me".
	// The council splits the replay at a boundary only the writer can place:
	// it knows where one stretch of work ends, and the harness would have to
	// guess from prose.
	it("asks for the halfway marker, on a step boundary", () => {
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).toContain("<<<HALFWAY>>>");
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).toContain("Exactly once");
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).toContain(
			"boundary between steps",
		);
	});

	it("asks for present continuous and not past", () => {
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).not.toContain("Past tense");
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).toContain("present continuous");
	});

	it("shows the model the rewrite it is being asked for", () => {
		// Examples rather than a rule: "present tense" alone gets a model to
		// write "The user asks me to fix it", which is still a report about a
		// session. The pairs are what move it to "The user is asking me".
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).toContain("The user is asking me");
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).toContain("Let me start by");
	});

	it("makes the rule apply to every step, not only the opening", () => {
		// Two builds in, the report was the same: "the prose of the summary is
		// still wrong, it's still not formatted as a replay but as a summary".
		// The measured shape was a present-tense first sentence and a
		// present-tense last one around a wholly past-tense body, so the rule
		// had to stop reading as advice about how to begin.
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).toContain("every step");
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).toContain(
			"not only its first and last",
		);
		// The outcome as its own sentence, which is what turns "my second
		// attempt also failed" into "let me try it. It failed."
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).toContain("It failed:");
	});

	it("does not print the phrasings it is trying to prevent", () => {
		// The table carried a "not this" column, and a pandorum summary came
		// back with its rows nearly verbatim: "I started by running the
		// diagnostic", "The user's original request was". A negative exemplar
		// is still an exemplar -- it puts the sequence in front of the model
		// at the exact moment it is choosing how to open a sentence. Only the
		// column that shows what to write is kept.
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).not.toContain("The user asked me");
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).not.toContain("I started by");
	});

	it("writes its own section labels in the tense it asks for", () => {
		// The prompt demanded the present and then labelled five of its own
		// sections in the past -- "What you were asked", "What you did",
		// "Where you had got to". The measured result was a present-tense
		// opening and closing around a wholly past-tense body, which is the
		// shape of a prompt disagreeing with itself.
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).not.toContain(
			"What you were asked",
		);
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).not.toContain("What you did");
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).not.toContain(
			"Where you had got to",
		);
	});

	it("tells the model to stop at the end of its replay", () => {
		// The request ends with the transcript itself, and a model that has
		// finished what it had to say keeps the document going: 8,925 of one
		// stored summary's 13,846 characters were the request copied back.
		// `cutEchoedTranscript` is the backstop; this is the instruction meant
		// to make it unnecessary.
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT.toLowerCase()).toContain(
			"do not continue the transcript",
		);
	});

	it("does not describe the work as finished", () => {
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).not.toContain(
			"in the order things happened",
		);
	});
});

describe("the replay compaction prompt", () => {
	it("tells the model its summary is prepended to live messages, not filed away", () => {
		// The whole fault it fixes: a note is written *about* a conversation and
		// reads as a report. This text is glued directly in front of messages
		// still in the transcript, so a report is a change of voice mid-stream.
		const prompt = DEFAULT_REPLAY_COMPACTION_PROMPT.toLowerCase();
		expect(prompt).toContain("prepend");
		expect(prompt).toMatch(/first person/);
		expect(prompt).not.toContain("hand-over note");
	});

	it("closes the numbering so a citation cannot run past the record", () => {
		// Measured: against a 30-entry ledger the replay cited [#1]-[#33].
		// The splice drops 31-33, but the invented sentences they were
		// attached to stay in the summary as steps that were never taken.
		const prompt = DEFAULT_REPLAY_COMPACTION_PROMPT;
		expect(prompt).toContain("The record is complete and closed");
		expect(prompt).toContain("no `[#N]` past the end to cite");
		expect(prompt).toContain("a step you have not taken yet");
	});

	it("asks for the user's own words back verbatim", () => {
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT.toLowerCase()).toContain(
			"verbatim",
		);
	});

	// It used to ask the model to write each call out and trim it itself.
	// Measured on pandorum with v9-agentic at a 4,096-token cap: 69% of the
	// replay was tool blocks, 21 of them against 30 real calls, and the prose
	// was cut off mid-sentence before it reached the end of the work. The
	// harness already attaches an exact record of every call, so the model was
	// spending its whole budget producing a worse copy of something it was
	// being handed.
	it("asks the model to cite the calls, not write them out", () => {
		const prompt = DEFAULT_REPLAY_COMPACTION_PROMPT;
		expect(prompt).toContain("cite the calls instead of writing them out");
		expect(prompt).toContain("[#3]");
		expect(prompt).not.toContain("```tool");
	});

	it("is task-agnostic, like the other prompts", () => {
		const prompt = DEFAULT_REPLAY_COMPACTION_PROMPT.toLowerCase();
		expect(prompt).not.toContain("coding");
		expect(prompt).not.toContain("codebase");
	});
});

describe("trimming what the model did not trim", () => {
	it("leaves a summary whose blocks are already small alone", () => {
		const text = [
			"I read the file and found the fault.",
			"```tool",
			"read_files path=a.ts",
			"→ 40 lines",
			"```",
			"Then I fixed it.",
		].join("\n");

		expect(trimReplayOverflow(text).text).toBe(text);
		expect(trimReplayOverflow(text).trimmedBlocks).toBe(0);
	});

	it("elides a fenced block the model pasted a whole file into", () => {
		// Measured behaviour: asked to replay its tool calls, a small model
		// pastes the entire file body back. That is the one thing compaction
		// exists to remove, arriving inside the thing meant to remove it.
		const body = Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n");
		const text = ["I wrote the file:", "```tool", body, "```", "Done."].join(
			"\n",
		);

		const trimmed = trimReplayOverflow(text);

		expect(trimmed.trimmedBlocks).toBe(1);
		expect(trimmed.text.length).toBeLessThan(text.length / 4);
		expect(trimmed.text).toContain("I wrote the file:");
		expect(trimmed.text).toContain("Done.");
		expect(trimmed.text).toMatch(/elided/i);
		expect(trimmed.text).not.toContain("line 500");
	});

	it("keeps the fence, so what is left still reads as a tool block", () => {
		const body = "x".repeat(20_000);
		const trimmed = trimReplayOverflow(["```tool", body, "```"].join("\n"));

		expect(trimmed.text.startsWith("```tool")).toBe(true);
		expect(trimmed.text.trimEnd().endsWith("```")).toBe(true);
	});

	it("trims every oversized block, not just the first", () => {
		const body = "y".repeat(9_000);
		const text = [
			"```tool",
			body,
			"```",
			"between",
			"```tool",
			body,
			"```",
		].join("\n");

		expect(trimReplayOverflow(text).trimmedBlocks).toBe(2);
	});

	it("does not touch the prose between the blocks, however long", () => {
		// The prose is the summary. Only the pasted payloads are the problem,
		// and a length rule that cannot tell them apart would cut the content.
		const prose = "I worked through the problem carefully. ".repeat(400);
		const trimmed = trimReplayOverflow(prose);

		expect(trimmed.text).toBe(prose);
		expect(trimmed.trimmedBlocks).toBe(0);
	});

	it("survives an unterminated fence rather than eating the rest", () => {
		// A model that runs out of budget mid-block leaves the fence open. The
		// summary is still the only record there is, so it has to come back.
		const text = ["I was writing:", "```tool", "z".repeat(9_000)].join("\n");
		const trimmed = trimReplayOverflow(text);

		expect(trimmed.text).toContain("I was writing:");
		expect(trimmed.text.length).toBeLessThan(text.length);
	});

	it("has a limit a caller can override", () => {
		expect(REPLAY_BLOCK_LIMITS.maxBlockChars).toBeGreaterThan(0);
		const text = ["```tool", "q".repeat(400), "```"].join("\n");

		expect(trimReplayOverflow(text).trimmedBlocks).toBe(0);
		expect(trimReplayOverflow(text, { maxBlockChars: 100 }).trimmedBlocks).toBe(
			1,
		);
	});
});

describe("cutEchoedTranscript", () => {
	// The request ends `Conversation:` followed by the serialized transcript,
	// and a model that runs out of things to say keeps the document going
	// instead of stopping. Measured on pandorum session 1789848400942_m8u3a:
	// 8,925 of the stored summary's 13,846 characters were the transcript
	// copied back, and the copy was still running when the output cap cut it
	// mid-string. Nothing noticed -- the summary was under its token budget,
	// so the overrun retry never fired, and `ensureFilesSection` saw the
	// echoed `## Files` heading and left the harness's own section off.
	it("cuts the transcript a summary copied back from its own request", () => {
		const text = [
			"I am fixing the collision check.",
			"",
			"## Files",
			"Read: game.html",
			"",
			"Conversation:",
			'[Bot tool calls]: read_files(files=[{"path":"game.html"}])',
			"[Tool result]: 1 | <html>",
		].join("\n");

		const cut = cutEchoedTranscript(text);

		expect(cut.text).toContain("I am fixing the collision check.");
		// The Files section is the model's own and stays; the echo below it goes.
		expect(cut.text).toContain("Read: game.html");
		expect(cut.text).not.toContain("Conversation:");
		expect(cut.text).not.toContain("[Bot tool calls]");
		expect(cut.cutChars).toBeGreaterThan(0);
	});

	it("cuts from the first serializer marker when the header is missing", () => {
		const text = [
			"I am fixing the collision check.",
			"[Tool result]: 1 | <html>",
			'[Bot tool calls]: editor(path="game.html")',
		].join("\n");

		expect(cutEchoedTranscript(text).text).toBe(
			"I am fixing the collision check.",
		);
	});

	it("leaves a replay that quotes a marker inside a tool block alone", () => {
		// The prompt asks for fenced `tool` blocks, and a faithful replay of a
		// refused call may well carry the harness's own wording inside one.
		// Cutting there would throw away the rest of a good summary.
		const text = [
			"I am fixing the collision check.",
			"",
			"```tool",
			"read_files files=[{path: game.html}]",
			"\u2192 [Tool result]: refused, the file is too large",
			"```",
			"",
			"Now let me read it in ranges.",
		].join("\n");

		const cut = cutEchoedTranscript(text);

		expect(cut.cutChars).toBe(0);
		expect(cut.text).toContain("Now let me read it in ranges.");
	});

	it("leaves an ordinary replay untouched", () => {
		const text =
			"I am fixing the collision check.\n\nLet me start by reading it.";
		expect(cutEchoedTranscript(text)).toEqual({ text, cutChars: 0 });
	});
});
