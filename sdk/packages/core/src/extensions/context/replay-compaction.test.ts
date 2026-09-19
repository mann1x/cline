import { describe, expect, it } from "vitest";
import {
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
	it("asks for present tense and not past", () => {
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).not.toContain("Past tense");
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).toContain("present tense");
	});

	it("shows the model the rewrite it is being asked for", () => {
		// Examples rather than a rule: "present tense" alone gets a model to
		// write "The user asks me to fix it", which is still a report about a
		// session. The pairs are what move it to "The user is asking me".
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).toContain("The user is asking me");
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT).toContain("Let me start by");
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

	it("asks for the user's own words back verbatim", () => {
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT.toLowerCase()).toContain(
			"verbatim",
		);
	});

	it("tells the model to trim its own tool payloads", () => {
		expect(DEFAULT_REPLAY_COMPACTION_PROMPT.toLowerCase()).toMatch(
			/trim|shorten|abbreviate/,
		);
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
