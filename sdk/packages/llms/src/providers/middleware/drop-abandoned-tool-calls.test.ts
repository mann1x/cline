import type {
	LanguageModelV4,
	LanguageModelV4CallOptions,
	LanguageModelV4StreamPart,
} from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { describe, expect, it } from "vitest";
import {
	createDropAbandonedToolCallsMiddleware,
	readAbandonedToolCalls,
} from "./drop-abandoned-tool-calls";

// The shape of opencoti dev 2610172051001 (#1604): the call's raw text as a
// content delta, the marker on that same chunk, and the list on the last one.
const MARKER = {
	index: 0,
	id: "call_1",
	name: "read_files",
	reason: "unparsable",
	channel: "content",
};

function fakeModel(
	parts: LanguageModelV4StreamPart[],
	seen: LanguageModelV4CallOptions[],
): LanguageModelV4 {
	return {
		specificationVersion: "v4",
		provider: "test",
		modelId: "test",
		supportedUrls: {},
		doGenerate: async () => {
			throw new Error("not used");
		},
		doStream: async (options: LanguageModelV4CallOptions) => {
			seen.push(options);
			return {
				stream: new ReadableStream<LanguageModelV4StreamPart>({
					start(controller) {
						for (const part of parts) {
							if (part.type === "raw" && options.includeRawChunks !== true) {
								continue;
							}
							controller.enqueue(part);
						}
						controller.close();
					},
				}),
			};
		},
	} as unknown as LanguageModelV4;
}

async function drain(
	model: LanguageModelV4,
	options: Partial<LanguageModelV4CallOptions> = {},
): Promise<LanguageModelV4StreamPart[]> {
	const { stream } = await model.doStream({
		prompt: [],
		...options,
	} as LanguageModelV4CallOptions);
	const out: LanguageModelV4StreamPart[] = [];
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			return out;
		}
		out.push(value);
	}
}

const rawText =
	'<tool_call>{"name":"read_files","arguments":{"path":"c:\\Users';

function abandonedStream(
	marker: "delta" | "final",
): LanguageModelV4StreamPart[] {
	return [
		{ type: "tool-input-start", id: "call_1", toolName: "read_files" },
		{ type: "tool-input-delta", id: "call_1", delta: '{"path":"c:' },
		{
			type: "raw",
			rawValue: {
				choices: [
					{
						delta: {
							content: rawText,
							...(marker === "delta" ? { x_tool_call_abandoned: MARKER } : {}),
						},
					},
				],
			},
		},
		{ type: "text-delta", id: "t", delta: rawText },
		{
			type: "raw",
			rawValue: {
				choices: [
					{
						finish_reason: "stop",
						delta: {},
						...(marker === "final" ? { x_tool_calls_abandoned: [MARKER] } : {}),
					},
				],
			},
		},
		{
			type: "tool-call",
			toolCallId: "call_1",
			toolName: "read_files",
			input: '{"path":"c:',
		},
		{
			type: "tool-call",
			toolCallId: "call_2",
			toolName: "list_files",
			input: "{}",
		},
	] as LanguageModelV4StreamPart[];
}

describe("drop abandoned tool calls", () => {
	it("reads the marker on the delta and the final list", () => {
		expect(
			readAbandonedToolCalls({
				choices: [{ delta: { x_tool_call_abandoned: MARKER } }],
			}),
		).toEqual([MARKER]);
		expect(
			readAbandonedToolCalls({
				choices: [{ delta: {}, x_tool_calls_abandoned: [MARKER] }],
			}),
		).toEqual([MARKER]);
		expect(readAbandonedToolCalls({ choices: [{ delta: {} }] })).toEqual([]);
		expect(readAbandonedToolCalls("data")).toEqual([]);
	});

	for (const marker of ["delta", "final"] as const) {
		it(`drops the partial call named on the ${marker} and keeps the text and the others`, async () => {
			const seen: LanguageModelV4CallOptions[] = [];
			const abandoned: unknown[] = [];
			const model = wrapLanguageModel({
				model: fakeModel(abandonedStream(marker), seen),
				middleware: createDropAbandonedToolCallsMiddleware({
					onAbandoned: (call) => abandoned.push(call),
				}),
			});
			const parts = await drain(model);
			expect(seen[0]?.includeRawChunks).toBe(true);
			expect(parts.some((p) => p.type === "raw")).toBe(false);
			expect(
				parts
					.filter((p) => p.type === "tool-call")
					.map((p) => (p as { toolCallId: string }).toolCallId),
			).toEqual(["call_2"]);
			expect(
				parts.find((p) => p.type === "text-delta") as { delta: string },
			).toMatchObject({ delta: rawText });
			expect(abandoned).toEqual([MARKER]);
		});
	}

	it("passes raw chunks on to a caller that asked for them", async () => {
		const model = wrapLanguageModel({
			model: fakeModel(abandonedStream("delta"), []),
			middleware: createDropAbandonedToolCallsMiddleware(),
		});
		const parts = await drain(model, { includeRawChunks: true });
		expect(parts.filter((p) => p.type === "raw")).toHaveLength(2);
	});

	it("drops it from the real openai-compatible provider's stream, by the server's id", async () => {
		const sse = [
			{
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "read_files", arguments: '{"path":"c:' },
								},
							],
						},
					},
				],
			},
			{
				choices: [
					{
						index: 0,
						delta: { content: rawText, x_tool_call_abandoned: MARKER },
					},
				],
			},
			{
				choices: [
					{
						index: 0,
						delta: {},
						finish_reason: "stop",
						x_tool_calls_abandoned: [MARKER],
					},
				],
			},
		]
			.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
			.concat("data: [DONE]\n\n")
			.join("");
		const fetch = (async () =>
			new Response(sse, {
				headers: { "content-type": "text/event-stream" },
			})) as unknown as typeof globalThis.fetch;
		const { createOpenAICompatible } = await import(
			"@ai-sdk/openai-compatible"
		);
		const provider = createOpenAICompatible({
			name: "opencoti",
			baseURL: "http://opencoti.test/v1",
			fetch,
		});
		const unwrapped = await drain(provider("m") as unknown as LanguageModelV4);
		// Without the middleware the provider reports the partial as a call.
		expect(
			unwrapped
				.filter((p) => p.type === "tool-call")
				.map((p) => (p as { toolCallId: string }).toolCallId),
		).toEqual(["call_1"]);
		const model = wrapLanguageModel({
			model: provider("m") as unknown as LanguageModelV4,
			middleware: createDropAbandonedToolCallsMiddleware(),
		});
		const parts = await drain(model);
		expect(parts.filter((p) => p.type === "tool-call")).toEqual([]);
		expect(
			parts
				.filter((p) => p.type === "text-delta")
				.map((p) => (p as { delta: string }).delta)
				.join(""),
		).toBe(rawText);
		expect(parts.at(-1)).toMatchObject({ type: "finish" });
	});

	it("leaves a stream with no marker as it was", async () => {
		const parts = abandonedStream("delta").map((p) =>
			p.type === "raw"
				? { type: "raw" as const, rawValue: { choices: [] } }
				: p,
		);
		const model = wrapLanguageModel({
			model: fakeModel(parts, []),
			middleware: createDropAbandonedToolCallsMiddleware(),
		});
		const out = await drain(model);
		expect(out.filter((p) => p.type === "tool-call")).toHaveLength(2);
	});
});
