import type {
	ApiHandler,
	ApiStreamChunk,
	HandlerModelInfo,
	Message,
} from "@cline/llms";
import type { AgentMessage, AgentModelRequest } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	agentMessagesToMessages,
	messagesToAgentMessages,
} from "../../runtime/config/agent-message-codec";
import { createAgentModelFromApiHandler } from "./apihandler-agent-model-adapter";

// The harness's mid-run notes ride on a tool result, beside its output, instead
// of following it as a user message (pandorum, 2026-10-19).

const messages = [
	{
		id: "1",
		role: "user",
		content: [{ type: "text", text: "fix it" }],
		createdAt: 0,
	},
	{
		id: "2",
		role: "assistant",
		content: [
			{ type: "tool-call", toolCallId: "c1", toolName: "editor", input: {} },
		],
		createdAt: 1,
	},
	{
		id: "3",
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: "c1",
				toolName: "editor",
				output: { success: true },
				note: "[SYSTEM] Task progress (1/2 done)",
			},
		],
		createdAt: 2,
	},
] as unknown as AgentMessage[];

describe("a note on a tool result", () => {
	it("is stored beside the output and comes back on reopen", () => {
		const stored = agentMessagesToMessages(messages);
		const block = JSON.stringify(stored);
		expect(block).toContain('"note":"[SYSTEM] Task progress (1/2 done)"');
		const reopened = messagesToAgentMessages(stored);
		const part = reopened
			.flatMap((m) => m.content)
			.find((p) => p.type === "tool-result");
		expect(part).toMatchObject({ note: "[SYSTEM] Task progress (1/2 done)" });
	});

	it("is joined to the result a custom handler is sent, and never sent as a user turn", async () => {
		const sent: Message[][] = [];
		const handler: ApiHandler = {
			getMessages: () => [],
			getModel: (): HandlerModelInfo => ({ id: "m", info: { id: "m" } }),
			async *createMessage(
				_system: string,
				input: Message[],
			): AsyncGenerator<ApiStreamChunk> {
				sent.push(input);
				yield { type: "text", text: "ok", id: "x" };
			},
		};
		const model = createAgentModelFromApiHandler(handler);
		const request: AgentModelRequest = {
			systemPrompt: "sys",
			messages,
			tools: [],
		};
		for await (const _event of await model.stream(request)) {
			// drain
		}
		const results = sent[0]?.flatMap((m) =>
			typeof m.content === "string"
				? []
				: m.content.filter((b) => b.type === "tool_result"),
		);
		expect(results?.[0]).toMatchObject({
			content: '{"success":true}\n\n[SYSTEM] Task progress (1/2 done)',
		});
		expect(results?.[0]).not.toHaveProperty("note");
		expect(sent[0]?.filter((m) => m.role === "user")).toHaveLength(2);
	});
});
