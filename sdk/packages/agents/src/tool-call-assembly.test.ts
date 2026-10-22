import type { AgentModelEvent } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { finishToolCalls, ToolCallAssembler } from "./tool-call-assembly";

const editorTool = {
	name: "editor",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string" },
			lines: { type: "array", items: { type: "number" } },
		},
	},
};

describe("finishToolCalls", () => {
	it("assembles streamed fragments into one call, in order with the text", async () => {
		const events: AgentModelEvent[] = [
			{ type: "reasoning-delta", text: "look at " },
			{ type: "reasoning-delta", text: "the file" },
			{ type: "text-delta", text: "Opening it." },
			{
				type: "tool-call-delta",
				index: 0,
				toolCallId: "c1",
				toolName: "read_file",
				inputText: '{"path":',
			},
			{
				type: "tool-call-delta",
				index: 0,
				toolCallId: "c1",
				inputText: '"a.ts"}',
			},
			{ type: "finish", reason: "tool-calls" },
		];
		const turn = await finishToolCalls(events);
		expect(turn.toolCalls).toEqual([
			{
				type: "tool-call",
				toolCallId: "c1",
				toolName: "read_file",
				input: { path: "a.ts" },
				metadata: undefined,
			},
		]);
		expect(turn.content.map((part) => part.type)).toEqual([
			"reasoning",
			"text",
			"tool-call",
		]);
		expect(turn.reasoning).toBe("look at the file");
		expect(turn.invalidToolCalls).toEqual([]);
	});

	it("takes arguments a provider handed over already parsed", async () => {
		const turn = await finishToolCalls([
			{
				type: "tool-call-delta",
				toolCallId: "c1",
				toolName: "read_file",
				input: { path: "b.ts" },
			},
			{ type: "finish", reason: "tool-calls" },
		]);
		expect(turn.toolCalls[0]?.input).toEqual({ path: "b.ts" });
	});

	it("reports invalid JSON as invalid, with the raw text kept", async () => {
		const turn = await finishToolCalls([
			{
				type: "tool-call-delta",
				toolCallId: "c1",
				toolName: "editor",
				inputText: '{"path": "a.ts", "new_text": "say "hi""}',
			},
			{ type: "finish", reason: "tool-calls" },
		]);
		expect(turn.toolCalls).toEqual([]);
		expect(turn.invalidToolCalls[0]).toMatchObject({
			toolCallId: "c1",
			reason: "invalid_arguments",
		});
		const call = turn.content[0] as { metadata?: Record<string, unknown> };
		expect(String(call.metadata?.inputParseError)).toContain(
			"emitted invalid JSON arguments",
		);
		expect(call.metadata?.rawInputText).toBe(
			'{"path": "a.ts", "new_text": "say "hi""}',
		);
	});

	it("says a call was cut off, not malformed, when the turn ended at the cap", async () => {
		const turn = await finishToolCalls([
			{
				type: "tool-call-delta",
				toolCallId: "c1",
				toolName: "editor",
				inputText: '{"path": "a.ts", "new_text": "half a fi',
			},
			{ type: "finish", reason: "max-tokens" },
		]);
		const call = turn.content[0] as { metadata?: Record<string, unknown> };
		expect(String(call.metadata?.inputParseError)).toContain(
			"was cut off by the output budget",
		);
	});

	it("does not run a call that parsed but was the one being written at the cap", async () => {
		// f099u (pandorum, 2026-10-22): xOllama closed an open `editor` call
		// when the 92,662-token cap was reached, its `new_text` mid-statement,
		// and the JSON parsed.
		const turn = await finishToolCalls([
			{
				type: "tool-call-delta",
				toolCallId: "c1",
				toolName: "editor",
				inputText:
					'{"path": "a.ts", "start_line": 1, "new_text": "const ex = e.x"}',
			},
			{ type: "finish", reason: "max-tokens" },
		]);

		expect(turn.toolCalls).toEqual([]);
		expect(turn.invalidToolCalls[0]).toMatchObject({
			toolCallId: "c1",
			reason: "invalid_arguments",
		});
		const call = turn.content[0] as { metadata?: Record<string, unknown> };
		expect(String(call.metadata?.inputParseError)).toContain(
			"was cut off by the output budget: the turn ended at the cap while this call was being written",
		);
	});

	it("runs the calls a capped turn had finished before the last one", async () => {
		const turn = await finishToolCalls([
			{
				type: "tool-call-delta",
				toolCallId: "c1",
				toolName: "editor",
				inputText: '{"path": "a.ts", "new_text": "whole"}',
			},
			{
				type: "tool-call-delta",
				toolCallId: "c2",
				toolName: "editor",
				inputText: '{"path": "b.ts", "new_text": "half"}',
			},
			{ type: "finish", reason: "max-tokens" },
		]);

		expect(turn.toolCalls.map((call) => call.toolCallId)).toEqual(["c1"]);
		expect(turn.invalidToolCalls.map((call) => call.toolCallId)).toEqual([
			"c2",
		]);
	});

	it("runs the last call of a turn that ended for any other reason", async () => {
		const turn = await finishToolCalls([
			{
				type: "tool-call-delta",
				toolCallId: "c1",
				toolName: "editor",
				inputText: '{"path": "a.ts", "new_text": "whole"}',
			},
			{ type: "finish", reason: "tool-calls" },
		]);

		expect(turn.toolCalls.map((call) => call.toolCallId)).toEqual(["c1"]);
	});

	it("reports a call with no name as missing_name and does not return it", async () => {
		const turn = await finishToolCalls([
			{ type: "tool-call-delta", index: 0, inputText: '{"path":"a"}' },
			{ type: "finish", reason: "tool-calls" },
		]);
		expect(turn.toolCalls).toEqual([]);
		expect(turn.content).toEqual([]);
		expect(turn.invalidToolCalls[0]?.reason).toBe("missing_name");
	});

	it("treats empty arguments as an empty input", async () => {
		const turn = await finishToolCalls([
			{ type: "tool-call-delta", toolCallId: "c1", toolName: "list_files" },
			{ type: "finish", reason: "tool-calls" },
		]);
		expect(turn.toolCalls[0]?.input).toEqual({});
	});

	it("normalises JSON-like strings against the tool's schema, as the runtime does before running", async () => {
		const events: AgentModelEvent[] = [
			{
				type: "tool-call-delta",
				toolCallId: "c1",
				toolName: "editor",
				input: { path: "a.ts", lines: "[1, 2]" },
			},
			{ type: "finish", reason: "tool-calls" },
		];
		const plain = await finishToolCalls(events);
		expect(plain.toolCalls[0]?.input).toEqual({
			path: "a.ts",
			lines: "[1, 2]",
		});
		const normalised = await finishToolCalls(events, { tools: [editorTool] });
		expect(normalised.toolCalls[0]?.input).toEqual({
			path: "a.ts",
			lines: [1, 2],
		});
	});

	it("finds a call the model wrote as text when the turn made none", async () => {
		const turn = await finishToolCalls([
			{
				type: "text-delta",
				text: "<tool_call>\n<function=read_file>\n<parameter=path>\na.ts\n</parameter>\n</function>\n</tool_call>",
			},
			{ type: "finish", reason: "stop" },
		]);
		expect(turn.toolCalls).toEqual([]);
		expect(turn.unparsedToolCall).toMatchObject({
			dialect: "qwen",
			name: "read_file",
		});
	});

	it("reads an async stream and keeps the provider's error", async () => {
		async function* stream(): AsyncIterable<AgentModelEvent> {
			yield { type: "text-delta", text: "partial" };
			yield { type: "finish", reason: "error", error: "upstream 500" };
		}
		const turn = await finishToolCalls(stream());
		expect(turn.finishReason).toBe("error");
		expect(turn.error).toBe("upstream 500");
	});

	it("leaves provider-executed calls out", async () => {
		const turn = await finishToolCalls([
			{
				type: "tool-call-delta",
				toolCallId: "p1",
				toolName: "web_search",
				input: { q: "x" },
				execution: "provider" as never,
			},
			{ type: "finish", reason: "stop" },
		]);
		expect(turn.toolCalls).toEqual([]);
	});
});

describe("ToolCallAssembler", () => {
	it("keys calls without an id or index in arrival order", () => {
		const assembler = new ToolCallAssembler();
		const first = assembler.add({
			type: "tool-call-delta",
			toolName: "a",
			inputText: "{}",
		});
		const second = assembler.add({
			type: "tool-call-delta",
			toolName: "b",
			inputText: "{}",
		});
		expect(first.created && second.created).toBe(true);
		expect(first.key).not.toBe(second.key);
		expect(assembler.inputChars()).toBe(4);
	});

	it("replaces rather than appends a delta that restates the whole object", () => {
		const assembler = new ToolCallAssembler();
		assembler.add({
			type: "tool-call-delta",
			toolCallId: "c1",
			toolName: "a",
			inputText: '{"x":',
		});
		assembler.add({
			type: "tool-call-delta",
			toolCallId: "c1",
			inputText: '{"x":1}',
		});
		expect(assembler.finish("c1").call?.input).toEqual({ x: 1 });
	});
});
