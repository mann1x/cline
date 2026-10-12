import { beforeEach, describe, expect, it } from "vitest";
import {
	closeStreamSideParts,
	openStreamSideParts,
	STREAM_SIDE_PARTS_HEADER,
} from "../stream-side-parts";
import { resetXollamaProbes } from "./xollama";
import {
	withXollamaToolCallProgress,
	XOLLAMA_TOOL_CALL_PROGRESS_FEATURE,
} from "./xollama-tool-progress";

const ROOT = "http://xollama.test:22434";

/**
 * The shape xOllama dev (02e34ecc8) sends for one gemma4 call, shortened: the
 * raw text of each held step, delimiters included, `done` with empty text on
 * the chunk that delivers the parsed call, and after it a short held run that
 * was not a call.
 */
const CAPTURED = [
	'{"model":"gemma4:e4b","message":{"role":"assistant","content":"","tool_call_progress":{"index":0,"syntax":"gemma4","text":"<|tool_call>","tokens":1}},"done":false}',
	'{"model":"gemma4:e4b","message":{"role":"assistant","content":"","tool_call_progress":{"index":0,"syntax":"gemma4","text":"call","tokens":2}},"done":false}',
	'{"model":"gemma4:e4b","message":{"role":"assistant","content":"","tool_call_progress":{"index":0,"syntax":"gemma4","text":":write_file{content:<|\\"|>def","tokens":9}},"done":false}',
	'{"model":"gemma4:e4b","message":{"role":"assistant","content":"","tool_calls":[{"id":"call_34nwtu9q","function":{"index":0,"name":"write_file","arguments":{"content":"def"}}}],"tool_call_progress":{"index":0,"syntax":"gemma4","text":"","tokens":436,"done":true}},"done":false}',
	'{"model":"gemma4:e4b","message":{"role":"assistant","content":"","tool_call_progress":{"index":1,"syntax":"gemma4","text":"<|tool_response>","tokens":1}},"done":false}',
	'{"model":"gemma4:e4b","message":{"role":"assistant","content":""},"done":true}',
];

function server(features: string[]) {
	const sent: Array<{ url: string; headers: Headers; body?: string }> = [];
	const fetchImpl = (async (input: string, init?: RequestInit) => {
		const url = String(input);
		sent.push({
			url,
			headers: new Headers(init?.headers),
			...(typeof init?.body === "string" ? { body: init.body } : {}),
		});
		if (url.endsWith("/api/xollama")) {
			return new Response(
				JSON.stringify({ xollama: true, version: "0.40.4", features }),
			);
		}
		// In two pieces that split a line, as a socket would.
		const text = `${CAPTURED.join("\n")}\n`;
		const cut = text.indexOf("write_file{") + 4;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text.slice(0, cut)));
				controller.enqueue(new TextEncoder().encode(text.slice(cut)));
				controller.close();
			},
		});
		return new Response(body);
	}) as unknown as typeof fetch;
	return { fetchImpl, sent };
}

const chat = (queueId: string | undefined, body: Record<string, unknown>) =>
	[
		`${ROOT}/api/chat`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(queueId ? { [STREAM_SIDE_PARTS_HEADER]: queueId } : {}),
			},
			body: JSON.stringify(body),
		},
	] as const;

const tools = [{ type: "function", function: { name: "write_file" } }];

describe("withXollamaToolCallProgress", () => {
	beforeEach(() => {
		resetXollamaProbes();
	});

	it("asks for progress, lifts it into the queue, and hands the rest on", async () => {
		const { fetchImpl, sent } = server([XOLLAMA_TOOL_CALL_PROGRESS_FEATURE]);
		const queue = openStreamSideParts();
		const response = await withXollamaToolCallProgress(fetchImpl)(
			...chat(queue.id, { model: "gemma4:e4b", stream: true, tools }),
		);
		const lines = (await response.text()).trim().split("\n");

		const request = sent.find((call) => call.url.endsWith("/api/chat"));
		expect(JSON.parse(request?.body ?? "{}").tool_call_progress).toBe(true);
		expect(request?.headers.has(STREAM_SIDE_PARTS_HEADER)).toBe(false);

		expect(queue.take()).toEqual([
			{
				type: "tool-input-delta",
				id: "xollama_call_0",
				delta: "<|tool_call>",
			},
			{ type: "tool-input-delta", id: "xollama_call_0", delta: "call" },
			{
				type: "tool-input-delta",
				id: "xollama_call_0",
				delta: ':write_file{content:<|"|>def',
			},
			{ type: "tool-input-end", id: "xollama_call_0" },
			// Held output that was not a call: its own run, and no end.
			{
				type: "tool-input-delta",
				id: "xollama_call_1",
				delta: "<|tool_response>",
			},
		]);
		// Every chunk still arrives, and none of them carries the field.
		expect(lines).toHaveLength(CAPTURED.length);
		expect(lines.join("\n")).not.toContain("tool_call_progress");
		expect(JSON.parse(lines[3] ?? "{}").message.tool_calls[0].id).toBe(
			"call_34nwtu9q",
		);
		closeStreamSideParts(queue);
	});

	it.each([
		["the server does not announce the feature", [], { stream: true, tools }],
		[
			"the request does not stream",
			[XOLLAMA_TOOL_CALL_PROGRESS_FEATURE],
			{ stream: false, tools },
		],
		[
			"the request offers no tools",
			[XOLLAMA_TOOL_CALL_PROGRESS_FEATURE],
			{ stream: true },
		],
	])("does not ask when %s", async (_name, features, body) => {
		const { fetchImpl, sent } = server(features as string[]);
		const queue = openStreamSideParts();
		await withXollamaToolCallProgress(fetchImpl)(
			...chat(queue.id, { model: "m", ...(body as object) }),
		);
		const request = sent.find((call) => call.url.endsWith("/api/chat"));
		expect(request?.body).not.toContain("tool_call_progress");
		// The queue's name is ours and never reaches a server.
		expect(request?.headers.has(STREAM_SIDE_PARTS_HEADER)).toBe(false);
		closeStreamSideParts(queue);
	});

	it("leaves a request that names no queue exactly as it came", async () => {
		const { fetchImpl, sent } = server([XOLLAMA_TOOL_CALL_PROGRESS_FEATURE]);
		const [url, init] = chat(undefined, { model: "m", stream: true, tools });
		await withXollamaToolCallProgress(fetchImpl)(url, init);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.body).toBe(init.body);
	});
});
