import type { AgentMessage, MessageWithMetadata } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	flattenToolResultContent,
	serializeConversation,
} from "../extensions/context/compaction-shared";
import { buildToolLedger } from "../extensions/context/tool-ledger";
import {
	agentMessageToMessageWithMetadata,
	messagesToAgentMessages,
} from "../runtime/config/agent-message-codec";
import { MessageBuilder } from "./services/message-builder";
import {
	pinToolResultFormat,
	TOOL_RESULT_FORMAT_METADATA_KEY,
} from "./tool-result-format-pin";

// A single `editor` entry is the case the codec has to mark: an object that is
// not an array is stored as its JSON, and only the mark tells it apart from a
// tool that printed JSON of its own.
const SOURCE = 'def total(lines):\n    return round(sum(lines), 2)  # "net"\n';
const ENTRY = { query: "/abs/src/invoice.py", result: SOURCE, success: true };

function toolTurn(output: unknown): AgentMessage[] {
	return [
		{
			id: "a1",
			role: "assistant",
			content: [
				{
					type: "tool-call",
					toolCallId: "c1",
					toolName: "editor",
					input: { path: "/abs/src/invoice.py" },
				},
			],
		},
		{
			id: "t1",
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "c1",
					toolName: "editor",
					output,
				},
			],
		},
	] as unknown as AgentMessage[];
}

function persisted(output: unknown): MessageWithMetadata[] {
	return toolTurn(output).map((message) =>
		agentMessageToMessageWithMetadata(message),
	);
}

function resultBlock(messages: MessageWithMetadata[]) {
	for (const message of messages) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "tool_result") return block;
		}
	}
	throw new Error("no tool_result");
}

describe("the codec's serialization mark", () => {
	it("marks an object it wrote as JSON, and nothing else", () => {
		expect(resultBlock(persisted(ENTRY)).serialized).toBe("json");
		expect(resultBlock(persisted([ENTRY])).serialized).toBeUndefined();
		expect(
			resultBlock(persisted('{"printed": true}')).serialized,
		).toBeUndefined();
	});

	it("survives a restore and a second write", () => {
		const first = persisted(ENTRY);
		const restored = messagesToAgentMessages(first);
		const again = restored.map((message) =>
			agentMessageToMessageWithMetadata(message),
		);
		expect(resultBlock(again).serialized).toBe("json");
		expect(resultBlock(again).content).toBe(resultBlock(first).content);
	});
});

describe("the compaction record", () => {
	it("is unchanged under json", () => {
		const block = resultBlock(persisted(ENTRY));
		expect(flattenToolResultContent(block.content, { format: "json" })).toBe(
			flattenToolResultContent(block.content),
		);
		expect(serializeConversation(persisted(ENTRY), "json")).toBe(
			serializeConversation(persisted(ENTRY)),
		);
	});

	it("reads a marked result the way the model read it under text", () => {
		const block = resultBlock(persisted(ENTRY));
		expect(
			flattenToolResultContent(block.content, {
				format: "text",
				serialized: block.serialized,
			}),
		).toBe(`/abs/src/invoice.py\n→ ${SOURCE}`);
	});
});

describe("the tool ledger under text", () => {
	it("quotes the result and not its escapes", () => {
		const [entry] = buildToolLedger(persisted(ENTRY), {
			toolResultFormat: "text",
		});
		expect(entry?.result).toContain("return round(sum(lines), 2)");
		expect(entry?.result).not.toContain("\\n");
	});

	it("is unchanged under json", () => {
		expect(
			buildToolLedger(persisted(ENTRY), { toolResultFormat: "json" }),
		).toEqual(buildToolLedger(persisted(ENTRY)));
	});
});

describe("the message builder under text", () => {
	it("cuts an oversized marked result inside its values, so it still parses", () => {
		const big = { ...ENTRY, result: "x".repeat(5_000) };
		const builder = new MessageBuilder({
			maxToolResultChars: 1_000,
			toolResultFormat: "text",
		});
		const [, result] = builder.buildForApi(
			persisted(big) as never,
		) as MessageWithMetadata[];
		const block = resultBlock([result as MessageWithMetadata]);
		expect(typeof block.content).toBe("string");
		const parsed = JSON.parse(block.content as string) as { result: string };
		expect(parsed.result.length).toBeLessThan(5_000);
	});

	it("cuts it as it always did under json", () => {
		const big = { ...ENTRY, result: "x".repeat(5_000) };
		const json = new MessageBuilder({ maxToolResultChars: 1_000 });
		const named = new MessageBuilder({
			maxToolResultChars: 1_000,
			toolResultFormat: "json",
		});
		expect(named.buildForApi(persisted(big) as never)).toEqual(
			json.buildForApi(persisted(big) as never),
		);
	});
});

describe("the session's pinned format", () => {
	it("is the setting for a new conversation", () => {
		expect(pinToolResultFormat({ hasHistory: false, configured: "text" })).toBe(
			"text",
		);
		expect(pinToolResultFormat({ hasHistory: false })).toBe("json");
	});

	it("is what a resumed conversation recorded, whatever the setting says now", () => {
		expect(
			pinToolResultFormat({
				stored: { [TOOL_RESULT_FORMAT_METADATA_KEY]: "text" },
				hasHistory: true,
				configured: "json",
			}),
		).toBe("text");
		expect(
			pinToolResultFormat({
				stored: { [TOOL_RESULT_FORMAT_METADATA_KEY]: "json" },
				hasHistory: true,
				configured: "text",
			}),
		).toBe("json");
	});

	it("is json for a conversation that began before the setting existed", () => {
		expect(
			pinToolResultFormat({ stored: {}, hasHistory: true, configured: "text" }),
		).toBe("json");
	});
});
