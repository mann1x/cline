import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import {
	latestOpencotiPressure,
	opencotiPressureState,
	resetOpencotiPressure,
} from "./opencoti-kv-pressure";
import { resetPolykvAvailability, resetPolykvSessions } from "./polykv";
import {
	polykvOwnerAgentCapacity,
	polykvOwnerBooking,
	polykvOwnerWindowBounds,
	polykvWorkerChargedTo,
	releaseAllPolykvSwarms,
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
	} = {},
) {
	const calls: Call[] = [];
	let nextPool = 0;
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
			return json({ session_ctx_max: options.maximum ?? 262_144 });
		}
		if (url.pathname === "/apply-template") {
			return json({
				prompt: (body.messages as Array<{ role: string; content: string }>)
					.map((message) => `<|${message.role}|>${message.content}<|end|>`)
					.join(""),
			});
		}
		if (url.pathname === "/polykv/pools" && init?.method === "GET") {
			return json({ pools: [] });
		}
		if (url.pathname === "/polykv/pools" || url.pathname.endsWith("/fork")) {
			return json({ pool_id: nextPool++, parent: -1, prefix_len: 9_554 });
		}
		if (/^\/polykv\/pools\/\d+\/(pin|unpin|release)$/.test(url.pathname)) {
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

function agentBody() {
	return {
		model: "m",
		messages: [
			{ role: "system", content: "You are an agent." },
			{ role: "user", content: "the shared knowledge" },
			{ role: "user", content: "the role" },
			{ role: "user", content: "the task" },
		],
		max_tokens: 8_192,
	};
}

function send(stub: ReturnType<typeof engine>, agent: string) {
	return createOpencotiFetch({
		fetch: stub.fetch,
		baseUrl: "http://engine/v1",
		request: {
			worker: { group: GROUP, sessionId: agent, layers: 2 },
			agentWindow: { contextWindow: NODE_WINDOW, sharePercent: 50 },
		},
	})("http://engine/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify(agentBody()),
	});
}

beforeEach(() => {
	resetPolykvAvailability();
	resetPolykvSessions();
	resetOpencotiPressure();
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
