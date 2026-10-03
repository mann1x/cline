import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import {
	latestOpencotiPressure,
	opencotiPressureState,
	opencotiResizesLive,
	readOpencotiKv,
	resetOpencotiPendingResizes,
	resetOpencotiPressure,
	resizeOpencotiSession,
} from "./opencoti-kv-pressure";
import { resetPolykvAvailability, resetPolykvSessions } from "./polykv";
import {
	polykvLeadHasAgentsOn,
	polykvOwnerAgentCapacity,
	polykvOwnerBooking,
	polykvOwnerWindowBounds,
	polykvWorkerChargedTo,
	releaseAllPolykvSwarms,
	releasePolykvAgent,
} from "./polykv-swarm";

/**
 * An owner is booked for the agents it carries, not for one of them.
 *
 * Live on 8244 (b108, 2026-09-25): a 75-agent swarm on a 64k node window.
 * Every owner was booked at 65,536 -- one agent's window -- while the engine
 * charges every pooled worker's private cells to its owner. The second and
 * third worker of an owner were refused ("session allocation full (worker of
 * ...)") with 786k+ base cells free. The node window is the budget PER AGENT.
 */

const GROUP = "1790358391102_4gzry";
const OWNER_1 = `${GROUP}~polykv-owner-1`;
const OWNER_2 = `${GROUP}~polykv-owner-2`;
const NODE_WINDOW = 65_536;
const FEATURES = [
	"elastic_guaranteed_alloc_v1",
	"ctx_min_negotiation_v1",
	"kv_status_v1",
	"kv_pressure_v1",
	"kv_resize_v1",
];

/** The engine's words, verbatim from the 8244 log and a 429 of that run. */
const SESSION_FULL_TEXT = `admission rejected: session allocation full (worker of '${OWNER_1}': 21316 of 65536 cells free, needs 22967) — compact the session (base 983040 free of 1048576 cells, needs 0; swa 56320 free of 65536 cells, needs 0; largest window admissible now 262144)`;
const SESSION_FULL_PRESSURE = {
	window_s: 60,
	refused_60s: 4,
	refused_peak_max_60s: 32_521,
	refused_needed_max_60s: 0,
	refused_min_needed_min_60s: 32_521,
	last_refusal_age_s: 1,
	refusals_total: 4,
};

interface Call {
	path: string;
	body: Record<string, unknown>;
}

function json(
	value: unknown,
	status = 200,
	headers: Record<string, string> = {},
) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

function engine(
	options: {
		features?: string[];
		maximum?: number;
		/** The window an owner open is granted; default what it asked. */
		grant?: (asked: number) => number;
		/** Answers to resizes, in order; the last repeats. Default: taken. */
		resize?: Array<(body: Record<string, unknown>) => Response>;
		/** Answers to worker turns, in order; the last repeats. Default: 200. */
		worker?: Array<() => Response>;
		/** `/kv` allocation rows, as the engine would list them now. */
		kvRows?: () => Array<{ session_id: string; window: number; used: number }>;
	} = {},
) {
	const calls: Call[] = [];
	let nextPool = 0;
	/** The pools this engine holds, listed as a real one lists them. */
	const pools = new Map<number, number>();
	let resizes = 0;
	let workers = 0;
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: {};
		calls.push({ path: url.pathname, body });
		if (url.pathname === "/props") {
			return json({ features: options.features ?? FEATURES });
		}
		if (url.pathname === "/kv") {
			return json({
				session_ctx_max: options.maximum ?? 262_144,
				...(options.kvRows ? { allocations: options.kvRows() } : {}),
			});
		}
		if (url.pathname === "/apply-template") {
			return json({
				prompt: (body.messages as Array<{ role: string; content: string }>)
					.map((message) => `<|${message.role}|>${message.content}<|end|>`)
					.join(""),
			});
		}
		if (url.pathname === "/polykv/pools" && !init?.body) {
			// A listing that left out a live pool would read as a restart that
			// took it, and the owner would be closed and opened again.
			return json({
				pools: [...pools].map(([pool_id, parent]) => ({ pool_id, parent })),
			});
		}
		if (url.pathname === "/polykv/pools" || url.pathname.endsWith("/fork")) {
			const fork = /^\/polykv\/pools\/(\d+)\/fork$/.exec(url.pathname);
			const parent = fork ? Number(fork[1]) : -1;
			pools.set(nextPool, parent);
			return json({ pool_id: nextPool++, parent, prefix_len: 9_554 });
		}
		const released = /^\/polykv\/pools\/(\d+)\/release$/.exec(url.pathname);
		if (released) {
			pools.delete(Number(released[1]));
			return json({ ok: true });
		}
		if (/^\/polykv\/pools\/\d+\/(pin|unpin)$/.test(url.pathname)) {
			return json({ ok: true });
		}
		if (/^\/sessions\/[^/]+\/close$/.test(url.pathname)) {
			return json({ found: true, released: true });
		}
		if (url.pathname.endsWith("/resize")) {
			const answers = options.resize ?? [];
			const answer =
				answers[Math.min(resizes, answers.length - 1)] ??
				((sent: Record<string, unknown>) =>
					json({ ok: true, window_new: sent.num_ctx }));
			resizes += 1;
			return answer(body);
		}
		if (url.pathname === "/v1/chat/completions") {
			if (body.max_tokens === 1) {
				const asked = body.num_ctx as number;
				const granted = options.grant ? options.grant(asked) : asked;
				return json({ choices: [] }, 200, {
					"x-context-window": String(granted),
				});
			}
			const answers = options.worker ?? [];
			const answer = answers[Math.min(workers, answers.length - 1)];
			workers += 1;
			return answer
				? answer()
				: json({ choices: [{ message: { content: "ok" } }] }, 200, {
						"x-context-window": "262144",
					});
		}
		return json({}, 404);
	}) as unknown as typeof fetch;
	return {
		calls,
		fetch: fetchImpl,
		opens: () =>
			calls.filter(
				(call) =>
					call.path === "/v1/chat/completions" && call.body.max_tokens === 1,
			),
		resizes: () => calls.filter((call) => call.path.endsWith("/resize")),
		workers: () =>
			calls.filter(
				(call) =>
					call.path === "/v1/chat/completions" && call.body.max_tokens !== 1,
			),
	};
}

function agentBody(role = "the role") {
	return {
		model: "m",
		messages: [
			{ role: "system", content: "You are an agent." },
			{ role: "user", content: "the shared knowledge" },
			{ role: "user", content: role },
			{ role: "user", content: "the task" },
		],
		max_tokens: 8_192,
	};
}

function send(stub: ReturnType<typeof engine>, agent: string, role?: string) {
	return createOpencotiFetch({
		fetch: stub.fetch,
		baseUrl: "http://engine/v1",
		request: {
			worker: { group: GROUP, sessionId: agent, layers: 2 },
			agentWindow: { contextWindow: NODE_WINDOW, sharePercent: 50 },
		},
	})("http://engine/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify(agentBody(role)),
	});
}

/** Pools the engine was asked to make: roots and forks. */
function poolCreates(stub: ReturnType<typeof engine>) {
	return stub.calls.filter(
		(call) => call.path === "/polykv/pools" || call.path.endsWith("/fork"),
	).length;
}

beforeEach(() => {
	resetPolykvAvailability();
	resetPolykvSessions();
	resetOpencotiPressure();
	resetOpencotiPendingResizes();
});

afterEach(async () => {
	await releaseAllPolykvSwarms();
});

describe("an owner's booking", () => {
	it("is the per-agent window times the agents it can carry, capped at session_ctx_max", () => {
		expect(polykvOwnerBooking({ ask: 65_536, floor: 40_000 }, 262_144)).toEqual(
			{ window: 262_144, windowMin: 40_000, agents: 4 },
		);
		expect(
			polykvOwnerBooking({ ask: 100_000, floor: 60_000 }, 262_144),
		).toEqual({ window: 200_000, windowMin: 60_000, agents: 2 });
		// One agent's window is all the engine allows: one agent.
		expect(
			polykvOwnerBooking({ ask: 262_144, floor: 60_000 }, 262_144),
		).toEqual({ window: 262_144, windowMin: 60_000, agents: 1 });
		// A node window above the maximum is clamped to it.
		expect(
			polykvOwnerBooking({ ask: 400_000, floor: 60_000 }, 262_144),
		).toEqual({ window: 262_144, windowMin: 60_000, agents: 1 });
	});

	it("carries as many agents as fit, the shared prefix counted once", () => {
		expect(polykvOwnerAgentCapacity(262_144, 65_536)).toBe(4);
		// (262,144 - 9,554) / (65,536 - 9,554) = 4.5
		expect(polykvOwnerAgentCapacity(262_144, 65_536, 9_554)).toBe(4);
		expect(polykvOwnerAgentCapacity(131_072, 65_536, 9_554)).toBe(2);
		expect(polykvOwnerAgentCapacity(65_536, 65_536, 9_554)).toBe(1);
		// Less than one window still carries the agent that opened it.
		expect(polykvOwnerAgentCapacity(40_000, 65_536)).toBe(1);
	});

	it("asks the engine for every agent's window at open, floored at one agent's share", async () => {
		const stub = engine();
		const response = await send(stub, "agent-a");
		expect(response.status).toBe(200);
		const [open] = stub.opens();
		expect(open?.body.session_id).toBe(OWNER_1);
		expect(open?.body.num_ctx).toBe(262_144);
		const floor = open?.body.num_ctx_min as number;
		expect(floor).toBeGreaterThan(0);
		expect(floor).toBeLessThan(NODE_WINDOW);
		// One agent on it: the floor a pressure shrink keeps is one agent's.
		expect(polykvOwnerWindowBounds(OWNER_1)).toEqual({
			floor,
			ceiling: 262_144,
		});
	});

	it("scales the floor a pressure shrink keeps with the agents on the owner", async () => {
		const stub = engine();
		await send(stub, "agent-a");
		await send(stub, "agent-b");
		await send(stub, "agent-c");
		const floor = stub.opens()[0]?.body.num_ctx_min as number;
		expect(polykvOwnerWindowBounds(OWNER_1)).toEqual({
			floor: 3 * floor,
			ceiling: 262_144,
		});
	});
});

describe("placing agents on owners", () => {
	it("opens another owner when the first carries all it can", async () => {
		const stub = engine({ maximum: 131_072 });
		for (const agent of ["agent-a", "agent-b", "agent-c"]) {
			expect((await send(stub, agent)).status).toBe(200);
		}
		expect(stub.opens().map((open) => open.body.session_id)).toEqual([
			OWNER_1,
			OWNER_2,
		]);
		expect(polykvWorkerChargedTo("agent-a")).toBe(OWNER_1);
		expect(polykvWorkerChargedTo("agent-b")).toBe(OWNER_1);
		expect(polykvWorkerChargedTo("agent-c")).toBe(OWNER_2);
	});

	// pandorum .211: owners reserved a node window per agent and sat 14-46%
	// used while 34 agents waited for a new owner. Placed by what the engine
	// measured, the owner that has the room takes the agent.
	it("places an agent on a full-by-count owner that the engine measures mostly empty", async () => {
		const stub = engine({
			maximum: 131_072,
			kvRows: () => [{ session_id: OWNER_1, window: 131_072, used: 30_000 }],
		});
		await send(stub, "agent-a");
		await send(stub, "agent-b");
		await readOpencotiKv("http://engine/v1", stub.fetch);
		expect((await send(stub, "agent-c")).status).toBe(200);
		expect(stub.opens()).toHaveLength(1);
		expect(polykvWorkerChargedTo("agent-c")).toBe(OWNER_1);
	});

	it("opens another owner when the measured room is short of the first turn", async () => {
		const stub = engine({
			maximum: 131_072,
			kvRows: () => [{ session_id: OWNER_1, window: 131_072, used: 128_000 }],
		});
		await send(stub, "agent-a");
		await send(stub, "agent-b");
		await readOpencotiKv("http://engine/v1", stub.fetch);
		await send(stub, "agent-c");
		expect(polykvWorkerChargedTo("agent-c")).toBe(OWNER_2);
	});

	it("never puts more agents on an owner than it carries, however many arrive at once", async () => {
		const stub = engine({ maximum: 131_072 });
		const agents = ["a1", "a2", "a3", "a4", "a5"];
		const responses = await Promise.all(agents.map((a) => send(stub, a)));
		expect(responses.map((r) => r.status)).toEqual(agents.map(() => 200));
		const perOwner = new Map<string, number>();
		for (const agent of agents) {
			const owner = polykvWorkerChargedTo(agent) ?? "none";
			perOwner.set(owner, (perOwner.get(owner) ?? 0) + 1);
		}
		expect(perOwner.has("none")).toBe(false);
		expect(Math.max(...perOwner.values())).toBeLessThanOrEqual(2);
		expect(stub.opens()).toHaveLength(3);
	});

	it("grows an owner granted less than it asked before adding an agent to it", async () => {
		// Granted one agent's window of the 262,144 it asked for.
		const stub = engine({ grant: () => NODE_WINDOW });
		await send(stub, "agent-a");
		await send(stub, "agent-b");
		expect(stub.opens()).toHaveLength(1);
		const [grow] = stub.resizes();
		expect(grow?.path).toBe("/sessions/resize");
		expect(grow?.body.session_id).toBe(OWNER_1);
		// Two agents, the 9,554-token shared prefix once: 9,554 + 2 x 55,982,
		// aligned up to 256.
		expect(grow?.body.num_ctx).toBe(121_600);
		expect(polykvWorkerChargedTo("agent-b")).toBe(OWNER_1);
	});

	it("opens another owner when the grow is refused, and never fails the agent", async () => {
		const stub = engine({
			grant: () => NODE_WINDOW,
			resize: [
				() =>
					json(
						{
							error: {
								code: 409,
								error_kind: "session_busy",
								message: "the session has 1 active and 0 pending task(s)",
							},
						},
						409,
					),
			],
		});
		await send(stub, "agent-a");
		const response = await send(stub, "agent-b");
		expect(response.status).toBe(200);
		expect(stub.resizes()).toHaveLength(1);
		expect(stub.opens().map((open) => open.body.session_id)).toEqual([
			OWNER_1,
			OWNER_2,
		]);
		expect(polykvWorkerChargedTo("agent-b")).toBe(OWNER_2);
	});
});

// pandorum pecyh, 2026-10-03: 15 agents of five roles, three per role, on six
// owners. Each agent went to the newest owner with room, whatever it held, so
// the three agents of a role sat on three owners and each built the role's
// pool again: 14 role pools for 14 agents, every one used by a single agent,
// 26 pools in all. A pool exists to be shared.
describe("placing an agent where its role's pool already is", () => {
	it("joins the owner that holds its role's pool, not the newest with room", async () => {
		const stub = engine({ maximum: 131_072 });
		await send(stub, "a1", "role A");
		await send(stub, "a2", "role A");
		await send(stub, "b1", "role B");
		expect(polykvWorkerChargedTo("b1")).toBe(OWNER_2);
		// A seat frees on the first owner: both have room now.
		await releasePolykvAgent("a2");
		const before = poolCreates(stub);
		await send(stub, "a3", "role A");
		expect(polykvWorkerChargedTo("a3")).toBe(OWNER_1);
		expect(poolCreates(stub)).toBe(before);
	});

	it("joins the owner an agent of its role is seated on, before that pool is built", async () => {
		const stub = engine({ maximum: 131_072 });
		await send(stub, "a1", "role A");
		await send(stub, "a2", "role A");
		await send(stub, "b1", "role B");
		await releasePolykvAgent("a2");
		// Two of role B and one of role A arrive at once: one seat on each owner
		// is free, and a third agent needs a new owner.
		await Promise.all([send(stub, "a3", "role A"), send(stub, "b2", "role B")]);
		expect(polykvWorkerChargedTo("a3")).toBe(OWNER_1);
		expect(polykvWorkerChargedTo("b2")).toBe(OWNER_2);
	});

	it("still takes a seat on another owner when its role's owner is full", async () => {
		const stub = engine({ maximum: 131_072 });
		await send(stub, "a1", "role A");
		await send(stub, "a2", "role A");
		await send(stub, "b1", "role B");
		expect((await send(stub, "a3", "role A")).status).toBe(200);
		expect(polykvWorkerChargedTo("a3")).toBe(OWNER_2);
		expect(stub.opens()).toHaveLength(2);
	});
});

// pecyh again: with the node's window at the engine's per-session maximum an
// owner is full at one agent by count, so a burst opened one owner per agent
// back to back, in arrival order, before any of them had sent a turn: six
// owners, the three agents of a role on three of them. An owner's real room is
// known only once its agent runs.
describe("a burst of agents", () => {
	const turnsAndOpens = (stub: ReturnType<typeof engine>) =>
		stub.calls
			.filter((call) => call.path === "/v1/chat/completions")
			.map((call) => (call.body.max_tokens === 1 ? "open" : "turn"));

	it("starts an agent on an owner before it opens the next one", async () => {
		const stub = engine({
			maximum: NODE_WINDOW,
			// Full, as measured: the second agent does need an owner of its own.
			kvRows: () => [
				{ session_id: OWNER_1, window: NODE_WINDOW, used: 64_000 },
			],
		});
		const responses = await Promise.all([
			send(stub, "s1", "role A"),
			send(stub, "s2", "role A"),
		]);
		expect(responses.map((r) => r.status)).toEqual([200, 200]);
		expect(turnsAndOpens(stub)).toEqual(["open", "turn", "open", "turn"]);
	});

	it("seats the burst on the owner it has, once that owner is measured to have the room", async () => {
		const stub = engine({
			maximum: NODE_WINDOW,
			kvRows: () => [{ session_id: OWNER_1, window: NODE_WINDOW, used: 9_000 }],
		});
		const agents = ["m1", "m2", "m3"];
		const responses = await Promise.all(
			agents.map((agent) => send(stub, agent, "role A")),
		);
		expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
		expect(stub.opens()).toHaveLength(1);
		for (const agent of agents) {
			expect(polykvWorkerChargedTo(agent)).toBe(OWNER_1);
		}
		// One chain, shared: a root, the knowledge and the role, once.
		expect(poolCreates(stub)).toBe(3);
	});
});

describe("a worker refused because its owner is full", () => {
	it("grows the owner by the shortfall and runs the worker, and reads no global pressure in it", async () => {
		const stub = engine({
			grant: () => NODE_WINDOW,
			worker: [
				() =>
					json(
						{
							error: {
								code: 429,
								type: "rate_limit_error",
								message: SESSION_FULL_TEXT,
								largest_admissible: 262_144,
								pressure: SESSION_FULL_PRESSURE,
							},
						},
						429,
						{ "retry-after": "2" },
					),
				() =>
					json({ choices: [{ message: { content: "ok" } }] }, 200, {
						"x-context-window": "67328",
					}),
			],
		});
		const response = await send(stub, "agent-a");
		expect(response.status).toBe(200);
		const grows = stub.resizes();
		expect(grows).toHaveLength(1);
		// 65,536 + (22,967 - 21,316) = 67,187, aligned up to 256.
		expect(grows[0]?.body).toEqual({ session_id: OWNER_1, num_ctx: 67_328 });
		// Retried on the owner it grew; no second owner.
		expect(stub.workers()).toHaveLength(2);
		expect(stub.opens()).toHaveLength(1);
		expect(polykvOwnerWindowBounds(OWNER_1)?.ceiling).toBeGreaterThanOrEqual(
			67_328,
		);
		// The refusal's pressure block was read, and it says the server had
		// room (base need 0): nobody running is asked to compact or shrink.
		const reading = latestOpencotiPressure("http://engine/v1");
		expect(reading?.pressure.refused60s).toBe(4);
		expect(opencotiPressureState(reading)).not.toBe("active");
	});

	it("does not grow past session_ctx_max; the worker goes to another owner instead", async () => {
		const full = () =>
			json(
				{
					error: {
						code: 429,
						message: SESSION_FULL_TEXT,
						pressure: SESSION_FULL_PRESSURE,
					},
				},
				429,
				{ "retry-after": "0" },
			);
		const stub = engine({
			maximum: NODE_WINDOW,
			worker: [
				full,
				() =>
					json({ choices: [{ message: { content: "ok" } }] }, 200, {
						"x-context-window": "65536",
					}),
			],
		});
		const response = await send(stub, "agent-a");
		expect(response.status).toBe(200);
		expect(stub.resizes()).toEqual([]);
		expect(stub.opens().map((open) => open.body.session_id)).toEqual([
			OWNER_1,
			OWNER_2,
		]);
	});
});

describe("a grow the busy owner cannot take now (kv_resize_deferred_v1)", () => {
	const full = () =>
		json(
			{
				error: {
					code: 429,
					message: SESSION_FULL_TEXT,
					pressure: SESSION_FULL_PRESSURE,
				},
			},
			429,
			{ "retry-after": "0" },
		);
	const ok = () =>
		json({ choices: [{ message: { content: "ok" } }] }, 200, {
			"x-context-window": "65536",
		});
	const queued = (sent: Record<string, unknown>) =>
		json(
			{
				ok: true,
				deferred: true,
				status: 202,
				session_id: sent.session_id,
				window: 65_536,
				resize_pending: sent.num_ctx,
				active: 3,
				pending: 0,
			},
			202,
		);

	it("is queued for the owner's idle moment, once, while the worker goes on", async () => {
		const stub = engine({
			features: [...FEATURES, "kv_resize_deferred_v1"],
			grant: () => NODE_WINDOW,
			resize: [queued],
			worker: [full, ok, full, ok],
		});
		// Both refused on owner-1, by the same shortfall.
		expect((await send(stub, "agent-a")).status).toBe(200);
		expect((await send(stub, "agent-b")).status).toBe(200);
		expect(stub.workers()).toHaveLength(4);
		const grows = stub.resizes();
		// One deferred grow by the shortfall; the same decision is not sent
		// again while it is pending.
		expect(grows).toHaveLength(1);
		expect(grows[0]?.body).toEqual({
			session_id: OWNER_1,
			num_ctx: 67_328,
			deferred: true,
		});
	});

	it("is never sent deferred to a server without the feature", async () => {
		const stub = engine({
			grant: () => NODE_WINDOW,
			resize: [
				() =>
					json(
						{
							error: { code: 409, error_kind: "session_busy", message: "busy" },
						},
						409,
					),
			],
			worker: [full, ok],
		});
		expect((await send(stub, "agent-a")).status).toBe(200);
		for (const grow of stub.resizes()) {
			expect(grow.body).not.toHaveProperty("deferred");
		}
	});
});

// What the lead's pressure compaction asks before it gives up its context:
// its own agents on that engine, and only those.
describe("whether a lead has agents on an engine", () => {
	it("is true while one of its agents is placed there, and false after", async () => {
		const stub = engine();
		expect(polykvLeadHasAgentsOn(GROUP, "http://engine/v1")).toBe(false);
		await (await send(stub, "agent-a")).text();
		expect(polykvLeadHasAgentsOn(GROUP, "http://engine/v1")).toBe(true);
		// Another lead, or another engine: not this lead's agents.
		expect(polykvLeadHasAgentsOn("another-lead", "http://engine/v1")).toBe(
			false,
		);
		expect(polykvLeadHasAgentsOn(GROUP, "http://elsewhere/v1")).toBe(false);
		await releasePolykvAgent("agent-a");
		expect(polykvLeadHasAgentsOn(GROUP, "http://engine/v1")).toBe(false);
	});
});

// opencoti 0422 (mail #460): a busy owner grows and shrinks while its workers
// run. An owner then books for the agents waiting on it, not for every agent
// the maximum could carry -- on pandorum .211 four owners took the whole KV
// and sat a third full while 31 agents waited for a fifth.
describe("owners on an engine that resizes a busy owner live", () => {
	it("books for the agents waiting, capped at what the maximum carries", () => {
		expect(
			polykvOwnerBooking({ ask: 65_536, floor: 40_000 }, 262_144, 1),
		).toEqual({
			window: 65_536,
			windowMin: 40_000,
			agents: 1,
		});
		expect(
			polykvOwnerBooking({ ask: 65_536, floor: 40_000 }, 262_144, 10).window,
		).toBe(262_144);
	});

	it("opens its owner for the one agent waiting, not the maximum", async () => {
		const stub = engine({ features: [...FEATURES, "kv_resize_live_v1"] });
		expect((await send(stub, "agent-a")).status).toBe(200);
		const [open] = stub.opens();
		expect(open?.body.num_ctx as number).toBeLessThan(262_144);
	});

	it("still books the maximum where a busy owner cannot be grown", async () => {
		const stub = engine();
		await send(stub, "agent-a");
		expect(stub.opens()[0]?.body.num_ctx).toBe(262_144);
	});

	it("learns it from a resize answered live", async () => {
		expect(opencotiResizesLive("http://live/v1")).toBe(false);
		const fetchImpl = (async () =>
			new Response(
				JSON.stringify({
					ok: true,
					live: true,
					window: 8_192,
					window_new: 16_384,
				}),
				{ headers: { "content-type": "application/json" } },
			)) as unknown as typeof fetch;
		await resizeOpencotiSession({
			baseUrl: "http://live/v1",
			sessionId: "owner",
			numCtx: 16_384,
			fetch: fetchImpl,
		});
		expect(opencotiResizesLive("http://live/v1")).toBe(true);
		expect(opencotiResizesLive("http://other/v1")).toBe(false);
	});
});
