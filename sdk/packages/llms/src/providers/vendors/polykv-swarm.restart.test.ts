import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import {
	onPolykvRoomWait,
	POLYKV_ROOM_BACKOFF_MAX_MS,
	polykvRoomBackoffMs,
	releaseAllPolykvSwarms,
} from "./polykv-swarm";

/**
 * A stub opencoti that can be restarted.
 *
 * What a restart does to a real one (1tmrl, 2026-09-25): open connections
 * are refused while it is down, and when it is back every pool and owner
 * allocation is gone and new pools are numbered from 0 again.
 */
function restartableEngine() {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	let nextPool = 0;
	let boot = 1;
	let down = false;
	let refusals = 0;
	/** Pool id -> the prompt it holds, for the current boot only. */
	let pools = new Map<number, string>();
	const render = (messages: Array<{ role: string; content: unknown }>) =>
		messages
			.map(
				(message) =>
					`<|${message.role}|>${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}<|end|>`,
			)
			.join("");
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: {};
		calls.push({ path: url.pathname, body });
		if (down) {
			throw Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("connect ECONNREFUSED"), {
					code: "ECONNREFUSED",
				}),
			});
		}
		const json = (value: unknown, status = 200, headers = {}) =>
			new Response(JSON.stringify(value), {
				status,
				headers: { "content-type": "application/json", ...headers },
			});
		if (url.pathname === "/health") {
			return json({ status: "ok" });
		}
		if (url.pathname === "/props") {
			return json({ build_info: "opencoti-test", opencoti: {}, boot });
		}
		if (url.pathname === "/kv") {
			return json({ session_ctx_max: 262_144 });
		}
		if (url.pathname === "/apply-template") {
			return json({
				prompt: render(
					body.messages as Array<{ role: string; content: unknown }>,
				),
			});
		}
		if (url.pathname === "/polykv/pools") {
			pools.set(nextPool, String(body.prompt));
			return json({ pool_id: nextPool++, parent: -1, prefix_len: 100 });
		}
		if (/^\/polykv\/pools\/\d+\/fork$/.test(url.pathname)) {
			pools.set(nextPool, String(body.prompt));
			return json({
				pool_id: nextPool++,
				parent: Number(url.pathname.split("/")[3]),
				prefix_len: 200,
			});
		}
		if (/^\/sessions\/[^/]+\/close$/.test(url.pathname)) {
			return json({ found: true, released: true });
		}
		if (url.pathname === "/v1/chat/completions" && body.max_tokens !== 1) {
			if (body.pool_id !== undefined && refusals > 0) {
				refusals -= 1;
				return json(
					{
						error: {
							message:
								"admission rejected: session allocation full (worker of 'x': 0 of 65536 cells free, needs 75)",
						},
					},
					429,
					{ "retry-after": "2" },
				);
			}
		}
		if (url.pathname === "/v1/chat/completions") {
			const known = typeof body.pool_id === "number" && pools.has(body.pool_id);
			return new Response(JSON.stringify({ choices: [{ message: {} }] }), {
				status: 200,
				headers: {
					"content-type": "application/json",
					// Every opencoti turn attached to a live pool names its window.
					...(known || body.pool_id === undefined
						? { "x-context-window": "65536" }
						: {}),
				},
			});
		}
		return json({ error: "no route" }, 404);
	}) as unknown as typeof fetch;
	return {
		calls,
		fetch: fetchImpl,
		pools: () => pools,
		/** Refuse the next `n` worker turns with a full window. */
		refuseWorkers: (n: number) => {
			refusals = n;
		},
		/** Take the server down; requests are refused until `up()`. */
		down: () => {
			down = true;
		},
		/** Bring it back with nothing: no pools, ids from 0 again. */
		up: () => {
			down = false;
			boot += 1;
			pools = new Map();
			nextPool = 0;
		},
	};
}

type Engine = ReturnType<typeof restartableEngine>;

function agentBody(role: string, task: string) {
	return {
		model: "m",
		messages: [
			{ role: "system", content: "base prompt" },
			{ role: "user", content: "the shared file" },
			{ role: "user", content: role },
			{ role: "user", content: task },
		],
		num_ctx: 262_144,
	};
}

function workerFetch(engine: Engine, sessionId: string) {
	return createOpencotiFetch({
		fetch: engine.fetch,
		baseUrl: "http://engine/v1",
		request: { worker: { group: "lead-r", sessionId, layers: 2 } },
	});
}

async function send(engine: Engine, sessionId: string, body: object) {
	return workerFetch(engine, sessionId)("http://engine/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

const turns = (engine: Engine) =>
	engine.calls.filter(
		(call) =>
			call.path === "/v1/chat/completions" && call.body.max_tokens !== 1,
	);

afterEach(async () => {
	await releaseAllPolykvSwarms();
});

describe("a started worker whose server goes away", () => {
	it("waits for /health and sends the same turn again", async () => {
		const engine = restartableEngine();
		await send(engine, "w1", agentBody("r", "t"));
		engine.down();
		const waits: boolean[] = [];
		const stop = onPolykvRoomWait("w1", (state) => {
			waits.push(state.waiting);
			// The first probe finds it down; bring it back for the next.
			if (state.waiting) {
				setTimeout(() => engine.up(), 5);
			}
		});
		try {
			const response = await send(engine, "w1", agentBody("r", "t2"));
			expect(response.status).toBe(200);
		} finally {
			stop();
		}
		expect(waits).toEqual([true, false]);
		expect(engine.calls.some((call) => call.path === "/health")).toBe(true);
		expect(turns(engine).at(-1)?.body.messages).toEqual(
			agentBody("r", "t2").messages,
		);
	});

	it("hands a worker that has not started its failure, for the queue to re-place", async () => {
		const engine = restartableEngine();
		engine.down();
		await expect(send(engine, "fresh", agentBody("r", "t"))).rejects.toThrow(
			"fetch failed",
		);
		expect(engine.calls.some((call) => call.path === "/health")).toBe(false);
	});

	it("gives up waiting the moment the agent is stopped", async () => {
		const engine = restartableEngine();
		await send(engine, "w2", agentBody("r", "t"));
		engine.down();
		const controller = new AbortController();
		const stop = onPolykvRoomWait("w2", (state) => {
			if (state.waiting) {
				setTimeout(() => controller.abort(new Error("stopped")), 5);
			}
		});
		try {
			await expect(
				workerFetch(engine, "w2")("http://engine/v1/chat/completions", {
					method: "POST",
					body: JSON.stringify(agentBody("r", "t2")),
					signal: controller.signal,
				}),
			).rejects.toThrow("stopped");
		} finally {
			stop();
		}
	});
});

/**
 * 1tmrl: a started worker refused on a later turn waited out a fifteen-minute
 * deadline and then ended on the refusal. Ruled: there is no deadline.
 */
describe("a started worker on a full window", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits past the old fifteen-minute deadline instead of ending on the refusal", async () => {
		const engine = restartableEngine();
		await send(engine, "slow", agentBody("r", "t"));
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		engine.refuseWorkers(60);
		const start = Date.now();
		const pending = send(engine, "slow", agentBody("r", "t2"));
		for (let i = 0; i < 80; i += 1) {
			await vi.advanceTimersByTimeAsync(POLYKV_ROOM_BACKOFF_MAX_MS);
		}
		const response = await pending;
		expect(response.status).toBe(200);
		expect(Date.now() - start).toBeGreaterThan(15 * 60_000);
	});

	it("backs off from the engine's figure to thirty seconds, never past it", () => {
		expect(
			[1, 2, 3, 4, 5, 6, 7, 8, 30].map((n) => polykvRoomBackoffMs(n, 2_000)),
		).toEqual([
			2_000, 2_000, 2_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
		]);
	});
});
