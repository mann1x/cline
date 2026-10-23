import { afterEach, describe, expect, it } from "vitest";
import {
	type CapturedModelRequest,
	type CapturedModelResponse,
	setModelRequestCapture,
	withModelRequestCapture,
} from "./request-capture";

afterEach(() => setModelRequestCapture(undefined));

const ok = (async () => new Response("{}")) as unknown as typeof fetch;

describe("withModelRequestCapture", () => {
	it("passes requests through untouched while no writer is installed", async () => {
		let sent: RequestInit | undefined;
		const base = (async (_input: unknown, init?: RequestInit) => {
			sent = init;
			return new Response("{}");
		}) as unknown as typeof fetch;
		const init = { method: "POST", body: '{"model":"m"}' };
		await withModelRequestCapture(base, "s")("http://x/api/chat", init);
		expect(sent).toBe(init);
	});

	it("saves a generation request's body, parsed, with no headers", async () => {
		const saved: CapturedModelRequest[] = [];
		setModelRequestCapture((request) => saved.push(request));
		await withModelRequestCapture(ok, "conv-1")(
			"http://pandorum:22434/api/chat",
			{
				method: "POST",
				headers: { authorization: "Bearer secret" },
				body: JSON.stringify({
					model: "m",
					messages: [{ role: "user", content: "hi" }],
				}),
			},
		);
		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			url: "http://pandorum:22434/api/chat",
			method: "POST",
			sessionId: "conv-1",
			body: { model: "m", messages: [{ role: "user", content: "hi" }] },
		});
		expect(JSON.stringify(saved[0])).not.toContain("secret");
	});

	it("leaves probes and lists out", async () => {
		const saved: CapturedModelRequest[] = [];
		setModelRequestCapture((request) => saved.push(request));
		const wire = withModelRequestCapture(ok);
		await wire("http://x/api/show", { method: "POST", body: "{}" });
		await wire("http://x/api/engine?endpoint=tokenize", {
			method: "POST",
			body: "{}",
		});
		await wire("http://x/api/tags", { method: "GET" });
		await wire("http://x/v1/chat/completions", { method: "POST", body: "{}" });
		expect(saved.map((request) => request.url)).toEqual([
			"http://x/v1/chat/completions",
		]);
	});

	it("saves a request once when two capturing layers see it", async () => {
		const saved: CapturedModelRequest[] = [];
		setModelRequestCapture((request) => saved.push(request));
		const wire = withModelRequestCapture(withModelRequestCapture(ok));
		await wire("http://x/api/chat", { method: "POST", body: "{}" });
		expect(saved).toHaveLength(1);
	});

	it("sends the request even when the writer throws", async () => {
		setModelRequestCapture(() => {
			throw new Error("disk full");
		});
		const response = await withModelRequestCapture(ok)("http://x/api/chat", {
			method: "POST",
			body: "{}",
		});
		expect(response.ok).toBe(true);
	});

	describe("responses", () => {
		const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
		// Pull-driven, as a socket is: each chunk is read before the next one
		// arrives, so a failure lands after what came before it was delivered.
		const streamOf = (chunks: string[], failAfter?: number) => {
			const encoder = new TextEncoder();
			let index = 0;
			return new ReadableStream<Uint8Array>({
				pull(controller) {
					if (failAfter === index) {
						controller.error(new Error("socket hang up"));
						return;
					}
					if (index >= chunks.length) {
						controller.close();
						return;
					}
					controller.enqueue(encoder.encode(chunks[index]));
					index += 1;
				},
			});
		};

		it("saves the raw stream beside the request, and the caller still reads it", async () => {
			const responses: CapturedModelResponse[] = [];
			setModelRequestCapture(
				() => (response: CapturedModelResponse) => responses.push(response),
			);
			const chunks = [
				'{"message":{"thinking":"plan"}}\n',
				'{"message":{"content":"done"},"done":true}\n',
			];
			const base = (async () =>
				new Response(streamOf(chunks), {
					status: 200,
				})) as unknown as typeof fetch;
			const response = await withModelRequestCapture(base, "s")(
				"http://x/api/chat",
				{ method: "POST", body: "{}" },
			);
			expect(await response.text()).toBe(chunks.join(""));
			await settle();
			expect(responses).toEqual([
				expect.objectContaining({
					status: 200,
					body: chunks.join(""),
					complete: true,
				}),
			]);
		});

		it("keeps what arrived when the stream is cut off", async () => {
			const responses: CapturedModelResponse[] = [];
			setModelRequestCapture(
				() => (response: CapturedModelResponse) => responses.push(response),
			);
			const base = (async () =>
				new Response(
					streamOf(['data: {"a":1}\n\n', 'data: {"a":2}\n\n'], 1),
				)) as unknown as typeof fetch;
			const response = await withModelRequestCapture(base)(
				"http://x/v1/chat/completions",
				{ method: "POST", body: "{}" },
			);
			await response.text().catch(() => undefined);
			await settle();
			expect(responses[0]).toMatchObject({
				body: 'data: {"a":1}\n\n',
				complete: false,
				error: "socket hang up",
			});
		});

		it("records a request that never got an answer, and still throws", async () => {
			const responses: CapturedModelResponse[] = [];
			setModelRequestCapture(
				() => (response: CapturedModelResponse) => responses.push(response),
			);
			const base = (async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch;
			await expect(
				withModelRequestCapture(base)("http://x/api/chat", {
					method: "POST",
					body: "{}",
				}),
			).rejects.toThrow("ECONNREFUSED");
			expect(responses[0]).toMatchObject({
				status: 0,
				complete: false,
				error: "ECONNREFUSED",
			});
		});

		it("hands back the response untouched for a writer that does not ask for one", async () => {
			const original = new Response("{}");
			const base = (async () => original) as unknown as typeof fetch;
			const saved: CapturedModelRequest[] = [];
			setModelRequestCapture((request) => saved.push(request));
			const response = await withModelRequestCapture(base)(
				"http://x/api/chat",
				{
					method: "POST",
					body: "{}",
				},
			);
			expect(saved).toHaveLength(1);
			expect(response).toBe(original);
		});

		it("saves what the reader got when it cancels", async () => {
			const responses: CapturedModelResponse[] = [];
			setModelRequestCapture(
				() => (response: CapturedModelResponse) => responses.push(response),
			);
			const base = (async () =>
				new Response(streamOf(["a", "b", "c"]))) as unknown as typeof fetch;
			const response = await withModelRequestCapture(base)(
				"http://x/api/chat",
				{
					method: "POST",
					body: "{}",
				},
			);
			const reader = response.body!.getReader();
			await reader.read();
			await reader.cancel("aborted by the agent");
			expect(responses[0]).toMatchObject({
				body: "a",
				complete: false,
				error: "aborted by the agent",
			});
		});

		it("keeps status, headers and url", async () => {
			setModelRequestCapture(() => () => undefined);
			const original = new Response("{}", {
				status: 201,
				headers: { "x-request-id": "r1" },
			});
			Object.defineProperty(original, "url", { value: "http://x/api/chat" });
			const base = (async () => original) as unknown as typeof fetch;
			const response = await withModelRequestCapture(base)(
				"http://x/api/chat",
				{
					method: "POST",
					body: "{}",
				},
			);
			expect(response.status).toBe(201);
			expect(response.headers.get("x-request-id")).toBe("r1");
			expect(response.url).toBe("http://x/api/chat");
		});
	});
});
