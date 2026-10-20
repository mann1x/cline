import type { MessageWithMetadata } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { countCapEvents, synthesizeCapThoughts } from "./cap-thoughts";
import {
	buildSummaryMessage,
	withoutTrailingSpoiledTurn,
} from "./compaction-shared";

const user = (text: string): MessageWithMetadata => ({
	role: "user",
	content: [{ type: "text", text }],
});
const reminder = (
	text: string,
	extra: Record<string, unknown> = {},
): MessageWithMetadata => ({
	role: "user",
	content: [{ type: "text", text }],
	metadata: { userRunSpan: 0, displayRole: "system", ...extra },
});
const assistant = (
	content: MessageWithMetadata["content"],
	metadata?: Record<string, unknown>,
): MessageWithMetadata => ({
	role: "assistant",
	content,
	...(metadata ? { metadata } : {}),
});
const call = { type: "tool_use" as const, id: "c1", name: "editor", input: {} };
const result = (): MessageWithMetadata => ({
	role: "user",
	content: [
		{ type: "tool_result", tool_use_id: "c1", content: "ok" },
	] as MessageWithMetadata["content"],
});
const stub = (kind: string) =>
	assistant([{ type: "text", text: "(A call was written here...)" }], {
		spoiledTurn: { kinds: [kind], removedChars: 20_000 },
	});

describe("the transcript compaction keeps, when it ends on a spoiled turn", () => {
	const head = [
		user("fix it"),
		assistant([call]),
		result(),
		assistant([{ type: "text", text: "working" }]),
	];

	it("drops the turn and the reminders that answered it", () => {
		const kept = withoutTrailingSpoiledTurn([
			...head,
			stub("unreadable_tool_call"),
			reminder("[SYSTEM] Your last message contained a tool call..."),
		]);
		expect(kept).toHaveLength(head.length);
		expect(kept.at(-1)).toBe(head.at(-1));
	});

	it("keeps a looped turn that still ended on a tool call", () => {
		const messages = [
			...head,
			assistant([{ type: "thinking", thinking: "[SYSTEM] removed" }, call], {
				spoiledTurn: { kinds: ["reasoning_loop"], removedChars: 90_000 },
			}),
			result(),
		];
		expect(withoutTrailingSpoiledTurn(messages)).toBe(messages);
	});

	it("leaves a spoiled turn that is not the last thing alone", () => {
		const messages = [
			...head,
			stub("unreadable_tool_call"),
			reminder("[SYSTEM] ..."),
			assistant([call]),
			result(),
		];
		expect(withoutTrailingSpoiledTurn(messages)).toBe(messages);
	});

	it("does not take a message the user typed for a harness reminder", () => {
		const messages = [...head, stub("reasoning_loop"), user("and now?")];
		expect(withoutTrailingSpoiledTurn(messages)).toBe(messages);
	});
});

describe("what the harness adds to the retrospective", () => {
	it("says nothing when nothing happened", () => {
		expect(
			synthesizeCapThoughts(countCapEvents([user("a"), assistant([call])])),
		).toBeUndefined();
	});

	it("counts the events the messages carry, since the last compaction", () => {
		const events = countCapEvents([
			reminder("old", { noticeKind: "max_tokens_turn_recovery" }),
			{
				role: "user",
				content: [{ type: "text", text: "summary" }],
				metadata: { kind: "compaction_summary" },
			},
			reminder("[SYSTEM] hit the limit", {
				noticeKind: "max_tokens_turn_recovery",
			}),
			reminder("[SYSTEM] hit the limit", {
				noticeKind: "max_tokens_turn_recovery",
			}),
			stub("unreadable_tool_call"),
			assistant([call], { reasoningLoop: { kind: "phrase-cycle" } }),
			assistant([
				{
					type: "thinking",
					thinking: "so the fix is... I have used my thinking budget.",
				},
				call,
			]),
		]);
		expect(events).toEqual({
			outputLimit: 2,
			thinkingBudget: 1,
			loops: 1,
			unreadableCalls: 1,
		});
	});

	it("counts a loop cut from the reply or a call's arguments as a loop", () => {
		const events = countCapEvents([
			assistant([call], { answerLoop: { kind: "block-cycle" } }),
			assistant([call], {
				argumentLoop: { toolCallId: "c1", verdict: { kind: "block-cycle" } },
			}),
		]);
		expect(events.loops).toBe(2);
	});

	it("is written in the first person and the present tense, and ends on smaller steps", () => {
		const thoughts =
			synthesizeCapThoughts({
				outputLimit: 2,
				thinkingBudget: 0,
				loops: 1,
				unreadableCalls: 0,
			}) ?? "";
		expect(thoughts).toContain("twice my reply runs into the output limit");
		expect(thoughts).toContain("once I catch myself");
		expect(thoughts).toContain("smaller units");
		expect(thoughts).not.toMatch(/\byou\b|\[SYSTEM\]|the model/i);
	});

	it("is shown with the retrospective and not stored as part of it", () => {
		const message = buildSummaryMessage({
			summary: "the replay",
			fileOps: { read: [], modified: [] } as never,
			tokensBefore: 10,
			userRunSpan: 1,
			thinkingSummary: "What is working is narrowing the range.",
			harnessThoughts: "I am also noticing a pattern in how I work on this.",
		});
		const shown = (message.content as Array<{ text?: string }>)
			.map((part) => part.text ?? "")
			.join("");
		expect(shown).toContain("What is working is narrowing the range.");
		expect(shown).toContain("I am also noticing a pattern");
		expect(
			(message.metadata as { thinkingSummary?: string }).thinkingSummary,
		).toBe("What is working is narrowing the range.");
	});
});
