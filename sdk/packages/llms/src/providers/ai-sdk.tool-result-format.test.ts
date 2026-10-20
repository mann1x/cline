import type { AgentMessage, ToolResultFormat } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { toAiSdkMessages } from "./ai-sdk";

// The format is a rendering step: the message is the same, and only what the
// provider is handed differs. Under `json` that must be exactly what it was.

const SOURCE = 'def total(lines):\n    return round(sum(lines), 2)  # "net"\n';

function toolOutput(
	output: unknown,
	format: ToolResultFormat | undefined,
	extra: { note?: string; serialized?: string } = {},
): unknown {
	const messages = [
		{
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "c1",
					toolName: "read_files",
					input: {},
				},
			],
		},
		{
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "c1",
					toolName: "read_files",
					output,
					...extra,
				},
			],
		},
	] as unknown as AgentMessage[];
	const out = toAiSdkMessages(
		messages,
		undefined,
		format ? { toolResultFormat: format } : undefined,
	) as Array<{
		role: string;
		content: Array<{ type: string; output?: unknown }> | string;
	}>;
	const tool = out.find((m) => m.role === "tool");
	return Array.isArray(tool?.content)
		? tool.content.find((p) => p.type === "tool-result")?.output
		: undefined;
}

const entries = [
	{ query: "/abs/src/invoice.py", result: SOURCE, success: true },
];

describe("the tool result format on the wire", () => {
	it("sends json exactly as a session that names no format", () => {
		expect(toolOutput(entries, "json")).toEqual(toolOutput(entries, undefined));
		expect(toolOutput(entries, "json")).toEqual({
			type: "json",
			value: entries,
		});
	});

	it("sends text with the file's own line breaks", () => {
		const output = toolOutput(entries, "text") as {
			type: string;
			value: string;
		};
		expect(output).toEqual({
			type: "text",
			value: `/abs/src/invoice.py\n→ ${SOURCE}`,
		});
		expect(output.value).not.toContain("\\n");
	});

	it("reads a codec-written string back before rendering it", () => {
		const entry = entries[0];
		expect(
			toolOutput(JSON.stringify(entry), "text", { serialized: "json" }),
		).toEqual({ type: "text", value: `/abs/src/invoice.py\n→ ${SOURCE}` });
		// The same string under json is what it always was.
		expect(
			toolOutput(JSON.stringify(entry), "json", { serialized: "json" }),
		).toEqual(toolOutput(JSON.stringify(entry), undefined));
	});

	it("keeps the note after the rendered result", () => {
		expect(toolOutput(entries, "text", { note: "[SYSTEM] note" })).toEqual({
			type: "text",
			value: `/abs/src/invoice.py\n→ ${SOURCE}\n\n[SYSTEM] note`,
		});
	});
});
