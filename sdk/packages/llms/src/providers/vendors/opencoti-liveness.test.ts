import { classifyTurnFault, classifyTurnFaultError } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import {
	describeOpencotiStreamPhase,
	OPENCOTI_KEEPALIVE_PING_SECONDS,
	OpencotiServerSilentError,
	type OpencotiStreamPhase,
	opencotiKeepaliveDeadMs,
	parseKeepaliveComment,
	requestStreamKeepalive,
	statusOfStreamError,
	superviseKeepaliveStream,
} from "./opencoti-liveness";
import { resetPolykvAvailability, resetPolykvSessions } from "./polykv";
import {
	onPolykvStreamPhase,
	POLYKV_PHASE_REPORT_MS,
	polykvRootGeneration,
	releaseAllPolykvSwarms,
	reportPolykvStreamPhase,
} from "./polykv-swarm";

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

/**
 * A 200 event stream that sends each chunk after its delay, then -- unless
 * `end` -- goes silent for good, the way a dead server's half-open connection
 * does. `cancelled` says whether the reader gave up on it.
 */
function timedStream(
	steps: Array<{ afterMs: number; chunk: string }>,
	options: { end?: boolean; headers?: Record<string, string> } = {},
) {
	let index = 0;
	const state = { cancelled: false };
	const response = new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				const step = steps[index++];
				if (!step) {
					if (options.end) {
						controller.close();
						return;
					}
					await new Promise(() => {});
					return;
				}
				await new Promise((resolve) => setTimeout(resolve, step.afterMs));
				controller.enqueue(encoder.encode(step.chunk));
			},
			cancel() {
				state.cancelled = true;
			},
		}),
		{
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"x-opencoti-boot-id": "3f2a9c1e7b4d0086",
				...options.headers,
			},
		},
	);
	return { response, state };
}

describe("a server that stops sending", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("is dead after three silent periods and a margin: 35 s at the default", () => {
		expect(opencotiKeepaliveDeadMs(OPENCOTI_KEEPALIVE_PING_SECONDS)).toBe(
			35_000,
		);
	});

	it("fails the request before its first event as a transport fault", async () => {
		const { response, state } = timedStream([
			{ afterMs: 0, chunk: ": keepalive queued\n\n" },
		]);
		const dead: unknown[] = [];
		const pending = superviseKeepaliveStream(response, {
			pingSeconds: 10,
			onDead: (error) => dead.push(error),
		});
		const outcome = pending.then(
			() => undefined,
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(34_000);
		expect(dead).toEqual([]);
		await vi.advanceTimersByTimeAsync(2_000);
		const error = await outcome;
		expect(error).toBeInstanceOf(OpencotiServerSilentError);
		expect(dead).toHaveLength(1);
		expect(state.cancelled).toBe(true);
		// Transport, whether the classifier gets the object or only its text:
		// the #104 recovery waits for /health and runs the turn again.
		expect(classifyTurnFaultError(error)).toBe("transport");
		expect(classifyTurnFault((error as Error).message)).toBe("transport");
	});

	it("keeps a long prefill alive on its comments alone", async () => {
		const steps = [
			{ afterMs: 0, chunk: ": keepalive queued\n\n" },
			...Array.from({ length: 12 }, (_, i) => ({
				afterMs: 10_000,
				chunk: `: keepalive prefill ${(i + 1) * 3000}/41533\n\n`,
			})),
			{ afterMs: 10_000, chunk: delta("done") },
		];
		const { response } = timedStream(steps, { end: true });
		const pending = superviseKeepaliveStream(response, { pingSeconds: 10 });
		await vi.advanceTimersByTimeAsync(140_000);
		const supervised = await pending;
		expect(supervised.status).toBe(200);
		expect(await supervised.text()).toContain('"done"');
	});

	it("errors the stream mid-reply when the silence comes after the first token", async () => {
		const { response } = timedStream([
			{ afterMs: 0, chunk: delta("Hel") },
			{ afterMs: 10_000, chunk: ": keepalive generating 17\n\n" },
		]);
		const pending = superviseKeepaliveStream(response, { pingSeconds: 10 });
		await vi.advanceTimersByTimeAsync(1);
		const supervised = await pending;
		const reader = supervised.body?.getReader();
		expect(reader).toBeDefined();
		const first = await reader?.read();
		expect(new TextDecoder().decode(first?.value)).toContain("Hel");
		const rest = (async () => {
			try {
				while (!(await reader?.read())?.done) {}
				return undefined;
			} catch (error) {
				return error;
			}
		})();
		await vi.advanceTimersByTimeAsync(10_000 + 36_000);
		expect(await rest).toBeInstanceOf(OpencotiServerSilentError);
	});

	it("is not armed when the pings are off", async () => {
		const { response } = timedStream(
			[{ afterMs: 120_000, chunk: delta("late") }],
			{ end: true },
		);
		const pending = superviseKeepaliveStream(response, {});
		await vi.advanceTimersByTimeAsync(120_000);
		expect((await pending).status).toBe(200);
	});

	// No boot id: the process that answered is not one that sends the
	// heartbeat (an older build after a restart), and its prefill is silent.
	it("is not armed on a response from a server that does not send the heartbeat", async () => {
		const { response } = timedStream(
			[{ afterMs: 120_000, chunk: delta("late") }],
			{ end: true },
		);
		const bare = new Response(response.body, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		const pending = superviseKeepaliveStream(bare, { pingSeconds: 10 });
		await vi.advanceTimersByTimeAsync(120_000);
		expect((await pending).status).toBe(200);
	});

	// Timeouts are off on purpose: without the heartbeat a long silent turn is
	// legitimate, and nothing may time it.
	it("is never applied to a request without the heartbeat", async () => {
		const engine = server(
			["pool_match_in_response_v1"],
			() =>
				timedStream([{ afterMs: 300_000, chunk: delta("slow") }], { end: true })
					.response,
		);
		const pending = createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: BASE,
		})(CHAT, {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [], stream: true }),
		});
		const response = await pending;
		const text = response.text();
		await vi.advanceTimersByTimeAsync(300_000);
		expect(await text).toContain('"slow"');
	});

	it("fails the lead's request the same way when the heartbeat stops", async () => {
		const engine = server(
			["stream_keepalive_v1"],
			() =>
				timedStream([{ afterMs: 0, chunk: ": keepalive queued\n\n" }]).response,
		);
		const outcome = createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: BASE,
		})(CHAT, {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [], stream: true }),
		}).then(
			() => undefined,
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(36_000);
		expect(await outcome).toBeInstanceOf(OpencotiServerSilentError);
	});
});

describe("the phase a keepalive comment names", () => {
	it("reads the three phases the server writes", () => {
		expect(parseKeepaliveComment(": keepalive queued")).toEqual({
			kind: "queued",
		});
		expect(parseKeepaliveComment(": keepalive prefill 20481/41533")).toEqual({
			kind: "prefill",
			processed: 20_481,
			total: 41_533,
		});
		expect(parseKeepaliveComment(": keepalive generating 17")).toEqual({
			kind: "generating",
			decoded: 17,
		});
	});

	it("reads nothing from upstream's bare ping or any other comment", () => {
		expect(parseKeepaliveComment(":")).toBeUndefined();
		expect(parseKeepaliveComment(": ping")).toBeUndefined();
		expect(parseKeepaliveComment(": keepalive sleeping")).toBeUndefined();
	});

	it("words each for the row", () => {
		expect(describeOpencotiStreamPhase({ kind: "queued" })).toBe(
			"Queued on the server",
		);
		expect(
			describeOpencotiStreamPhase({
				kind: "prefill",
				processed: 20_481,
				total: 41_533,
			}),
		).toBe("Prefilling 20,481 / 41,533");
		expect(
			describeOpencotiStreamPhase({ kind: "generating", decoded: 0 }),
		).toBe("Generating (silent)");
		expect(
			describeOpencotiStreamPhase({ kind: "generating", decoded: 1_017 }),
		).toBe("Generating (silent, 1,017 tokens so far)");
	});

	it("is reported as the stream goes, and cleared when it produces", async () => {
		const phases: Array<OpencotiStreamPhase | undefined> = [];
		const response = await superviseKeepaliveStream(
			sse([
				": keepalive queued\n\n",
				": keepalive prefill 8192/40960\n\n",
				delta("a"),
				": keepalive generating 17\n\n",
				delta("b"),
				"data: [DONE]\n\n",
			]),
			{ onPhase: (phase) => phases.push(phase) },
		);
		await response.text();
		expect(phases).toEqual([
			{ kind: "queued" },
			{ kind: "prefill", processed: 8192, total: 40_960 },
			undefined,
			{ kind: "generating", decoded: 17 },
			undefined,
		]);
	});

	it("is cleared when the first event is an error", async () => {
		const phases: Array<OpencotiStreamPhase | undefined> = [];
		await superviseKeepaliveStream(
			sse([
				": keepalive queued\n\n",
				errorEvent({ code: 400, message: "x", type: "invalid_request_error" }),
			]),
			{ onPhase: (phase) => phases.push(phase) },
		);
		expect(phases).toEqual([{ kind: "queued" }, undefined]);
	});
});

describe("the phase on an agent's row", () => {
	it("is updated in place at most every few seconds, a new phase at once", () => {
		const seen: Array<OpencotiStreamPhase | undefined> = [];
		const stop = onPolykvStreamPhase("row-1", (phase) => seen.push(phase));
		const at = 1_000_000;
		const prefill = (processed: number): OpencotiStreamPhase => ({
			kind: "prefill",
			processed,
			total: 40_960,
		});
		reportPolykvStreamPhase("row-1", { kind: "queued" }, at);
		reportPolykvStreamPhase("row-1", { kind: "queued" }, at + 1_000);
		reportPolykvStreamPhase("row-1", prefill(1), at + 1_500);
		reportPolykvStreamPhase("row-1", prefill(2), at + 2_000);
		reportPolykvStreamPhase(
			"row-1",
			prefill(3),
			at + 1_500 + POLYKV_PHASE_REPORT_MS,
		);
		reportPolykvStreamPhase("row-1", undefined, at + 5_000);
		reportPolykvStreamPhase("row-1", undefined, at + 5_001);
		stop();
		expect(seen).toEqual([
			{ kind: "queued" },
			prefill(1),
			prefill(3),
			undefined,
		]);
	});

	it("reaches the row from the lead's own streaming request", async () => {
		const seen: Array<OpencotiStreamPhase | undefined> = [];
		const stop = onPolykvStreamPhase("conv-phase", (phase) => seen.push(phase));
		const engine = server(["stream_keepalive_v1"], () =>
			sse([": keepalive prefill 100/200\n\n", delta("x"), "data: [DONE]\n\n"]),
		);
		try {
			const response = await createOpencotiFetch({
				fetch: engine.fetch,
				baseUrl: BASE,
				request: { sessionId: "conv-phase" },
			})(CHAT, {
				method: "POST",
				body: JSON.stringify({ model: "m", messages: [], stream: true }),
			});
			await response.text();
		} finally {
			stop();
		}
		expect(seen).toEqual([
			{ kind: "prefill", processed: 100, total: 200 },
			undefined,
		]);
	});
});

describe("the boot id on the lead's responses", () => {
	afterEach(async () => {
		await releaseAllPolykvSwarms();
	});

	// The lead tree follows the root's generation (polykv-lead.ts): a new
	// generation is what makes its next turn rebuild its chain.
	it("starts a new generation when the header changes, and logs it at info", async () => {
		let boot = "aaaaaaaaaaaaaaaa";
		const engine = server(
			[],
			() =>
				new Response(JSON.stringify({ choices: [] }), {
					status: 200,
					headers: {
						"content-type": "application/json",
						"x-opencoti-boot-id": boot,
					},
				}),
		);
		const logged: Array<[string, string]> = [];
		const fetchImpl = createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: "http://lead-engine/v1",
			request: { sessionId: "lead-conv" },
			log: (message, severity) => logged.push([message, severity]),
		});
		const turn = () =>
			fetchImpl("http://lead-engine/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "m", messages: [] }),
			});
		await turn();
		const generation = polykvRootGeneration("http://lead-engine/v1");
		await turn();
		expect(polykvRootGeneration("http://lead-engine/v1")).toBe(generation);
		boot = "bbbbbbbbbbbbbbbb";
		await turn();
		expect(polykvRootGeneration("http://lead-engine/v1")).toBe(generation + 1);
		expect(logged).toHaveLength(1);
		expect(logged[0]?.[1]).toBe("info");
		expect(logged[0]?.[0]).toContain("bbbbbbbbbbbbbbbb");
	});
});
