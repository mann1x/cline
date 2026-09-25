import { beforeEach, describe, expect, it } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import {
	OPENCOTI_KEEPALIVE_PING_SECONDS,
	requestStreamKeepalive,
	statusOfStreamError,
	superviseKeepaliveStream,
} from "./opencoti-liveness";
import { resetPolykvAvailability, resetPolykvSessions } from "./polykv";

const BASE = "http://engine/v1";
const CHAT = `${BASE}/chat/completions`;

/** A server whose `/props` advertises `features`, recording every chat body. */
function server(
	features: string[],
	answer: (body: Record<string, unknown>) => Response = () =>
		new Response(JSON.stringify({ choices: [] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
) {
	const sent: Array<Record<string, unknown>> = [];
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === "/props") {
			return new Response(JSON.stringify({ features }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		sent.push(body);
		return answer(body);
	}) as unknown as typeof fetch;
	return { sent, fetch: fetchImpl };
}

beforeEach(() => {
	resetPolykvAvailability();
	resetPolykvSessions();
});

const encoder = new TextEncoder();

/**
 * A 200 event stream delivering `chunks` one read at a time, the way the
 * server's keepalive branch opens it: headers first, whatever it has after.
 */
function sse(chunks: string[], headers: Record<string, string> = {}): Response {
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				const chunk = chunks[index++];
				if (chunk === undefined) {
					controller.close();
					return;
				}
				controller.enqueue(encoder.encode(chunk));
			},
		}),
		{
			status: 200,
			headers: { "content-type": "text/event-stream", ...headers },
		},
	);
}

/** The error event exactly as `format_oai_sse({"error": ...})` writes it. */
const errorEvent = (error: Record<string, unknown>) =>
	`data: ${JSON.stringify({ error })}\n\n`;

const delta = (content: string) =>
	`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe("asking for the heartbeat", () => {
	it("merges keepalive into the stream options the provider set", () => {
		const body: Record<string, unknown> = {
			stream: true,
			stream_options: { include_usage: true },
		};
		expect(requestStreamKeepalive(body)).toEqual({
			pingSeconds: OPENCOTI_KEEPALIVE_PING_SECONDS,
		});
		expect(body.stream_options).toEqual({
			include_usage: true,
			keepalive: true,
		});
	});

	// `/props` does not say what `--sse-ping-interval` the server runs with, so
	// the request states the one the watchdog is sized for.
	it("states the ping interval the watchdog counts on", () => {
		const body: Record<string, unknown> = { stream: true };
		requestStreamKeepalive(body);
		expect(body.sse_ping_interval).toBe(OPENCOTI_KEEPALIVE_PING_SECONDS);
	});

	it("keeps a ping interval the caller chose, and times nothing when pings are off", () => {
		const chosen: Record<string, unknown> = {
			stream: true,
			sse_ping_interval: 4,
		};
		expect(requestStreamKeepalive(chosen)).toEqual({ pingSeconds: 4 });
		expect(chosen.sse_ping_interval).toBe(4);
		const off: Record<string, unknown> = {
			stream: true,
			sse_ping_interval: -1,
		};
		// Still asked for -- the stream opens early -- but with no pings to
		// count, nothing to time.
		expect(requestStreamKeepalive(off)).toEqual({});
		expect(off.stream_options).toEqual({ keepalive: true });
	});

	it("leaves a buffered request alone", () => {
		const body: Record<string, unknown> = { stream: false };
		expect(requestStreamKeepalive(body)).toBeUndefined();
		expect(body).toEqual({ stream: false });
	});
});

describe("the heartbeat on the wire", () => {
	it("goes on a streaming request to a server that advertises it", async () => {
		const engine = server(["stream_keepalive_v1"]);
		await createOpencotiFetch({ fetch: engine.fetch, baseUrl: BASE })(CHAT, {
			method: "POST",
			body: JSON.stringify({
				model: "m",
				messages: [],
				stream: true,
				stream_options: { include_usage: true },
			}),
		});
		expect(engine.sent[0]?.stream_options).toEqual({
			include_usage: true,
			keepalive: true,
		});
		expect(engine.sent[0]?.sse_ping_interval).toBe(10);
	});

	it("stays off on a server that does not advertise it", async () => {
		const engine = server(["pool_match_in_response_v1"]);
		await createOpencotiFetch({ fetch: engine.fetch, baseUrl: BASE })(CHAT, {
			method: "POST",
			body: JSON.stringify({
				model: "m",
				messages: [],
				stream: true,
				stream_options: { include_usage: true },
			}),
		});
		expect(engine.sent[0]?.stream_options).toEqual({ include_usage: true });
		expect(engine.sent[0]?.sse_ping_interval).toBeUndefined();
	});

	it("stays off on a buffered request", async () => {
		const engine = server(["stream_keepalive_v1"]);
		await createOpencotiFetch({ fetch: engine.fetch, baseUrl: BASE })(CHAT, {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(engine.sent[0]?.stream_options).toBeUndefined();
	});
});

/**
 * patch 0388: with the option the stream is open before the first result, so
 * an error the slot raises on it -- an overlong prompt, a session window that
 * is full, a malformed request -- is an in-stream `data: {"error": ...}` under
 * a 200. Without the option it is `res->error(...)`: the status is the
 * error's own `code`, the body `{"error": <it>}`.
 */
describe("a first-result error inside the stream", () => {
	it("becomes the 400 an overlong prompt always was, n_ctx and all", async () => {
		const error = {
			code: 400,
			message:
				"request (41533 tokens) exceeds the available context size (32768 tokens)",
			type: "exceed_context_size_error",
			n_prompt_tokens: 41_533,
			n_ctx: 32_768,
		};
		const response = await superviseKeepaliveStream(
			sse([": keepalive queued\n\n", errorEvent(error)], {
				"x-opencoti-boot-id": "3f2a9c1e7b4d0086",
			}),
		);
		expect(response.status).toBe(400);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({ error });
		// What the server set before it opened the stream still rides along.
		expect(response.headers.get("x-opencoti-boot-id")).toBe("3f2a9c1e7b4d0086");
	});

	it("becomes a 429 with largest_admissible where the error says 429", async () => {
		const error = {
			code: 429,
			message:
				"admission rejected: context allocation exhausted (base 0 free of 65536 cells, needs 75; largest window admissible now 16384)",
			type: "rate_limit_error",
			largest_admissible: 16_384,
		};
		const response = await superviseKeepaliveStream(
			sse([
				": keepalive queued\n\n",
				": keepalive queued\n\n",
				errorEvent(error),
			]),
		);
		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({ error });
	});

	it("becomes the session-window refusal the classifier reads as one", async () => {
		const error = {
			code: 400,
			message:
				"session allocation full: window 65536, its pools and workers hold 60000, the prompt needs 9000 private — compact the session",
			type: "exceed_context_size_error",
			n_prompt_tokens: 9_000,
			n_ctx: 65_536,
		};
		const response = await superviseKeepaliveStream(sse([errorEvent(error)]));
		expect(response.status).toBe(400);
		expect(((await response.json()) as { error: unknown }).error).toEqual(
			error,
		);
	});

	it("becomes a 503 for an unavailable server, a 500 for its own fault", async () => {
		const unavailable = await superviseKeepaliveStream(
			sse([
				errorEvent({
					code: 503,
					message: "pool seq-id reservoir exhausted",
					type: "unavailable_error",
				}),
			]),
		);
		expect(unavailable.status).toBe(503);
		const rejected = await superviseKeepaliveStream(
			sse([
				errorEvent({
					code: 500,
					message: "tool call rejected",
					type: "tool_call_rejected",
					reason: "unknown tool",
				}),
			]),
		);
		expect(rejected.status).toBe(500);
	});

	it("maps by type when the event carries no status, as the server's table does", () => {
		expect(statusOfStreamError({ type: "invalid_request_error" })).toBe(400);
		expect(statusOfStreamError({ type: "exceed_context_size_error" })).toBe(
			400,
		);
		expect(statusOfStreamError({ type: "authentication_error" })).toBe(401);
		expect(statusOfStreamError({ type: "permission_error" })).toBe(403);
		expect(statusOfStreamError({ type: "not_found_error" })).toBe(404);
		expect(statusOfStreamError({ type: "rate_limit_error" })).toBe(429);
		expect(statusOfStreamError({ type: "not_supported_error" })).toBe(501);
		expect(statusOfStreamError({ type: "unavailable_error" })).toBe(503);
		expect(statusOfStreamError({ type: "server_error" })).toBe(500);
		expect(statusOfStreamError({ type: "something new" })).toBe(500);
		// A code outside the error range is not a status.
		expect(statusOfStreamError({ code: 200, type: "server_error" })).toBe(500);
	});

	it("reads the Anthropic route's event: error form too", async () => {
		const error = { code: 400, message: "bad", type: "invalid_request_error" };
		const response = await superviseKeepaliveStream(
			sse([`event: error\ndata: ${JSON.stringify(error)}\n\n`]),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error });
	});

	it("reads an error event split across reads", async () => {
		const event = errorEvent({
			code: 400,
			message: "x",
			type: "invalid_request_error",
		});
		const response = await superviseKeepaliveStream(
			sse([": keepalive prefill 1/2\n\n", event.slice(0, 17), event.slice(17)]),
		);
		expect(response.status).toBe(400);
	});
});

describe("a stream whose first event is not an error", () => {
	it("is handed on whole: what was read, then the rest", async () => {
		const chunks = [
			": keepalive queued\n\n",
			": keepalive prefill 8192/40960\n\n",
			delta("Hel"),
			delta("lo"),
			"data: [DONE]\n\n",
		];
		const response = await superviseKeepaliveStream(sse(chunks));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(await response.text()).toBe(chunks.join(""));
	});

	it("leaves an error after the first data where it was, mid-stream", async () => {
		const chunks = [
			delta("partial"),
			errorEvent({ code: 500, message: "boom", type: "server_error" }),
		];
		const response = await superviseKeepaliveStream(sse(chunks));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(chunks.join(""));
	});

	it("leaves a refusal made before the stream opened exactly as it was", async () => {
		const refusal = new Response(
			JSON.stringify({ error: { code: 429, message: "admission rejected" } }),
			{
				status: 429,
				headers: { "content-type": "application/json", "retry-after": "2" },
			},
		);
		expect(await superviseKeepaliveStream(refusal)).toBe(refusal);
	});
});

describe("the paths that read a refusal's status, through the heartbeat", () => {
	// The window negotiation reads a 429's largest_admissible. With the option
	// the refusal of the slot is in-stream; it must still be negotiated.
	it("negotiates a window refused inside the stream", async () => {
		let turn = 0;
		const engine = server(
			["stream_keepalive_v1", "elastic_guaranteed_alloc_v1"],
			() => {
				turn += 1;
				return turn === 1
					? sse([
							": keepalive queued\n\n",
							errorEvent({
								code: 429,
								type: "rate_limit_error",
								message: "admission rejected: context allocation exhausted",
								largest_admissible: 163_840,
							}),
						])
					: sse([delta("ok"), "data: [DONE]\n\n"], {
							"x-context-window": "163840",
						});
			},
		);
		const response = await createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: BASE,
			request: { sessionId: "conv", numCtx: 262_144, numCtxMin: 65_536 },
			sleep: async () => {},
		})(CHAT, {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [], stream: true }),
		});
		expect(response.status).toBe(200);
		expect(engine.sent.map((body) => body.num_ctx)).toEqual([262_144, 163_840]);
		expect(await response.text()).toContain('"ok"');
	});

	it("hands the caller the 400 of an overlong prompt, not a 200", async () => {
		const engine = server(["stream_keepalive_v1"], () =>
			sse([
				errorEvent({
					code: 400,
					type: "exceed_context_size_error",
					message: "request exceeds the available context size",
					n_prompt_tokens: 9,
					n_ctx: 8,
				}),
			]),
		);
		const response = await createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: BASE,
		})(CHAT, {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [], stream: true }),
		});
		expect(response.status).toBe(400);
	});
});
