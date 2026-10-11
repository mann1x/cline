import type { AgentMessage } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { toAiSdkMessages } from "./ai-sdk";

/**
 * A summary, the retrospective turn the harness wrote after it, and a kept
 * tail whose last turn has reasoning of its own.
 */
const messages = [
	{ role: "user", content: [{ type: "text", text: "Context summary" }] },
	{
		role: "assistant",
		content: [
			{ type: "reasoning", text: "What keeps costing me is rewriting." },
			{ type: "text", text: "I am picking the work back up from here." },
		],
		metadata: { kind: "compaction_retrospective", pinnedReasoning: true },
	},
	{
		role: "assistant",
		content: [
			{ type: "reasoning", text: "an older thought" },
			{ type: "text", text: "reading" },
		],
	},
	{
		role: "assistant",
		content: [
			{ type: "reasoning", text: "the newest thought" },
			{ type: "text", text: "editing" },
		],
	},
] as unknown as AgentMessage[];

function sent(scope: "last" | "none" | "all", channel?: "inline") {
	const out = toAiSdkMessages(messages, undefined, {
		reasoningHistory: channel ? { scope, channel } : scope,
	} as never) as Array<{
		role: string;
		content: Array<{ type: string; text?: string }> | string;
	}>;
	return out
		.filter((m) => m.role === "assistant")
		.map((m) =>
			Array.isArray(m.content)
				? m.content.map((p) => `${p.type}:${(p.text ?? "").trim()}`)
				: [`text:${m.content}`],
		);
}

describe("reasoning the harness pinned to a turn", () => {
	it("is sent as reasoning under `last`, although it is not the newest", () => {
		const [retrospective, older, newest] = sent("last");
		expect(retrospective).toContain(
			"reasoning:What keeps costing me is rewriting.",
		);
		expect(older.some((p) => p.startsWith("reasoning:"))).toBe(false);
		expect(newest).toContain("reasoning:the newest thought");
	});

	it("goes out as the turn's text where reasoning is not replayed at all", () => {
		const [retrospective, older, newest] = sent("none");
		expect(retrospective.some((p) => p.startsWith("reasoning:"))).toBe(false);
		expect(retrospective.join("\n")).toContain(
			"What keeps costing me is rewriting.",
		);
		expect(older.join("\n")).not.toContain("an older thought");
		expect(newest.join("\n")).not.toContain("the newest thought");
	});

	it("is never offered as unsigned reasoning under `all`", () => {
		const [retrospective] = sent("all");
		expect(retrospective.some((p) => p.startsWith("reasoning:"))).toBe(false);
		expect(retrospective.join("\n")).toContain(
			"What keeps costing me is rewriting.",
		);
	});
});
