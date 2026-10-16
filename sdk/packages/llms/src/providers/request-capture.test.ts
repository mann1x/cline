import { afterEach, describe, expect, it } from "vitest";
import {
	type CapturedModelRequest,
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
});
