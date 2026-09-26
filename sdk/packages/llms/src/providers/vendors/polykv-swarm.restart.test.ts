import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import { resetPolykvAvailability } from "./polykv";
import {
	invalidatePolykvRoot,
	keepPolykvOwnersAlive,
	notePolykvServerFault,
	onPolykvNotice,
	onPolykvRoomWait,
	POLYKV_ROOM_BACKOFF_MAX_MS,
	POLYKV_VERIFY_INTERVAL_MS,
	polykvRoomBackoffMs,
	polykvRootGeneration,
	polykvServerIdentity,
	releaseAllPolykvSwarms,
	releasePolykvAgent,
} from "./polykv-swarm";

/**
 * A stub opencoti that can be restarted.
 *
 * What a restart does to a real one (1tmrl, 2026-09-25): open connections
 * are refused while it is down, and when it is back every pool and owner
 * allocation is gone and new pools are numbered from 0 again.
 */
function restartableEngine(
	options: {
		/** State opencoti's c8 boot fields: `opencoti.boot_id` in /props, `started_at` in /health. */
		bootFields?: boolean;
		/** `/props` `features`. */
		features?: string[];
		/** `X-OpenCoti-Boot-Id` on every completion (`boot_id_v1`). */
		bootHeader?: boolean;
		/** The `opencoti` block with `pool_unknown` (`pool_unknown_in_response_v1`). */
		poolUnknown?: boolean;
		/** `/kv` lists each owner that created a pool, at a 65,536-token window. */
		ownerKv?: boolean;
	} = {},
) {
	const owners = new Set<string>();
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	let nextPool = 0;
	let boot = 1;
	let down = false;
	let refusals = 0;
	let identity = 1;
	let bootId = 1;
	let onTemplate: (() => void) | undefined;
	/** Pool ids a turn named that this boot never issued. */
	const unknownPoolSends: number[] = [];
	/** Pool id -> the prompt it holds, for the current boot only. */
	let pools = new Map<number, { prompt: string; parent: number }>();
	const render = (messages: Array<{ role: string; content: unknown }>) =>
		messages
			.map(
				(message) =>
					`<|${message.role}|>${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}<|end|>`,
			)
			.join("");
	let hangs = 0;
	/** `/polykv/pools` listings left unanswered (a busy engine), the rest answer. */
	let listingDown = false;
	/** `/props` and `/health` refused too: nothing on the server answers. */
	let identityDown = false;
	const url = (input: unknown) => new URL(String(input));
	const answer = async (input: unknown, init?: RequestInit) => {
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
		if (
			identityDown &&
			(url.pathname === "/health" || url.pathname === "/props")
		) {
			return json({ error: "unavailable" }, 503);
		}
		if (url.pathname === "/health") {
			return json({
				status: "ok",
				...(options.bootFields ? { started_at: 1_000 + bootId } : {}),
			});
		}
		if (url.pathname === "/props") {
			return json({
				build_info: "opencoti-test",
				opencoti: options.bootFields ? { boot_id: `b-${bootId}` } : {},
				boot,
				start_time: identity,
				...(options.features ? { features: options.features } : {}),
			});
		}
		if (url.pathname === "/polykv/pools" && !init?.body) {
			if (listingDown) {
				return json({ error: "busy" }, 503);
			}
			return json({
				pools: [...pools.entries()].map(([id, pool]) => ({
					pool_id: id,
					parent: pool.parent,
					prefix_len: pool.prompt.length,
				})),
			});
		}
		if (url.pathname === "/kv") {
			return json({
				session_ctx_max: 262_144,
				...(options.ownerKv
					? {
							allocations: [...owners].map((session_id) => ({
								session_id,
								window: 65_536,
								used: 0,
							})),
						}
					: {}),
			});
		}
		if (url.pathname === "/sessions/resize") {
			return json({ ok: true, window_new: body.num_ctx });
		}
		if (url.pathname === "/apply-template") {
			onTemplate?.();
			return json({
				prompt: render(
					body.messages as Array<{ role: string; content: unknown }>,
				),
			});
		}
		if (url.pathname === "/polykv/pools") {
			if (typeof body.session_id === "string") {
				owners.add(body.session_id);
			}
			const prompt = String(body.prompt);
			pools.set(nextPool, { prompt, parent: -1 });
			return json({
				pool_id: nextPool++,
				parent: -1,
				prefix_len: prompt.length,
			});
		}
		if (/^\/polykv\/pools\/\d+\/fork$/.test(url.pathname)) {
			const prompt = String(body.prompt);
			const parent = Number(url.pathname.split("/")[3]);
			pools.set(nextPool, { prompt, parent });
			return json({
				pool_id: nextPool++,
				parent,
				prefix_len: prompt.length,
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
			if (typeof body.pool_id === "number" && !known) {
				unknownPoolSends.push(body.pool_id);
			}
			return new Response(
				JSON.stringify({
					choices: [{ message: {} }],
					// Only when the request named a pool (the T12 rule).
					...(options.poolUnknown && typeof body.pool_id === "number"
						? {
								opencoti: {
									pool_id: body.pool_id,
									pool_match: known ? 0 : -1,
									pool_unknown: !known,
								},
							}
						: {}),
				}),
				{
					status: 200,
					headers: {
						"content-type": "application/json",
						// Every opencoti turn attached to a live pool names its window.
						...(known || body.pool_id === undefined
							? { "x-context-window": "65536" }
							: {}),
						...(options.bootHeader
							? { "x-opencoti-boot-id": `b-${bootId}` }
							: {}),
					},
				},
			);
		}
		return json({ error: "no route" }, 404);
	};
	/**
	 * A turn that asked for the heartbeat, as patch 0388 answers it: a 200
	 * stream opened at once, a keepalive comment, then the reply -- or the
	 * error the slot raised, as an in-stream event.
	 */
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const response = await answer(input, init);
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: {};
		const options = body.stream_options as Record<string, unknown> | undefined;
		if (options?.keepalive !== true) {
			return response;
		}
		if (hangs > 0 && url(input).pathname === "/v1/chat/completions") {
			// Open, one comment, then nothing: the process wedged or the
			// connection went half-open.
			hangs -= 1;
			let sent = false;
			return new Response(
				new ReadableStream<Uint8Array>({
					async pull(controller) {
						if (!sent) {
							sent = true;
							controller.enqueue(
								new TextEncoder().encode(": keepalive prefill 10/40960\n\n"),
							);
							return;
						}
						await new Promise(() => {});
					},
				}),
				{
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"x-opencoti-boot-id": "0000000000000001",
					},
				},
			);
		}
		const text = await response.text();
		const headers = new Headers(response.headers);
		headers.set("content-type", "text/event-stream");
		return new Response(
			response.ok
				? `: keepalive queued\n\ndata: ${text}\n\ndata: [DONE]\n\n`
				: `: keepalive queued\n\ndata: ${JSON.stringify({
						error: {
							code: response.status,
							...((JSON.parse(text) as { error: object }).error ?? {}),
						},
					})}\n\n`,
			{ status: 200, headers },
		);
	}) as unknown as typeof fetch;
	return {
		calls,
		unknownPoolSends,
		fetch: fetchImpl,
		pools: () => pools,
		/** A new process identity in `/props`, pools untouched. */
		newIdentity: () => {
			identity += 1;
		},
		/** A new `boot_id` / `started_at`, pools untouched. */
		newBoot: () => {
			bootId += 1;
		},
		/** Run `fn` on the next `/apply-template`, once. */
		onNextTemplate: (fn: () => void) => {
			onTemplate = () => {
				onTemplate = undefined;
				fn();
			};
		},
		/** The next `n` heartbeat turns open, send one comment, and go silent. */
		hangTurns: (n: number) => {
			hangs = n;
		},
		/** Refuse the next `n` worker turns with a full window. */
		refuseWorkers: (n: number) => {
			refusals = n;
		},
		/** Take the server down; requests are refused until `up()`. */
		down: () => {
			down = true;
		},
		/**
		 * Restarted between two turns, unnoticed: a new process (new boot
		 * id) with no pools, numbering them from 0 again.
		 */
		restartQuietly: () => {
			bootId += 1;
			boot += 1;
			pools = new Map();
			nextPool = 0;
		},
		/**
		 * One pool goes away with the process still up: an owner lapsed,
		 * or the engine released it.
		 */
		dropPool: (id: number) => {
			pools.delete(id);
		},
		/** `/polykv/pools` stops (or starts again) answering; nothing else changes. */
		listing: (answers: boolean) => {
			listingDown = !answers;
		},
		/** `/props` and `/health` stop (or start again) answering. */
		identity: (answers: boolean) => {
			identityDown = !answers;
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
	resetPolykvAvailability();
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
		const waits: boolean[] = [];
		const stop = onPolykvRoomWait("fresh", (state) => {
			waits.push(state.waiting);
		});
		await expect(send(engine, "fresh", agentBody("r", "t"))).rejects.toThrow(
			"fetch failed",
		);
		stop();
		// No wait for the server: the failure goes back as it came.
		expect(waits.includes(true)).toBe(false);
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

/**
 * 1tmrl: bs2:8244 restarted twice under a 75-agent swarm. Every pool and
 * owner went with it, and the new server numbered its pools from 0 again --
 * so a cached id could now name a DIFFERENT pool, and one the server did not
 * know was silently prefilled in full.
 */
describe("pool ids across a server restart", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	/** The pool id each of an agent's turns named, in order. */
	const poolsSentBy = (engine: Engine, sessionId: string) =>
		turns(engine)
			.filter((call) => call.body.session_id === sessionId)
			.map((call) => call.body.pool_id as number | undefined);

	it("attaches an agent between turns to the new id of its own layer, never to an old number", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const engine = restartableEngine();
		await send(engine, "a1", agentBody("role A", "task a"));
		await send(engine, "b1", agentBody("role B", "task b"));
		const [oldA] = poolsSentBy(engine, "a1");
		const [oldB] = poolsSentBy(engine, "b1");
		expect(oldA).toBe(2);
		expect(oldB).toBe(3);
		const before = polykvRootGeneration("http://engine/v1");

		// Restarted while both agents were running their tools: nothing
		// faulted, and the new server has no pools at all.
		engine.down();
		engine.up();
		vi.setSystemTime(Date.now() + POLYKV_VERIFY_INTERVAL_MS + 1);

		// B goes first, so the new pool 2 is B's layer -- the number A held.
		await send(engine, "b1", agentBody("role B", "task b, turn 2"));
		await send(engine, "a1", agentBody("role A", "task a, turn 2"));

		expect(polykvRootGeneration("http://engine/v1")).toBe(before + 1);
		const newB = poolsSentBy(engine, "b1").at(-1) as number;
		const newA = poolsSentBy(engine, "a1").at(-1) as number;
		expect(newB).toBe(2);
		expect(engine.pools().get(newB)?.prompt).toContain("role B");
		expect(engine.pools().get(newA)?.prompt).toContain("role A");
		expect(newA).not.toBe(oldA);
		// After the bump A never names its old number, which is B's now.
		expect(poolsSentBy(engine, "a1").slice(1)).not.toContain(oldA);
		expect(engine.unknownPoolSends).toEqual([]);
	});

	it("asks at once after a transport fault, and re-sends onto the rebuilt pool", async () => {
		const engine = restartableEngine();
		await send(engine, "w", agentBody("role A", "t1"));
		engine.down();
		const stop = onPolykvRoomWait("w", (state) => {
			if (state.waiting) {
				setTimeout(() => engine.up(), 5);
			}
		});
		try {
			await send(engine, "w", agentBody("role A", "t2"));
		} finally {
			stop();
		}
		const sent = poolsSentBy(engine, "w").at(-1) as number;
		expect(engine.pools().get(sent)?.prompt).toContain("role A");
		expect(engine.pools().size).toBeGreaterThan(0);
	});

	it("reads a pooled turn without X-Context-Window as the pools being gone", async () => {
		const engine = restartableEngine();
		await send(engine, "x", agentBody("role A", "t1"));
		// Restarted silently, within the verify interval: the next turn
		// still names the old pool, and the server answers it windowless.
		engine.down();
		engine.up();
		await send(engine, "x", agentBody("role A", "t2"));
		const generation = polykvRootGeneration("http://engine/v1");
		await send(engine, "x", agentBody("role A", "t3"));

		expect(polykvRootGeneration("http://engine/v1")).toBe(generation + 1);
		const sent = poolsSentBy(engine, "x").at(-1) as number;
		expect(engine.pools().get(sent)?.prompt).toContain("role A");
	});

	it("rebuilds when the server's identity in /props changes", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const engine = restartableEngine();
		await send(engine, "i", agentBody("role A", "t1"));
		const generation = polykvRootGeneration("http://engine/v1");
		engine.newIdentity();
		vi.setSystemTime(Date.now() + POLYKV_VERIFY_INTERVAL_MS + 1);
		await send(engine, "i", agentBody("role A", "t2"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation + 1);
	});

	it("keeps the pools when the server is the same one", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const engine = restartableEngine();
		await send(engine, "same", agentBody("role A", "t1"));
		const generation = polykvRootGeneration("http://engine/v1");
		const poolsBefore = engine.pools().size;
		vi.setSystemTime(Date.now() + POLYKV_VERIFY_INTERVAL_MS + 1);
		await send(engine, "same", agentBody("role A", "t2"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation);
		expect(engine.pools().size).toBe(poolsBefore);
		expect(poolsSentBy(engine, "same")).toEqual([2, 2]);
	});

	it("never sends an id resolved in a generation that ended before the send", async () => {
		const engine = restartableEngine();
		await send(engine, "g", agentBody("role A", "t1"));
		// Another agent finds the restart while this one is resolving.
		engine.onNextTemplate(() => {
			engine.down();
			engine.up();
			invalidatePolykvRoot("http://engine/v1", "test");
		});
		await send(engine, "g", agentBody("role A", "t2"));
		const sent = poolsSentBy(engine, "g").at(-1) as number;
		expect(engine.pools().get(sent)?.prompt).toContain("role A");
		expect(engine.unknownPoolSends).toEqual([]);
		expect(poolsSentBy(engine, "g")).toHaveLength(2);
	});

	// opencoti c8 row L (mail 274): `boot_id` and `started_at` on /props and
	// /health, top level or under `opencoti`, are the identity when present.
	it("rebuilds when the server's boot_id changes", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const engine = restartableEngine({ bootFields: true });
		await send(engine, "boot", agentBody("role A", "t1"));
		const generation = polykvRootGeneration("http://engine/v1");
		engine.newBoot();
		vi.setSystemTime(Date.now() + POLYKV_VERIFY_INTERVAL_MS + 1);
		await send(engine, "boot", agentBody("role A", "t2"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation + 1);
	});

	it("reads only the boot fields when the server states them", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const engine = restartableEngine({ bootFields: true });
		await send(engine, "boot-same", agentBody("role A", "t1"));
		const generation = polykvRootGeneration("http://engine/v1");
		// `start_time` moves; the boot id does not: the same process.
		engine.newIdentity();
		vi.setSystemTime(Date.now() + POLYKV_VERIFY_INTERVAL_MS + 1);
		await send(engine, "boot-same", agentBody("role A", "t2"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation);
	});

	it("prefers boot_id and started_at, at the top level or under opencoti", () => {
		const a = polykvServerIdentity({ build_info: "b1", boot_id: "x" });
		expect(a).toBe(polykvServerIdentity({ build_info: "b2", boot_id: "x" }));
		expect(a).not.toBe(
			polykvServerIdentity({ build_info: "b1", boot_id: "y" }),
		);
		expect(
			polykvServerIdentity({ opencoti: { boot_id: "x" }, pid: 1 }),
		).not.toBe(polykvServerIdentity({ opencoti: { boot_id: "y" }, pid: 1 }));
		expect(
			polykvServerIdentity({ opencoti: { started_at: 5 }, build_info: "b1" }),
		).toBe(
			polykvServerIdentity({ opencoti: { started_at: 5 }, build_info: "b2" }),
		);
		// From /health, when /props does not carry them.
		expect(
			polykvServerIdentity({ build_info: "b1" }, { boot_id: "x" }),
		).not.toBe(polykvServerIdentity({ build_info: "b1" }, { boot_id: "y" }));
	});

	it("reads a server's identity from what /props states", () => {
		expect(polykvServerIdentity({ build_info: "b1", start_time: 5 })).toBe(
			polykvServerIdentity({ build_info: "b1", start_time: 5 }),
		);
		expect(polykvServerIdentity({ build_info: "b1", start_time: 5 })).not.toBe(
			polykvServerIdentity({ build_info: "b1", start_time: 6 }),
		);
		expect(polykvServerIdentity({ chat_template: "x" })).toBeUndefined();
	});
});

describe("the heartbeat on a worker's turn", () => {
	it("goes on its streaming request, merged into the stream options", async () => {
		const engine = restartableEngine({ features: ["stream_keepalive_v1"] });
		await send(engine, "hb", {
			...agentBody("r", "t"),
			stream: true,
			stream_options: { include_usage: true },
		});
		expect(turns(engine).at(-1)?.body).toMatchObject({
			stream_options: { include_usage: true, keepalive: true },
			sse_ping_interval: 10,
		});
	});

	it("stays off where the server does not advertise it", async () => {
		const engine = restartableEngine();
		await send(engine, "hb-off", {
			...agentBody("r", "t"),
			stream: true,
			stream_options: { include_usage: true },
		});
		expect(turns(engine).at(-1)?.body.stream_options).toEqual({
			include_usage: true,
		});
	});
});

describe("a worker's refusal inside the heartbeat stream", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	// The window-full wait reads a 429 and its text. With the heartbeat the
	// refusal is an in-stream event under a 200; it must still be waited out.
	it("is waited out as the full window it is", async () => {
		const engine = restartableEngine({ features: ["stream_keepalive_v1"] });
		const body = { ...agentBody("r", "t"), stream: true };
		await send(engine, "hb-full", body);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		engine.refuseWorkers(1);
		const pending = send(engine, "hb-full", {
			...body,
			messages: [...body.messages, { role: "user", content: "t2" }],
		});
		await vi.advanceTimersByTimeAsync(POLYKV_ROOM_BACKOFF_MAX_MS);
		const response = await pending;
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("data: [DONE]");
		expect(turns(engine).length).toBeGreaterThanOrEqual(3);
	});
});

describe("a worker's heartbeat that stops", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("waits for /health and sends the same turn again", async () => {
		const engine = restartableEngine({ features: ["stream_keepalive_v1"] });
		const body = { ...agentBody("r", "t"), stream: true };
		await send(engine, "hb-dead", body);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		engine.hangTurns(1);
		const waits: boolean[] = [];
		const stop = onPolykvRoomWait("hb-dead", (state) => {
			waits.push(state.waiting);
		});
		try {
			const pending = send(engine, "hb-dead", body);
			await vi.advanceTimersByTimeAsync(40_000);
			const response = await pending;
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("data: [DONE]");
		} finally {
			stop();
		}
		expect(waits).toEqual([true, false]);
		expect(engine.calls.some((call) => call.path === "/health")).toBe(true);
		expect(turns(engine)).toHaveLength(3);
	});
});

/**
 * boot_id_v1: every completion names its process in X-OpenCoti-Boot-Id. A
 * restart between two turns is known from the first answer of the new one,
 * not from the next /props check.
 */
describe("the boot id on every response", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const poolsSentBy = (engine: Engine, sessionId: string) =>
		turns(engine)
			.filter((call) => call.body.session_id === sessionId)
			.map((call) => call.body.pool_id as number | undefined);

	it("rebuilds the pools on a changed header, and never sends the old ids again", async () => {
		const engine = restartableEngine({ bootHeader: true });
		await send(engine, "e1", agentBody("role A", "t1"));
		const generation = polykvRootGeneration("http://engine/v1");
		// Within the verify interval, and nothing faulted: only the header
		// can tell.
		engine.restartQuietly();
		await send(engine, "e1", agentBody("role A", "t2"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation + 1);
		// t2 went out before the answer that said so; it is the last one.
		const staleSends = [...engine.unknownPoolSends];
		expect(staleSends).toHaveLength(1);
		await send(engine, "e1", agentBody("role A", "t3"));
		await send(engine, "e1", agentBody("role A", "t4"));
		expect(engine.unknownPoolSends).toEqual(staleSends);
		const sent = poolsSentBy(engine, "e1").at(-1) as number;
		expect(engine.pools().get(sent)?.prompt).toContain("role A");
		// Rebuilt once, not once per signal.
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation + 1);
	});

	it("keeps the pools while the header stays the same", async () => {
		const engine = restartableEngine({ bootHeader: true });
		await send(engine, "e2", agentBody("role A", "t1"));
		const generation = polykvRootGeneration("http://engine/v1");
		await send(engine, "e2", agentBody("role A", "t2"));
		await send(engine, "e2", agentBody("role A", "t3"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation);
		expect(new Set(poolsSentBy(engine, "e2")).size).toBe(1);
	});

	it("does not rebuild twice when /props then states the same new boot id", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const engine = restartableEngine({ bootHeader: true, bootFields: true });
		await send(engine, "e3", agentBody("role A", "t1"));
		const generation = polykvRootGeneration("http://engine/v1");
		engine.restartQuietly();
		await send(engine, "e3", agentBody("role A", "t2"));
		vi.setSystemTime(Date.now() + POLYKV_VERIFY_INTERVAL_MS + 1);
		await send(engine, "e3", agentBody("role A", "t3"));
		vi.setSystemTime(Date.now() + POLYKV_VERIFY_INTERVAL_MS + 1);
		await send(engine, "e3", agentBody("role A", "t4"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation + 1);
		expect(engine.unknownPoolSends).toHaveLength(1);
	});
});

/**
 * pool_unknown_in_response_v1: a turn that named a pool the answering process
 * does not hold says so in its `opencoti` block. Served anyway -- a full
 * reprocess, never a refusal -- so it is the client's to notice.
 */
describe("a response that says its pool is unknown", () => {
	const poolsSentBy = (engine: Engine, sessionId: string) =>
		turns(engine)
			.filter((call) => call.body.session_id === sessionId)
			.map((call) => call.body.pool_id as number | undefined);

	it("rebuilds the root's pools on the next turn, and says so at info", async () => {
		const engine = restartableEngine({ poolUnknown: true });
		await send(engine, "u1", agentBody("role A", "t1"));
		const generation = polykvRootGeneration("http://engine/v1");
		const notices: Array<{ severity: string; text: string }> = [];
		const stop = onPolykvNotice("u1", (notice) => notices.push(notice));
		try {
			engine.restartQuietly();
			await send(engine, "u1", agentBody("role A", "t2"));
		} finally {
			stop();
		}
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation + 1);
		expect(notices.length).toBeGreaterThan(0);
		expect(notices.every((notice) => notice.severity === "info")).toBe(true);
		expect(notices.map((notice) => notice.text).join("\n")).toContain(
			"pool_unknown",
		);
		const stale = [...engine.unknownPoolSends];
		await send(engine, "u1", agentBody("role A", "t3"));
		expect(engine.unknownPoolSends).toEqual(stale);
		const sent = poolsSentBy(engine, "u1").at(-1) as number;
		expect(engine.pools().get(sent)?.prompt).toContain("role A");
	});

	it("reads it off the last frame of a heartbeat stream too", async () => {
		const engine = restartableEngine({
			poolUnknown: true,
			features: ["stream_keepalive_v1"],
		});
		const body = { ...agentBody("role A", "t1"), stream: true };
		await (await send(engine, "u2", body)).text();
		const generation = polykvRootGeneration("http://engine/v1");
		engine.restartQuietly();
		const response = await send(engine, "u2", body);
		// The block rides the stream's last frame: read once the stream is.
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation);
		await response.text();
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation + 1);
	});

	it("leaves the pools alone when the pool was known", async () => {
		const engine = restartableEngine({ poolUnknown: true });
		await send(engine, "u3", agentBody("role A", "t1"));
		const generation = polykvRootGeneration("http://engine/v1");
		await send(engine, "u3", agentBody("role A", "t2"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation);
	});

	it("is one rebuild with the boot id on the same response", async () => {
		const engine = restartableEngine({ poolUnknown: true, bootHeader: true });
		await send(engine, "u4", agentBody("role A", "t1"));
		const generation = polykvRootGeneration("http://engine/v1");
		engine.restartQuietly();
		await send(engine, "u4", agentBody("role A", "t2"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation + 1);
	});

	// boot id unchanged: the process stayed up and one pool went. Only the
	// chain that held it is rebuilt; the root's generation does not move.
	it("rebuilds only that agent's chain when the boot id is unchanged", async () => {
		const engine = restartableEngine({ poolUnknown: true, bootHeader: true });
		await send(engine, "ua", agentBody("role A", "t1"));
		await send(engine, "ub", agentBody("role B", "t1"));
		const [poolA] = poolsSentBy(engine, "ua");
		const [poolB] = poolsSentBy(engine, "ub");
		expect(poolA).not.toBe(poolB);
		const generation = polykvRootGeneration("http://engine/v1");
		const created = engine.pools().size;

		engine.dropPool(poolA as number);
		await send(engine, "ua", agentBody("role A", "t2"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation);

		await send(engine, "ua", agentBody("role A", "t3"));
		await send(engine, "ub", agentBody("role B", "t2"));
		// A was rebuilt: a new id, holding A's layer, known to the server.
		const newA = poolsSentBy(engine, "ua").at(-1) as number;
		expect(newA).not.toBe(poolA);
		expect(engine.pools().get(newA)?.prompt).toContain("role A");
		// B kept its pool, and nothing else was built for it.
		expect(poolsSentBy(engine, "ub")).toEqual([poolB, poolB]);
		expect(engine.pools().size).toBe(created);
		// Only A's one turn after the drop named a pool the server lacked.
		expect(engine.unknownPoolSends).toEqual([poolA]);
	});
});

/**
 * bs2 8244 2026-09-26: the engine released 26 owners idle past its TTL while
 * it kept running, each exactly five minutes after the owner's last finished
 * request, with its agents still being refused and retrying. Every lapse was
 * read as a restart, and every owner on the server was dropped with it.
 */
describe("an owner the server let go while it kept running", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	const sendIn = (
		engine: Engine,
		group: string,
		sessionId: string,
		body: object,
	) =>
		createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: "http://engine/v1",
			request: { worker: { group, sessionId, layers: 2 } },
		})("http://engine/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(body),
		});
	const poolsOf = (engine: Engine, sessionId: string) =>
		turns(engine)
			.filter((call) => call.body.session_id === sessionId)
			.map((call) => call.body.pool_id as number | undefined);

	it("drops only that owner, and does not call it a restart", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const engine = restartableEngine({ bootFields: true });
		await sendIn(engine, "lead-a", "a", agentBody("role A", "t1"));
		await sendIn(engine, "lead-b", "b", agentBody("role B", "t1"));
		const [poolA] = poolsOf(engine, "a");
		const [poolB] = poolsOf(engine, "b");
		const told: Record<string, string[]> = { a: [], b: [] };
		const stops = ["a", "b"].map((id) =>
			onPolykvNotice(id, (notice) => told[id]?.push(notice.text)),
		);
		try {
			engine.dropPool(poolA as number);
			vi.setSystemTime(Date.now() + POLYKV_VERIFY_INTERVAL_MS + 1);
			await sendIn(engine, "lead-b", "b", agentBody("role B", "t2"));
			await sendIn(engine, "lead-a", "a", agentBody("role A", "t2"));
		} finally {
			for (const stop of stops) {
				stop();
			}
		}
		// B kept its owner and its pool.
		expect(poolsOf(engine, "b")).toEqual([poolB, poolB]);
		expect(told.b).toEqual([]);
		// A was placed anew, on a pool holding its own layer.
		const newA = poolsOf(engine, "a").at(-1) as number;
		expect(newA).not.toBe(poolA);
		expect(engine.pools().get(newA)?.prompt).toContain("role A");
		expect(engine.unknownPoolSends).toEqual([]);
		expect(told.a.join(" ")).toContain("did not restart");
		expect(told.a.join(" ")).not.toMatch(/\brestarted\b/);
	});

	it("keeps every owner when a fault made the root suspect and only the listing went unanswered", async () => {
		// pandorum 2026-09-26 19:37:57Z, 4.100.206: 17 agents on 8241 told
		// "restarted (a fault, and its pools could not be confirmed)" at
		// once, every owner abandoned, and the swarm waited ten minutes for
		// cells the abandoned owners still held. /props and /health named the
		// same boot; /polykv/pools had not answered a busy engine in time.
		vi.useFakeTimers({ toFake: ["Date"] });
		const engine = restartableEngine({ bootFields: true });
		await sendIn(engine, "lead-a", "fa", agentBody("role A", "t1"));
		await sendIn(engine, "lead-b", "fb", agentBody("role B", "t1"));
		const [poolA] = poolsOf(engine, "fa");
		const [poolB] = poolsOf(engine, "fb");
		const generation = polykvRootGeneration("http://engine/v1");
		const told: string[] = [];
		const stops = ["fa", "fb"].map((id) =>
			onPolykvNotice(id, (notice) => told.push(notice.text)),
		);
		try {
			notePolykvServerFault("http://engine/v1");
			engine.listing(false);
			await sendIn(engine, "lead-a", "fa", agentBody("role A", "t2"));
			await sendIn(engine, "lead-b", "fb", agentBody("role B", "t2"));
		} finally {
			for (const stop of stops) {
				stop();
			}
			engine.listing(true);
		}
		expect(told).toEqual([]);
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation);
		expect(poolsOf(engine, "fa")).toEqual([poolA, poolA]);
		expect(poolsOf(engine, "fb")).toEqual([poolB, poolB]);
	});

	it("asks again, rather than rebuilding, when nothing on a suspect root answers", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const engine = restartableEngine({ bootFields: true });
		await sendIn(engine, "lead-a", "na", agentBody("role A", "t1"));
		const generation = polykvRootGeneration("http://engine/v1");
		notePolykvServerFault("http://engine/v1");
		engine.listing(false);
		engine.identity(false);
		await sendIn(engine, "lead-a", "na", agentBody("role A", "t2"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation);
		// It answers again as a new process: still suspect, so the next turn
		// asks at once and rebuilds.
		engine.listing(true);
		engine.identity(true);
		engine.restartQuietly();
		await sendIn(engine, "lead-a", "na", agentBody("role A", "t3"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation + 1);
		const sent = poolsOf(engine, "na").at(-1) as number;
		expect(engine.pools().get(sent)?.prompt).toContain("role A");
		expect(engine.unknownPoolSends).toEqual([]);
	});

	/** The owner the first pool create of `sessionId`'s group named. */
	const ownerOf = (engine: Engine) =>
		engine.calls.find(
			(call) =>
				call.path === "/polykv/pools" &&
				typeof call.body.session_id === "string",
		)?.body.session_id as string;
	const closed = (engine: Engine, owner: string) =>
		engine.calls.some(
			(call) => call.path === `/sessions/${encodeURIComponent(owner)}/close`,
		);
	const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("closes an abandoned owner at once when none of its agents has a turn running", async () => {
		// pandorum 2026-09-26 19:38Z: owners abandoned on a live server kept
		// their windows while their agents waited for a new owner -- which
		// could not open, because the abandoned ones held every cell.
		const engine = restartableEngine({ bootFields: true });
		const first = await sendIn(
			engine,
			"lead-c",
			"c1",
			agentBody("role A", "t1"),
		);
		const second = await sendIn(
			engine,
			"lead-c",
			"c2",
			agentBody("role A", "t1"),
		);
		await first.text();
		await second.text();
		const owner = ownerOf(engine);
		invalidatePolykvRoot("http://engine/v1", "a test");
		await settle();
		expect(closed(engine, owner)).toBe(true);
	});

	it("keeps an abandoned owner until the turn running on it ends, then closes it", async () => {
		const engine = restartableEngine({ bootFields: true });
		await (
			await sendIn(engine, "lead-d", "d1", agentBody("role A", "t1"))
		).text();
		const running = await sendIn(
			engine,
			"lead-d",
			"d1",
			agentBody("role A", "t2"),
		);
		const owner = ownerOf(engine);
		invalidatePolykvRoot("http://engine/v1", "a test");
		await settle();
		expect(closed(engine, owner)).toBe(false);
		await running.text();
		await settle();
		expect(closed(engine, owner)).toBe(true);
	});

	it("still drops everything when the boot id changed with the pools", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const engine = restartableEngine({ bootFields: true });
		await sendIn(engine, "lead-a", "a2", agentBody("role A", "t1"));
		await sendIn(engine, "lead-b", "b2", agentBody("role B", "t1"));
		const generation = polykvRootGeneration("http://engine/v1");
		engine.restartQuietly();
		vi.setSystemTime(Date.now() + POLYKV_VERIFY_INTERVAL_MS + 1);
		await sendIn(engine, "lead-b", "b2", agentBody("role B", "t2"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation + 1);
	});

	it("keeps an owner with agents from lapsing, at the window the server holds", async () => {
		const engine = restartableEngine({
			bootFields: true,
			ownerKv: true,
			features: ["kv_status_v1", "kv_resize_v1"],
		});
		await send(engine, "k", agentBody("role A", "t1"));
		expect(await keepPolykvOwnersAlive("http://engine/v1", engine.fetch)).toBe(
			1,
		);
		const resizes = engine.calls.filter(
			(call) => call.path === "/sessions/resize",
		);
		expect(resizes).toHaveLength(1);
		expect(String(resizes[0]?.body.session_id)).toContain("polykv-owner");
		// The window /kv states, not one remembered: never a grow.
		expect(resizes[0]?.body.num_ctx).toBe(65_536);

		// With its last agent gone the owner is closed, and nothing is kept.
		await releasePolykvAgent("k");
		expect(await keepPolykvOwnersAlive("http://engine/v1", engine.fetch)).toBe(
			0,
		);
		expect(
			engine.calls.filter((call) => call.path === "/sessions/resize"),
		).toHaveLength(1);
	});
});
