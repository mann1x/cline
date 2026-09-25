import { beforeEach, describe, expect, it } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import {
	OPENCOTI_KEEPALIVE_PING_SECONDS,
	requestStreamKeepalive,
} from "./opencoti-liveness";
import { resetPolykvAvailability } from "./polykv";

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
});

describe("asking for the heartbeat", () => {
	it("merges keepalive into the stream options the provider set", () => {
		const body: Record<string, unknown> = {
			stream: true,
			stream_options: { include_usage: true },
		};
		expect(requestStreamKeepalive(body)).toBe(OPENCOTI_KEEPALIVE_PING_SECONDS);
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

	it("keeps a ping interval the caller chose, and reads none from a disabled one", () => {
		const chosen: Record<string, unknown> = {
			stream: true,
			sse_ping_interval: 4,
		};
		expect(requestStreamKeepalive(chosen)).toBe(4);
		expect(chosen.sse_ping_interval).toBe(4);
		const off: Record<string, unknown> = {
			stream: true,
			sse_ping_interval: -1,
		};
		expect(requestStreamKeepalive(off)).toBeUndefined();
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
