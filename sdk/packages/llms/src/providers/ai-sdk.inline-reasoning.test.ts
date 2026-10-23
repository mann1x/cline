import type { AgentMessage } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { toAiSdkMessages } from "./ai-sdk";

/**
 * Reasoning folded into the assistant's text, for a template that drops the
 * field. Gemma-4's renders an assistant's text after its tool response and as
 * the text that closes the turn, so a block inlined into a tool-calling turn
 * broke the prompt's structure (automaticum #1845).
 */
function sent(messages: unknown[]) {
	const out = toAiSdkMessages(messages as AgentMessage[], undefined, {
		reasoningHistory: { scope: "last", channel: "inline" },
	} as never) as Array<{
		role: string;
		content: Array<{ type: string; text?: string }> | string;
	}>;
	return out.filter((m) => m.role === "assistant");
}

describe("inlined reasoning", () => {
	it("is never put into a turn that calls a tool", () => {
		const [turn] = sent([
			{ role: "user", content: [{ type: "text", text: "fix it" }] },
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "read the file first" },
					{
						type: "tool-call",
						toolCallId: "c1",
						toolName: "read_files",
						input: { path: "x" },
					},
				],
			},
		]);
		const parts = turn.content as Array<{ type: string; text?: string }>;
		expect(parts.map((part) => part.type)).toEqual(["tool-call"]);
		expect(JSON.stringify(parts)).not.toContain("read the file first");
	});

	it("still goes into a turn that only answers", () => {
		const [turn] = sent([
			{ role: "user", content: [{ type: "text", text: "explain" }] },
			{
				role: "assistant",
				content: [
					{ type: "reasoning", text: "keep it short" },
					{ type: "text", text: "Here it is." },
				],
			},
		]);
		const parts = turn.content as Array<{ type: string; text?: string }>;
		expect(parts).toEqual([
			{ type: "text", text: "<think>keep it short</think>\nHere it is." },
		]);
	});
});
