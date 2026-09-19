import type { MessageWithMetadata } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	buildCouncilCriticRequest,
	COUNCIL_SYSTEM_PROMPTS,
	parseCouncilSections,
	runCouncilReview,
	splitForCouncil,
} from "./council-compaction";

function text(role: "user" | "assistant", body: string): MessageWithMetadata {
	return {
		role,
		content: [{ type: "text", text: body }],
	} as MessageWithMetadata;
}

function call(id: string, name = "read_files"): MessageWithMetadata {
	return {
		role: "assistant",
		content: [{ type: "tool_use", id, name, input: {} }],
	} as MessageWithMetadata;
}

function answer(id: string, name = "read_files"): MessageWithMetadata {
	return {
		role: "user",
		content: [{ type: "tool_result", tool_use_id: id, name, content: "ok" }],
	} as MessageWithMetadata;
}

/** Weight by serialized length, the way the real estimator does. */
const byLength = (message: MessageWithMetadata) =>
	JSON.stringify(message).length;

describe("splitForCouncil", () => {
	it("cuts at the token midpoint rather than the message midpoint", () => {
		const messages = [
			text("user", "x".repeat(4_000)),
			text("assistant", "a"),
			text("user", "b"),
			text("assistant", "c"),
		];
		const { first, second } = splitForCouncil(messages, byLength);
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(3);
	});

	it("never leaves a tool call in one half and its result in the other", () => {
		const messages = [
			text("user", "start"),
			call("t1"),
			answer("t1"),
			text("assistant", "done"),
		];
		// Force the midpoint between the call and its result.
		const weights = new Map<MessageWithMetadata, number>([
			[messages[0], 1],
			[messages[1], 10],
			[messages[2], 1],
			[messages[3], 1],
		]);
		const { first, second } = splitForCouncil(
			messages,
			(message) => weights.get(message) ?? 1,
		);
		expect(first).toContain(messages[1]);
		expect(first).toContain(messages[2]);
		expect(second).toEqual([messages[3]]);
	});

	it("still splits a span that ends on a call which never came back", () => {
		const messages = [
			text("user", "start"),
			text("assistant", "work"),
			call("t1"),
		];
		const { first, second } = splitForCouncil(messages, byLength);
		expect(first.length).toBeGreaterThan(0);
		expect(second.length).toBeGreaterThan(0);
	});

	it("leaves nothing in the second half when there is one message", () => {
		const { first, second } = splitForCouncil([text("user", "only")], byLength);
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(0);
	});

	it("always leaves both halves non-empty for two messages", () => {
		const { first, second } = splitForCouncil(
			[text("user", "a"), text("assistant", "b")],
			byLength,
		);
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
	});
});

describe("parseCouncilSections", () => {
	it("reads both sections", () => {
		const parsed = parseCouncilSections(
			"## Replay\n\nLet me read the file.\n\n## Retrospective\n\nToo many reads.",
		);
		expect(parsed.replay).toBe("Let me read the file.");
		expect(parsed.retrospective).toBe("Too many reads.");
	});

	it("tolerates a different heading level and a preamble", () => {
		const parsed = parseCouncilSections(
			"Here you go:\n\n### Replay\n\nbody\n\n#### Retrospective\n\njudgement",
		);
		expect(parsed.replay).toBe("body");
		expect(parsed.retrospective).toBe("judgement");
	});

	it("returns nothing when there is no recognisable section", () => {
		expect(parseCouncilSections("I have no notes.")).toEqual({});
	});

	it("drops an empty section rather than reporting it as present", () => {
		expect(
			parseCouncilSections("## Replay\n\n## Retrospective\n\nx").replay,
		).toBeUndefined();
	});
});

describe("buildCouncilCriticRequest", () => {
	it("tells a reviewer which half it holds and to leave the other alone", () => {
		const request = buildCouncilCriticRequest({
			half: "first",
			summary: "Let me read the file.",
			transcript: "[User]: hello",
		});
		expect(request).toContain("**first half**");
		expect(request).toContain("second half is not shown to you");
		expect(request).toContain("Leave it exactly as it stands.");
		expect(request).toContain("[User]: hello");
	});
});

describe("runCouncilReview", () => {
	// "first half" appears in the second reviewer's prompt too ("the first half
	// is not shown to you"), and "half" appears in the synthesiser's, so the
	// stubs key on the role and on the bolded half marker.
	const isCritic = (call: { systemPrompt: string }) =>
		call.systemPrompt === COUNCIL_SYSTEM_PROMPTS.critic;
	const holdsFirst = (call: { request: string }) =>
		call.request.includes("**first half**");

	const messages = [
		text("user", "fix the collision"),
		text("assistant", "a".repeat(200)),
		text("user", "b".repeat(200)),
		text("assistant", "c"),
	];

	it("gives each reviewer only its own half and the synthesiser both corrections", async () => {
		const calls: { systemPrompt: string; request: string }[] = [];
		const result = await runCouncilReview({
			summary: "original replay",
			thinkingSummary: "original retrospective",
			messages,
			estimateMessageTokens: byLength,
			generate: async (call) => {
				calls.push(call);
				if (isCritic(call)) {
					return holdsFirst(call)
						? "## Replay\n\nfirst corrected\n\n## Retrospective\n\nfirst judged"
						: "## Replay\n\nsecond corrected";
				}
				return "## Replay\n\nmerged replay\n\n## Retrospective\n\nmerged judgement";
			},
		});

		expect(calls).toHaveLength(3);
		const [firstCall, secondCall, mergeCall] = calls;
		expect(firstCall.request).toContain("fix the collision");
		expect(firstCall.request).not.toContain("ccc");
		expect(secondCall.request).not.toContain("fix the collision");
		expect(mergeCall.request).toContain("first corrected");
		expect(mergeCall.request).toContain("second corrected");
		expect(mergeCall.request).toContain("original replay");

		expect(result).toEqual({
			summary: "merged replay",
			thinkingSummary: "merged judgement",
			reviewers: 2,
			merged: true,
		});
	});

	it("keeps going when one reviewer fails", async () => {
		let merges = 0;
		const result = await runCouncilReview({
			summary: "original",
			messages,
			estimateMessageTokens: byLength,
			generate: async (call) => {
				if (isCritic(call)) {
					if (holdsFirst(call)) {
						throw new Error("provider exploded");
					}
					return "## Replay\n\nsecond corrected";
				}
				merges += 1;
				return "## Replay\n\nmerged";
			},
		});
		expect(merges).toBe(1);
		expect(result.reviewers).toBe(1);
		expect(result.summary).toBe("merged");
	});

	it("returns the original untouched when no reviewer answers", async () => {
		let merges = 0;
		const result = await runCouncilReview({
			summary: "original",
			thinkingSummary: "retro",
			messages,
			estimateMessageTokens: byLength,
			generate: async (call) => {
				if (isCritic(call)) {
					return "I have no notes.";
				}
				merges += 1;
				return "## Replay\n\nmerged";
			},
		});
		expect(merges).toBe(0);
		expect(result).toEqual({
			summary: "original",
			thinkingSummary: "retro",
			reviewers: 0,
			merged: false,
		});
	});

	it("keeps the original when the synthesiser returns no replay", async () => {
		const result = await runCouncilReview({
			summary: "original",
			thinkingSummary: "retro",
			messages,
			estimateMessageTokens: byLength,
			generate: async (call) =>
				isCritic(call) ? "## Replay\n\ncorrected" : "sorry, nothing to merge",
		});
		expect(result.summary).toBe("original");
		expect(result.thinkingSummary).toBe("retro");
		expect(result.merged).toBe(false);
		expect(result.reviewers).toBe(2);
	});

	it("keeps the original retrospective when the merge omits one", async () => {
		const result = await runCouncilReview({
			summary: "original",
			thinkingSummary: "retro",
			messages,
			estimateMessageTokens: byLength,
			generate: async (call) =>
				isCritic(call) ? "## Replay\n\ncorrected" : "## Replay\n\nmerged",
		});
		expect(result.summary).toBe("merged");
		expect(result.thinkingSummary).toBe("retro");
	});

	it("does not run at all on a span too short to split", async () => {
		let generated = 0;
		const result = await runCouncilReview({
			summary: "original",
			messages: [text("user", "only")],
			estimateMessageTokens: byLength,
			generate: async () => {
				generated += 1;
				return "## Replay\n\nx";
			},
		});
		expect(generated).toBe(0);
		expect(result.merged).toBe(false);
		expect(result.summary).toBe("original");
	});

	it("declines a half that does not fit the summarizer's input limit", async () => {
		const seen: string[] = [];
		const result = await runCouncilReview({
			summary: "original",
			messages,
			estimateMessageTokens: byLength,
			maxRequestChars: 10,
			generate: async (call) => {
				seen.push(call.systemPrompt);
				return "## Replay\n\nmerged";
			},
		});
		expect(seen).toEqual([]);
		expect(result.summary).toBe("original");
		expect(result.reviewers).toBe(0);
	});

	it("does not run on an empty summary", async () => {
		let generated = 0;
		await runCouncilReview({
			summary: "   ",
			messages,
			estimateMessageTokens: byLength,
			generate: async () => {
				generated += 1;
				return "## Replay\n\nx";
			},
		});
		expect(generated).toBe(0);
	});
});
