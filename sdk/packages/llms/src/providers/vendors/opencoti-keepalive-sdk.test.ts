import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentModelEvent,
	GatewayProviderContext,
	GatewayStreamRequest,
} from "@cline/shared";
import { classifyTurnFault } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpencotiProvider } from "../ai-sdk";
import { createOpencotiFetch } from "./opencoti";
import { superviseKeepaliveStream } from "./opencoti-liveness";
import { resetPolykvAvailability, resetPolykvSessions } from "./polykv";
import { releaseAllPolykvSwarms } from "./polykv-swarm";

/**
 * The keepalive stream as opencoti b98 really writes it, through the real
 * supervision and the real AI SDK.
 *
 * The fixture is a raw capture (`curl -N` against b98 with
 * `stream_options.keepalive: true`): the server opens the stream before its
 * first result exists and writes that missing result as `data: null`
 * (patch 0388, `first_result_json = ... : json(nullptr)`). The AI SDK's chunk
 * schema rejects `null`, and 48 of a 75-agent swarm died on that one frame in
 * 4.100.195. The #106 tests used stubs that never sent it.
 */
const CAPTURE = readFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		"__fixtures__",
		"opencoti-keepalive-first-null.sse",
	),
);

const BASE = "http://engine/v1";

interface ChatCall {
	body: Record<string, unknown>;
	signal: AbortSignal | undefined;
	/** Set when whoever read the response cancelled its body. */
	cancelled: { value: boolean };
}

/** Slices `bytes` into reads of `size` bytes (everything at once when absent). */
function chunked(bytes: Uint8Array, size?: number): Uint8Array[] {
	if (!size) {
		return [bytes];
	}
	const out: Uint8Array[] = [];
	for (let at = 0; at < bytes.length; at += size) {
		out.push(bytes.slice(at, at + size));
	}
	return out;
}

/**
 * An opencoti that advertises the heartbeat and answers every chat request
 * with `reads`, one per pull; `endless` leaves the stream open after them, a
 * generation still running on the server.
 */
function engine(
	reads: () => Uint8Array[],
	options: { endless?: boolean; features?: string[] } = {},
) {
	const chats: ChatCall[] = [];
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const json = (value: unknown, status = 200) =>
			new Response(JSON.stringify(value), {
				status,
				headers: { "content-type": "application/json" },
			});
		if (url.pathname === "/props") {
			return json({ features: options.features ?? ["stream_keepalive_v1"] });
		}
		if (url.pathname !== "/v1/chat/completions") {
			return json({ error: "no route" }, 404);
		}
		const cancelled = { value: false };
		const signal = init?.signal ?? undefined;
		chats.push({
			body: JSON.parse(String(init?.body)) as Record<string, unknown>,
			signal,
			cancelled,
		});
		const pending = reads();
		let index = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				const next = pending[index++];
				if (next !== undefined) {
					controller.enqueue(next);
					return;
				}
				if (!options.endless) {
					controller.close();
					return;
				}
				// Still generating: nothing more until the request is aborted,
				// which is what closes the connection on a real fetch.
				return new Promise<void>((resolve) => {
					const stop = () => {
						controller.error(signal?.reason ?? new Error("aborted"));
						resolve();
					};
					if (signal?.aborted) {
						stop();
					} else {
						signal?.addEventListener("abort", stop, { once: true });
					}
				});
			},
			cancel() {
				cancelled.value = true;
			},
		});
		return new Response(body, {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-opencoti-boot-id": "boot-1",
			},
		});
	}) as unknown as typeof fetch;
	return { chats, fetch: fetchImpl };
}

function context(config: Record<string, unknown>): GatewayProviderContext {
	const model = { id: "v9-agentic", providerId: "opencoti", name: "v9" };
	return {
		provider: {
			id: "opencoti",
			name: "opencoti",
			defaultModelId: model.id,
			models: [model],
		},
		model,
		config,
	} as unknown as GatewayProviderContext;
}

function request(signal?: AbortSignal): GatewayStreamRequest {
	return {
		providerId: "opencoti",
		modelId: "v9-agentic",
		messages: [
			{
				id: "msg_user",
				role: "user",
				content: [{ type: "text", text: "Say Hi!" }],
				createdAt: new Date(),
			},
		],
		tools: [],
		...(signal ? { signal } : {}),
	} as unknown as GatewayStreamRequest;
}

async function turn(
	fetchImpl: typeof fetch,
	signal?: AbortSignal,
): Promise<AgentModelEvent[]> {
	const config = {
		providerId: "opencoti",
		apiKey: "opencoti",
		baseUrl: BASE,
		fetch: fetchImpl,
	};
	const provider = await createOpencotiProvider(config as never);
	const events: AgentModelEvent[] = [];
	for await (const event of await provider.stream(
		request(signal),
		context(config),
	)) {
		events.push(event);
	}
	return events;
}

const text = (events: AgentModelEvent[]) =>
	events
		.filter((event) => event.type === "text-delta")
		.map((event) => (event as { text: string }).text)
		.join("");

const finish = (events: AgentModelEvent[]) =>
	events.find((event) => event.type === "finish") as
		| (AgentModelEvent & { reason: string; error?: string })
		| undefined;

const encoder = new TextEncoder();

beforeEach(() => {
	resetPolykvAvailability();
	resetPolykvSessions();
});

afterEach(async () => {
	await releaseAllPolykvSwarms();
});

describe("the keepalive stream opencoti b98 writes", () => {
	it("starts with the missing first result as `data: null`", () => {
		expect(new TextDecoder().decode(CAPTURE).startsWith("data: null\n\n")).toBe(
			true,
		);
	});

	it("parses through the supervision and the AI SDK and says Hi!", async () => {
		const server = engine(() => chunked(CAPTURE));
		const events = await turn(server.fetch);
		expect(server.chats[0]?.body.stream_options).toMatchObject({
			keepalive: true,
		});
		expect(text(events)).toBe("Hi!");
		expect(finish(events)?.reason).not.toBe("error");
	});

	it("says Hi! with the capture cut into reads of every size", async () => {
		for (const size of [1, 3, 7, 11, 64]) {
			const server = engine(() => chunked(CAPTURE, size));
			const events = await turn(server.fetch);
			expect({ size, text: text(events) }).toEqual({ size, text: "Hi!" });
			expect(finish(events)?.reason).not.toBe("error");
		}
	});
});

describe("a `data: null` frame", () => {
	const deltaFrame = (content: string) =>
		`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

	async function supervised(reads: string[]): Promise<string> {
		const response = await superviseKeepaliveStream(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						for (const read of reads) {
							controller.enqueue(encoder.encode(read));
						}
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
		);
		return response.text();
	}

	it("is dropped whole, its blank line with it, split across reads", async () => {
		const rest = `${deltaFrame("Hi")}data: [DONE]\n\n`;
		expect(await supervised(["da", "ta: nu", "ll", "\n", "\n", rest])).toBe(
			rest,
		);
		expect(await supervised(["data: null\r\n\r\n", rest])).toBe(rest);
		expect(await supervised(["data:null \n", "\n", rest])).toBe(rest);
	});

	it("is dropped after a keepalive comment and between deltas", async () => {
		const out = await supervised([
			": keepalive queued\n\n",
			"data: null\n\n",
			deltaFrame("a"),
			"data: null\n\n",
			deltaFrame("b"),
		]);
		expect(out).toBe(
			`: keepalive queued\n\n${deltaFrame("a")}${deltaFrame("b")}`,
		);
	});

	it("leaves a null that is part of a payload alone", async () => {
		const frame = `data: {"choices":[{"delta":{"content":null}}]}\n\n`;
		expect(await supervised(["data: null\n\n", frame])).toBe(frame);
	});

	it("does not hide a first-result error that follows it", async () => {
		const response = await superviseKeepaliveStream(
			new Response(
				`data: null\n\ndata: ${JSON.stringify({
					error: {
						code: 400,
						message: "too long",
						type: "invalid_request_error",
					},
				})}\n\n`,
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
		);
		expect(response.status).toBe(400);
	});
});

describe("a response the client stops reading", () => {
	/** A valid first delta, then a chunk the SDK's schema rejects. */
	const poisoned = () => [
		encoder.encode(
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "x" } }] })}\n\n`,
		),
		encoder.encode(`data: ${JSON.stringify({ choices: "bogus" })}\n\n`),
	];

	it("is aborted upstream when the SDK fails the stream, with the heartbeat on", async () => {
		const server = engine(poisoned, { endless: true });
		const events = await turn(server.fetch);
		expect(finish(events)?.reason).toBe("error");
		expect(server.chats).toHaveLength(1);
		expect(server.chats[0]?.signal?.aborted).toBe(true);
	});

	it("is aborted upstream when the SDK fails the stream, without the heartbeat", async () => {
		const server = engine(poisoned, { endless: true, features: [] });
		const events = await turn(server.fetch);
		expect(finish(events)?.reason).toBe("error");
		expect(server.chats[0]?.body.stream_options).not.toMatchObject({
			keepalive: true,
		});
		expect(server.chats[0]?.signal?.aborted).toBe(true);
	});

	it("is aborted upstream when the consumer walks away mid-reply", async () => {
		const server = engine(
			() => [
				encoder.encode(
					`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hel" } }] })}\n\n`,
				),
			],
			{ endless: true },
		);
		const config = {
			providerId: "opencoti",
			apiKey: "opencoti",
			baseUrl: BASE,
			fetch: server.fetch,
		};
		const provider = await createOpencotiProvider(config as never);
		for await (const event of await provider.stream(
			request(),
			context(config),
		)) {
			if (event.type === "text-delta") {
				break;
			}
		}
		expect(server.chats[0]?.signal?.aborted).toBe(true);
	});

	it("is not aborted when it completed", async () => {
		const server = engine(() => chunked(CAPTURE));
		await turn(server.fetch);
		expect(server.chats[0]?.signal?.aborted ?? false).toBe(false);
	});

	it("is aborted when the caller's own signal aborts", async () => {
		const server = engine(
			() => [
				encoder.encode(
					`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hel" } }] })}\n\n`,
				),
			],
			{ endless: true },
		);
		const stop = new AbortController();
		const running = turn(server.fetch, stop.signal);
		while (server.chats.length === 0) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		stop.abort(new Error("user stop"));
		await running.catch(() => {});
		expect(server.chats[0]?.signal?.aborted).toBe(true);
	});

	async function workerTurn(
		server: ReturnType<typeof engine>,
		signal: AbortSignal,
	) {
		const fetchImpl = createOpencotiFetch({
			fetch: server.fetch,
			baseUrl: BASE,
			request: {
				worker: {
					group: "nullframe-lead",
					sessionId: "nullframe-w1",
					layers: 2,
				},
			},
		});
		const response = await fetchImpl(`${BASE}/chat/completions`, {
			method: "POST",
			body: JSON.stringify({
				model: "m",
				messages: [{ role: "user", content: "hi" }],
				stream: true,
			}),
			signal,
		});
		const chat = server.chats.at(-1);
		expect(chat?.body.stream_options).toMatchObject({ keepalive: true });
		return { response, chat };
	}

	it("carries the caller's signal on a worker's request", async () => {
		const server = engine(() => chunked(CAPTURE), { endless: true });
		const stop = new AbortController();
		const { chat } = await workerTurn(server, stop.signal);
		stop.abort();
		expect(chat?.signal?.aborted).toBe(true);
	});

	it("cancels the server's body when a worker's response is cancelled", async () => {
		const server = engine(() => chunked(CAPTURE), { endless: true });
		const { response, chat } = await workerTurn(
			server,
			new AbortController().signal,
		);
		const reader = response.body?.getReader();
		await reader?.read();
		await reader?.cancel(new Error("consumer failed"));
		// A cancel travels up the pipes a hop per turn of the event loop.
		for (let hop = 0; hop < 20 && !chat?.cancelled.value; hop++) {
			await new Promise((resolve) => setTimeout(resolve, 1));
		}
		expect(chat?.cancelled.value).toBe(true);
	});
});

describe("a stream the SDK cannot validate", () => {
	it("ends the turn with an error the turn-fault classifier retries as transport", async () => {
		const server = engine(() => [
			encoder.encode(`data: ${JSON.stringify({ choices: "bogus" })}\n\n`),
			encoder.encode("data: [DONE]\n\n"),
		]);
		const events = await turn(server.fetch);
		const ended = finish(events);
		expect(ended?.reason).toBe("error");
		expect(ended?.error).toMatch(/^Type validation failed/);
		expect(classifyTurnFault(ended?.error)).toBe("transport");
	});
});

describe("the engine's partial eviction, through the SDK (kv_observable_v1)", () => {
	// patch 0399: the victim's 500 carries `error_kind` beside `message`. The
	// victim is mid-decode, so its stream has usually opened already and the
	// error arrives as an in-stream event, which the AI SDK validates against
	// its error schema -- a schema that dropped every field it did not name.
	const eviction = {
		code: 500,
		type: "server_error",
		message:
			"Evicted to keep other in-flight requests alive: the KV cache could not fit another token and this was the largest live sequence. Context size has been exceeded.",
		error_kind: "evicted_kv_full",
	};
	const delta = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "x" } }] })}\n\n`;

	it("keeps its error_kind when it arrives mid-stream", async () => {
		const server = engine(() => [
			encoder.encode(delta),
			encoder.encode(`data: ${JSON.stringify({ error: eviction })}\n\n`),
		]);
		const ended = finish(await turn(server.fetch));
		expect(ended?.reason).toBe("error");
		expect((ended as { errorClass?: string } | undefined)?.errorClass).toBe(
			"kv_evicted",
		);
	});

	// Before any data the supervision turns it into the plain 500 it would
	// have been, which the AI SDK retries twice (2 s, then 4 s) before the
	// turn ends: hence the long timeout.
	it("keeps its error_kind when it is the stream's first result", async () => {
		const server = engine(() => [
			encoder.encode(`data: ${JSON.stringify({ error: eviction })}\n\n`),
		]);
		const ended = finish(await turn(server.fetch));
		expect(ended?.reason).toBe("error");
		expect((ended as { errorClass?: string } | undefined)?.errorClass).toBe(
			"kv_evicted",
		);
	}, 20_000);
});
