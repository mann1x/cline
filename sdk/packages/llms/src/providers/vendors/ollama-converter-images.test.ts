import { createOllama } from "ollama-ai-provider-v2";
import { describe, expect, it } from "vitest";

/**
 * Pins the vendored patch to `ollama-ai-provider-v2`.
 *
 * Its `convertToOllamaChatMessages` writes `content` and nothing else for a
 * `role:"tool"` message, so image parts inside a tool result were lost on the
 * way to a wire format that has a field for them. The patch fills that field.
 *
 * This is the kind of thing that disappears without a sound: a dependency bump
 * that drops the patch would restore the old converter, the images would go
 * back to being JSON-stringified base64 in the tool text, and nothing would
 * fail until someone read a transcript and found the model describing a
 * screenshot it had never seen.
 */
async function bodyFor(prompt: unknown): Promise<{
	messages: { role: string; content?: string; images?: string[] }[];
}> {
	let captured: string | undefined;
	const provider = createOllama({
		baseURL: "http://localhost:11434/api",
		fetch: (async (_input: unknown, init: RequestInit) => {
			captured = init.body as string;
			return new Response(
				`${JSON.stringify({
					model: "test",
					message: { role: "assistant", content: "ok" },
					done: true,
					done_reason: "stop",
				})}\n`,
				{ status: 200, headers: { "content-type": "application/x-ndjson" } },
			);
		}) as unknown as typeof fetch,
	});
	const model = provider.chat("test");
	const result = await model.doStream({
		prompt,
		includeRawChunks: false,
	} as never);
	// The body is captured on dispatch; draining keeps the stream from being
	// left open.
	const reader = (
		result as { stream: ReadableStream<unknown> }
	).stream.getReader();
	for (;;) {
		const { done } = await reader.read();
		if (done) {
			break;
		}
	}
	return JSON.parse(captured ?? "{}");
}

const screenshot = Buffer.alloc(64, 7).toString("base64");

describe("ollama tool-result images", () => {
	it("puts an image from a tool result onto the tool message", async () => {
		const body = await bodyFor([
			{ role: "user", content: [{ type: "text", text: "look" }] },
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call_1",
						toolName: "browser",
						input: "{}",
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "browser",
						output: {
							type: "content",
							value: [
								{ type: "text", text: "open: http://localhost" },
								{
									type: "file",
									mediaType: "image/png",
									data: { type: "data", data: screenshot },
								},
							],
						},
					},
				],
			},
		]);

		const tool = body.messages.find((message) => message.role === "tool");
		expect(tool?.images).toEqual([screenshot]);
		// And the bytes are not also sitting in the text, which is the failure
		// the whole arrangement exists to avoid.
		expect(tool?.content).not.toContain(screenshot);
		expect(tool?.content).toContain("open: http://localhost");
	});

	it("adds no user message of its own", async () => {
		// The reason this path exists at all: a user message here moves the
		// template's last-user-turn marker and deletes the assistant's reasoning
		// history from the prompt.
		const body = await bodyFor([
			{ role: "user", content: [{ type: "text", text: "look" }] },
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call_1",
						toolName: "browser",
						input: "{}",
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "browser",
						output: {
							type: "content",
							value: [
								{
									type: "file",
									mediaType: "image/png",
									data: { type: "data", data: screenshot },
								},
							],
						},
					},
				],
			},
		]);

		expect(
			body.messages.filter((message) => message.role === "user"),
		).toHaveLength(1);
		expect(body.messages.at(-1)?.role).toBe("tool");
	});

	it("leaves a text-only tool result exactly as it was", async () => {
		const body = await bodyFor([
			{ role: "user", content: [{ type: "text", text: "read it" }] },
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "call_1",
						toolName: "read_files",
						input: "{}",
					},
				],
			},
			{
				role: "tool",
				content: [
					{
						type: "tool-result",
						toolCallId: "call_1",
						toolName: "read_files",
						output: { type: "text", value: "file contents" },
					},
				],
			},
		]);

		const tool = body.messages.find((message) => message.role === "tool");
		expect(tool?.content).toBe("file contents");
		expect(tool?.images).toBeUndefined();
	});
});
