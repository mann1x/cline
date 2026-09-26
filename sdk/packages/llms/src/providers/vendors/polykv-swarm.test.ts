import { afterEach, describe, expect, it } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import { resetPolykvAvailability } from "./polykv";
import {
	engineSessionId,
	onPolykvNotice,
	onPolykvRoomWait,
	polykvSwarmState,
	releaseAllPolykvSwarms,
	releasePolykvAgent,
	releasePolykvSwarmsOf,
} from "./polykv-swarm";

/**
 * A stub engine with the parts of the contract the swarm relies on.
 *
 * `/apply-template` renders messages the way a chat template does -- one
 * delimited block per turn -- so a layer cut at the sentinel is a byte-prefix
 * of the full rendering exactly when the real template's would be.
 */
function stubEngine(
	options: {
		refuseWorkersTimes?: number;
		/** What `/props` advertises; `session_close_v1` unless a test says. */
		features?: string[];
		/** What a close of an agent's own session answers for `found`. */
		agentCloseFound?: boolean;
		/** Held before the owner's opening request is answered. */
		holdOwnerOpen?: Promise<void>;
		onOwnerOpen?: () => void;
	} = {},
) {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	let nextPool = 0;
	let refusals = options.refuseWorkersTimes ?? 0;
	// Gemma-4's shape: the system turn carries the thinking flag unless the
	// request's budget is 0, and `/apply-template` reads the same field.
	const render = (
		messages: Array<{ role: string; content: unknown }>,
		fields: Record<string, unknown> = {},
	) =>
		messages
			.map(
				(message) =>
					`<|${message.role}|>${
						message.role === "system" && fields.reasoning_budget_tokens !== 0
							? "<|think|>"
							: ""
					}${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}<|end|>`,
			)
			.join("");
	const pools = new Map<number, string>();
	const matchOf = (pool: string, request: string) => {
		let at = 0;
		while (at < pool.length && pool[at] === request[at]) at += 1;
		return at;
	};
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: {};
		calls.push({ path: url.pathname, body });
		const json = (value: unknown, status = 200, headers = {}) =>
			new Response(JSON.stringify(value), {
				status,
				headers: { "content-type": "application/json", ...headers },
			});
		if (url.pathname === "/kv") {
			return json({ session_ctx_max: 262_144 });
		}
		if (url.pathname === "/props") {
			return json({ features: options.features ?? ["session_close_v1"] });
		}
		if (url.pathname === "/apply-template") {
			return json({
				prompt: render(
					body.messages as Array<{ role: string; content: unknown }>,
					body,
				),
			});
		}
		if (url.pathname === "/polykv/pools" && init?.method === "GET") {
			// The listing: what a restart check reads.
			return json({
				pools: [...pools.keys()].map((id) => ({ pool_id: id })),
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
			const found =
				url.pathname.includes("polykv-owner") ||
				options.agentCloseFound !== false;
			return json({ found, released: found });
		}
		if (
			url.pathname === "/v1/chat/completions" &&
			body.max_tokens === 1 &&
			String(body.session_id).includes("polykv-owner")
		) {
			options.onOwnerOpen?.();
			await options.holdOwnerOpen;
		}
		if (url.pathname === "/v1/chat/completions") {
			if (body.pool_id !== undefined && refusals > 0) {
				refusals -= 1;
				return json(
					{
						error: {
							message:
								"admission rejected: session allocation full (worker of 'x': 0 of 65536 cells free, needs 75) — compact the session",
						},
					},
					429,
					{ "retry-after": "0" },
				);
			}
			const pool =
				typeof body.pool_id === "number" ? pools.get(body.pool_id) : undefined;
			const request = render(
				body.messages as Array<{ role: string; content: unknown }>,
				body,
			);
			return json({
				choices: [{ message: { content: "ok" } }],
				...(pool !== undefined
					? {
							opencoti: {
								pool_id: body.pool_id,
								pool_match: matchOf(pool, request),
								pool_len: pool.length,
							},
						}
					: {}),
			});
		}
		return json({ error: "no route" }, 404);
	}) as unknown as typeof fetch;
	return { calls, fetch: fetchImpl, pools };
}

function agentBody(role: string, task: string, knowledge = "the shared file") {
	return {
		model: "m",
		messages: [
			{ role: "system", content: "base prompt" },
			{ role: "user", content: knowledge },
			{ role: "user", content: role },
			{ role: "user", content: task },
		],
		tools: [{ type: "function", function: { name: "read_files" } }],
		num_ctx: 262_144,
	};
}

async function send(
	engine: ReturnType<typeof stubEngine>,
	sessionId: string,
	body: Record<string, unknown>,
) {
	const fetchImpl = createOpencotiFetch({
		fetch: engine.fetch,
		baseUrl: "http://engine/v1",
		request: { worker: { group: "lead-1", sessionId, layers: 2 } },
	});
	return fetchImpl("http://engine/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

const sent = (engine: ReturnType<typeof stubEngine>) =>
	engine.calls.filter(
		(call) =>
			call.path === "/v1/chat/completions" && call.body.max_tokens !== 1,
	);

afterEach(async () => {
	await releaseAllPolykvSwarms();
	resetPolykvAvailability();
});

/**
 * P2: a worker is charged to its owner's window, and the engine can refuse it
 * at arrival -- before a prefill is spent -- only if the request says how long
 * the reply may run. The gateway sends no cap for a model the catalog does not
 * know, so the worker's fetch declares one itself.
 */
describe("a worker's output cap", () => {
	async function workerBody(
		body: Record<string, unknown>,
		workerMaxTokens?: number,
	) {
		const engine = stubEngine();
		const fetchImpl = createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: "http://engine/v1",
			request: {
				worker: { group: "cap-lead", sessionId: "cap-agent", layers: 2 },
				...(workerMaxTokens !== undefined ? { workerMaxTokens } : {}),
			},
		});
		await fetchImpl("http://engine/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		return sent(engine).at(-1)?.body;
	}

	it("declares one when the request carried none", async () => {
		const body = await workerBody(agentBody("role", "task"), 12_000);
		expect(body?.max_tokens).toBe(12_000);
	});

	it("keeps the cap the gateway sent", async () => {
		const body = await workerBody(
			{ ...agentBody("role", "task"), max_tokens: 4_096 },
			12_000,
		);
		expect(body?.max_tokens).toBe(4_096);
	});
});

describe("a PolyKV swarm", () => {
	// The whole point: fifty agents given the same knowledge and role are one
	// prefill and one set of cells, not fifty.
	it("builds the shared tree once for agents that share it", async () => {
		const engine = stubEngine();
		await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				send(
					engine,
					`agent-${index}`,
					agentBody("brace role", `task ${index}`),
				),
			),
		);

		const owners = engine.calls.filter(
			(call) =>
				call.path === "/v1/chat/completions" && call.body.max_tokens === 1,
		);
		expect(owners).toHaveLength(1);
		expect(owners[0]?.body.num_ctx).toBe(262_144);
		expect(
			engine.calls.filter((call) => call.path === "/polykv/pools"),
		).toHaveLength(1);
		expect(
			engine.calls.filter((call) => call.path.endsWith("/fork")),
		).toHaveLength(2);
		// Every worker attaches to the deepest layer, as itself, booking nothing.
		const workers = sent(engine);
		expect(workers).toHaveLength(6);
		for (const [index, worker] of workers.entries()) {
			expect(worker.body.pool_id).toBe(2);
			expect(String(worker.body.session_id)).toMatch(/^agent-\d$/);
			expect(worker.body.num_ctx).toBeUndefined();
			expect(worker.body.session_id).not.toBe(
				workers[(index + 1) % 6]?.body.session_id,
			);
		}
	});

	// 8240 2026-09-24: the workers sent `reasoning_budget_tokens: 0`, the pools
	// were rendered without it, and every attach shared 4 tokens of ~5.6k.
	it("renders its pools the way the request renders, thinking flag and all", async () => {
		const engine = stubEngine();
		const notices: string[] = [];
		const stop = onPolykvNotice("a", (notice) => notices.push(notice.text));
		try {
			const response = await send(engine, "a", {
				...agentBody("brace role", "t1"),
				reasoning_budget_tokens: 0,
			});
			const block = (
				(await response.json()) as { opencoti: Record<string, number> }
			).opencoti;
			expect(block.pool_match).toBe(block.pool_len);
		} finally {
			stop();
		}
		for (const call of engine.calls.filter(
			(entry) => entry.path === "/apply-template",
		)) {
			expect(call.body.reasoning_budget_tokens).toBe(0);
			expect(call.body.session_id).toBeUndefined();
		}
		expect(notices).toEqual([]);
	});

	// The client could not see the divergence: a worker's response went past
	// unread, so "4 of 5,627" reached the server log and nowhere else.
	it("tells the agent when its request diverges from the pool", async () => {
		const engine = stubEngine();
		await send(engine, "a", agentBody("brace role", "t1"));
		const notices: Array<{ severity: string; text: string }> = [];
		const stop = onPolykvNotice("b", (notice) => notices.push(notice));
		try {
			// Same pools (same signature), but this request renders without
			// the flag: the stub then reports the divergence, as b45 does.
			for (const [id, prompt] of engine.pools) {
				engine.pools.set(id, prompt.replace("<|think|>", "<|THINK|>"));
			}
			const response = await send(engine, "b", agentBody("brace role", "t2"));
			await response.json();
		} finally {
			stop();
		}
		expect(notices).toHaveLength(1);
		expect(notices[0]?.severity).toBe("warn");
		expect(notices[0]?.text).toMatch(/shared only \d+ of its \d+ tokens/);
		expect(notices[0]?.text).toMatch(/diverges .* at token \d+/);
	});

	it("gives a second role its own layer on the same knowledge", async () => {
		const engine = stubEngine();
		await send(engine, "a", agentBody("brace role", "t1"));
		await send(engine, "b", agentBody("trace role", "t2"));

		const forks = engine.calls.filter((call) => call.path.endsWith("/fork"));
		// knowledge once, then one role layer each -- both forked from it
		expect(forks.map((call) => call.path)).toEqual([
			"/polykv/pools/0/fork",
			"/polykv/pools/1/fork",
			"/polykv/pools/1/fork",
		]);
		const workers = sent(engine);
		expect(workers[0]?.body.pool_id).toBe(2);
		expect(workers[1]?.body.pool_id).toBe(3);
	});

	// Each layer ends after the next turn's opener, or a warm slot that last
	// served the same role beats the pool and the worker runs on a private copy.
	it("cuts each layer after the opener of the turn that follows it", async () => {
		const engine = stubEngine();
		await send(engine, "a", agentBody("brace role", "t1"));
		const created = engine.calls.find((call) => call.path === "/polykv/pools");
		expect(String(created?.body.prompt)).toMatch(/<\|user\|>$/);
		expect(created?.body.session_id).toMatch(/polykv-owner-1$/);
		expect(created?.body.pin).toBe(true);
	});

	it("never attaches a layer that is not a prefix of the request", async () => {
		const engine = stubEngine();
		// Two leading turns that are not user turns cannot be layers.
		await send(engine, "a", {
			model: "m",
			messages: [
				{ role: "system", content: "s" },
				{ role: "assistant", content: "not a layer" },
				{ role: "user", content: "r" },
				{ role: "user", content: "t" },
			],
		});
		expect(sent(engine)[0]?.body.pool_id).toBeUndefined();
		expect(engine.calls.some((call) => call.path.startsWith("/polykv"))).toBe(
			false,
		);
	});

	// A full owner is a queue on a window the other agents are draining.
	it("waits out a full owner instead of failing the agent", async () => {
		const engine = stubEngine({ refuseWorkersTimes: 3 });
		const response = await send(engine, "a", agentBody("r", "t"));
		expect(response.status).toBe(200);
		// First refusal on a first turn tries a fresh owner, the rest wait.
		const owners = engine.calls.filter(
			(call) =>
				call.path === "/v1/chat/completions" && call.body.max_tokens === 1,
		);
		expect(owners.length).toBe(2);
		expect(sent(engine)).toHaveLength(4);
	});

	// The wait is inside this fetch, where the agent's row cannot be reached:
	// the row said "running" for as long as it waited.
	it("reports the wait for room, and its end, once each", async () => {
		const engine = stubEngine({ refuseWorkersTimes: 3 });
		const states: boolean[] = [];
		const stop = onPolykvRoomWait("a", (state) => states.push(state.waiting));
		try {
			await send(engine, "a", agentBody("r", "t"));
		} finally {
			stop();
		}
		expect(states).toEqual([true, false]);
	});

	// A summary call is the agent's, but not its conversation: charged to the
	// owner as a worker, it books no window of its own.
	it("attaches an agent's other requests to its tree without building", async () => {
		const engine = stubEngine();
		await send(engine, "a", agentBody("r", "t"));
		// Builds only: a restart check's listing reads, it builds nothing.
		const builds = () =>
			engine.calls.filter(
				(call) =>
					call.path.startsWith("/polykv") && Object.keys(call.body).length > 0,
			).length;
		const poolsBefore = builds();

		const summary = createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: "http://engine/v1",
			request: {
				worker: {
					group: "lead-1",
					sessionId: "a",
					layers: 2,
					attachOnly: true,
				},
			},
		});
		await summary("http://engine/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({
				model: "m",
				messages: [
					{ role: "system", content: "summarize" },
					{ role: "user", content: "the transcript" },
				],
				num_ctx: 262_144,
			}),
		});

		const last = sent(engine).at(-1);
		expect(last?.body.pool_id).toBe(0);
		expect(last?.body.session_id).toBe("a");
		expect(last?.body.num_ctx).toBeUndefined();
		expect(builds()).toBe(poolsBefore);
	});

	it("closes the agent's session, and the owner with its last agent", async () => {
		const engine = stubEngine();
		await send(engine, "agent/one", agentBody("r", "t1"));
		await send(engine, "agent/two", agentBody("r", "t2"));

		const first = await releasePolykvAgent("agent/one");
		expect(first.failed).toEqual([]);
		expect(first.closed).toEqual(["agent~one"]);
		expect(polykvSwarmState()[0]?.owners).toHaveLength(1);

		const second = await releasePolykvAgent("agent/two");
		expect(second.closed).toContain("agent~two");
		expect(second.closed.some((id) => id.endsWith("polykv-owner-1"))).toBe(
			true,
		);
		expect(polykvSwarmState()).toEqual([]);
		// The engine's close route cannot carry a slash.
		const closes = engine.calls.filter((call) =>
			call.path.startsWith("/sessions/"),
		);
		expect(
			closes.every(
				(call) => !decodeURIComponent(call.path).slice(10).includes("/close/"),
			),
		).toBe(true);
		expect(closes.map((call) => call.path)).toContain(
			"/sessions/agent~one/close",
		);
	});
});

describe("engine session ids", () => {
	it("carry no character the close route cannot", () => {
		expect(engineSessionId("lead/agent-1")).toBe("lead~agent-1");
		expect(engineSessionId("1790137120308_fotu9")).toBe("1790137120308_fotu9");
	});
});

/**
 * An engine whose owners fill independently: workers of a full owner are
 * refused, and `/kv` reports each owner's room.
 */
function ownerAwareEngine() {
	const full = new Set<string>();
	const poolOwner = new Map<number, string>();
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	const owners = new Set<string>();
	let nextPool = 0;
	const render = (messages: Array<{ role: string; content: unknown }>) =>
		messages.map((m) => `<|${m.role}|>${String(m.content)}<|end|>`).join("");
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: {};
		calls.push({ path: url.pathname, body });
		const json = (value: unknown, status = 200) =>
			new Response(JSON.stringify(value), {
				status,
				headers: { "content-type": "application/json", "retry-after": "0" },
			});
		if (url.pathname === "/kv") {
			return json({
				session_ctx_max: 65_536,
				allocations: [...owners].map((key) => ({
					key,
					cells: 65_536,
					used: full.has(key) ? 65_536 : 1_000,
				})),
			});
		}
		if (url.pathname === "/apply-template") {
			return json({ prompt: render(body.messages as never) });
		}
		if (url.pathname === "/polykv/pools" || url.pathname.endsWith("/fork")) {
			const id = nextPool++;
			poolOwner.set(id, String(body.session_id));
			return json({ pool_id: id, parent: -1, prefix_len: 100 });
		}
		if (url.pathname.endsWith("/admission")) {
			return json({ ok: true });
		}
		if (/^\/sessions\/[^/]+\/close$/.test(url.pathname)) {
			owners.delete(decodeURIComponent(url.pathname.split("/")[2] ?? ""));
			return json({ found: true });
		}
		if (url.pathname === "/v1/chat/completions") {
			if (body.max_tokens === 1) {
				owners.add(String(body.session_id));
				return json({ choices: [] });
			}
			const owner = poolOwner.get(Number(body.pool_id));
			if (owner && full.has(owner)) {
				return json(
					{
						error: {
							message:
								"admission rejected: session allocation full (worker of 'x')",
						},
					},
					429,
				);
			}
			return json({ choices: [{ message: { content: "ok" } }] });
		}
		return json({ error: "no route" }, 404);
	}) as unknown as typeof fetch;
	return { calls, full, poolOwner, owners, fetch: fetchImpl };
}

describe("a refused worker", () => {
	// 2026-09-24: four owners booked the whole server, one full and three at
	// 3-8%, and the full one's agents waited on it for up to 15 minutes.
	it("moves to the owner with room instead of waiting on a full one", async () => {
		const engine = ownerAwareEngine();
		const agent = (sessionId: string) =>
			createOpencotiFetch({
				fetch: engine.fetch,
				baseUrl: "http://engine/v1",
				request: { worker: { group: "lead-m", sessionId, layers: 2 } },
			});
		const call = (f: typeof fetch, task: string) =>
			f("http://engine/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify(agentBody("r", task)),
			});

		const a = agent("a");
		expect((await call(a, "t1")).status).toBe(200);
		const first = [...engine.owners][0] as string;
		// b opens a second owner because the first is full for it.
		engine.full.add(first);
		expect((await call(agent("b"), "t2")).status).toBe(200);
		expect(engine.owners.size).toBe(2);

		// a has run already, so it may not open a fresh owner: it moves.
		expect((await call(a, "t3")).status).toBe(200);
		const last = engine.calls
			.filter(
				(c) => c.path === "/v1/chat/completions" && c.body.max_tokens !== 1,
			)
			.at(-1);
		expect(engine.poolOwner.get(Number(last?.body.pool_id))).not.toBe(first);
		// a was the full owner's only agent, so its window went back.
		expect(engine.owners.has(first)).toBe(false);
	});
});

describe("the admission policy", () => {
	it("is posted on every pool a worker's tree creates", async () => {
		const engine = ownerAwareEngine();
		const f = createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: "http://engine/v1",
			request: {
				worker: {
					group: "lead-p",
					sessionId: "a",
					layers: 2,
					admission: { target_tps_per_session: 15, mode: "enforced" },
				},
			},
		});
		await f("http://engine/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(agentBody("r", "t")),
		});
		const posted = engine.calls.filter((c) => c.path.endsWith("/admission"));
		expect(posted.map((c) => c.path)).toEqual([
			"/polykv/pools/0/admission",
			"/polykv/pools/1/admission",
			"/polykv/pools/2/admission",
		]);
		expect(posted[0]?.body).toEqual({
			target_tps_per_session: 15,
			mode: "enforced",
		});
	});
});

describe("an agent's release, as the engine answers it", () => {
	it("says when the engine held no session for an agent that should have had one", async () => {
		const engine = stubEngine({ agentCloseFound: false });
		await send(engine, "agent/one", agentBody("r", "t1"));

		const released = await releasePolykvAgent("agent/one");

		expect(released.notFound).toEqual(["agent~one"]);
		expect(released.closed).not.toContain("agent~one");
		expect(released.failed).toEqual([]);
	});

	it("does not ask a server without session_close_v1 to close the agent's session", async () => {
		const engine = stubEngine({ features: [] });
		await send(engine, "agent/one", agentBody("r", "t1"));

		const released = await releasePolykvAgent("agent/one");

		expect(released.unsupported).toEqual(["agent~one"]);
		expect(released.closed).not.toContain("agent~one");
		expect(
			engine.calls.some((call) => call.path === "/sessions/agent~one/close"),
		).toBe(false);
	});
});

describe("an owner nobody is left on", () => {
	// An agent released while its request waited on the owner's opening was
	// added to that owner after its release, and the release had already
	// dropped the group: the owner, and every pool it owns, stayed booked
	// until the engine's idle TTL, where not even a shutdown could reach it.
	it("is closed when the agent it was opened for was released while it opened", async () => {
		let reached!: () => void;
		const atOwnerOpen = new Promise<void>((resolve) => {
			reached = resolve;
		});
		let open!: () => void;
		const engine = stubEngine({
			holdOwnerOpen: new Promise<void>((resolve) => {
				open = resolve;
			}),
			onOwnerOpen: () => reached(),
		});
		const pending = send(engine, "agent/one", agentBody("r", "t1"));
		await atOwnerOpen;
		await releasePolykvAgent("agent/one");
		open();
		await pending;

		expect(
			engine.calls.some(
				(call) =>
					call.path.startsWith("/sessions/") &&
					call.path.includes("polykv-owner"),
			),
		).toBe(true);
		expect(polykvSwarmState()).toEqual([]);
	});
});

describe("the end of the lead's session", () => {
	async function sendAs(
		engine: ReturnType<typeof stubEngine>,
		group: string,
		sessionId: string,
		body: Record<string, unknown>,
	) {
		const fetchImpl = createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: "http://engine/v1",
			request: { worker: { group, sessionId, layers: 2 } },
		});
		return fetchImpl("http://engine/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(body),
		});
	}

	// Its agents are being stopped with it, and each one's own release lands
	// whenever its abort does -- or never, on a path that throws first. The
	// owners the lead's swarm opened go back with the lead, not at the TTL.
	it("releases the owners its agents were on, and no other lead's", async () => {
		const engine = stubEngine();
		await sendAs(engine, "lead-1", "agent/one", agentBody("r", "t1"));
		await sendAs(engine, "lead-2", "agent/two", agentBody("r", "t2"));
		const ownerOf = (lead: string) =>
			polykvSwarmState().find((group) => group.group.includes(`\n${lead}`))
				?.owners[0]?.sessionId;
		const first = ownerOf("lead-1");
		const second = ownerOf("lead-2");
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		const closed = (owner: string | undefined) =>
			engine.calls.some((call) => call.path === `/sessions/${owner}/close`);

		expect(await releasePolykvSwarmsOf("lead-1")).toBe(1);

		expect(closed(first)).toBe(true);
		expect(closed(second)).toBe(false);
		expect(ownerOf("lead-1")).toBeUndefined();
		expect(ownerOf("lead-2")).toBe(second);
		// The agent's own release, landing after, still closes its session.
		const late = await releasePolykvAgent("agent/one");
		expect(late.closed).toEqual(["agent~one"]);
	});

	it("releases nothing for a lead that opened nothing", async () => {
		expect(await releasePolykvSwarmsOf("nobody")).toBe(0);
	});
});
