import type { AgentMessage } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { toAiSdkMessages } from "./ai-sdk";

// The harness's mid-run notes ride on a tool result instead of following it as
// a user message: on gemma4 a user turn drops all of the model's earlier
// reasoning from the prompt (pandorum, 2026-10-19).

const PNG_1X1 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function toolOutput(output: unknown, note?: string): unknown {
	const messages = [
		{
			role: "assistant",
			content: [
				{ type: "tool-call", toolCallId: "c1", toolName: "editor", input: {} },
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "c1",
					toolName: "editor",
					output,
					note,
				},
			],
		},
	] as unknown as AgentMessage[];
	const out = toAiSdkMessages(messages) as Array<{
		role: string;
		content: Array<{ type: string; output?: unknown }> | string;
	}>;
	const tool = out.find((m) => m.role === "tool");
	return Array.isArray(tool?.content)
		? tool.content.find((p) => p.type === "tool-result")?.output
		: undefined;
}

describe("a note on a tool result", () => {
	it("follows a structured output, which is serialized as before", () => {
		expect(toolOutput({ success: true }, "[SYSTEM] note")).toEqual({
			type: "text",
			value: '{"success":true}\n\n[SYSTEM] note',
		});
	});

	it("follows a text output", () => {
		expect(toolOutput("Replaced line 9", "[SYSTEM] note")).toEqual({
			type: "text",
			value: "Replaced line 9\n\n[SYSTEM] note",
		});
	});

	it("is an entry of its own beside an image, which is never flattened into JSON", () => {
		const image = { type: "image", image: PNG_1X1, mediaType: "image/png" };
		const output = toolOutput([image], "[SYSTEM] note") as { value: unknown[] };
		expect(output.value).toHaveLength(2);
		expect(JSON.stringify(output.value[0])).not.toContain("[SYSTEM] note");
		expect(JSON.stringify(output.value[1])).toContain("[SYSTEM] note");
	});

	it("leaves a result without one exactly as it was", () => {
		expect(toolOutput({ success: true })).toEqual({
			type: "json",
			value: { success: true },
		});
	});
});
