import { afterEach, describe, expect, it } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import {
	deferPolykvLeadClose,
	onPolykvNotice,
	POLYKV_LEAD_WORKER_POOL_MAX,
	polykvLeadLent,
	polykvLeadReserveCells,
	polykvSwarmState,
	releaseAllPolykvSwarms,
	releasePolykvAgent,
} from "./polykv-swarm";

/**
 * "Use PolyKV agents as Priority 0" (PLANS §9g): agents built as sub-pools of
 * the LEAD's own session instead of an owner opened for the swarm.
 *
 * The hazard every test here is about is measured (991ce2466): agents charged
 * to the lead's window filled it at about 21, and 49 of 51 were stopped
 * "session allocation full". Priority 0 must overflow -- never hold a
 * not-yet-started agent on the lead's window, never close the lead's session,
 * and never take the sub-pool the conversation itself needs.
 */

const LEAD = "lead/1";
const LEAD_ENGINE = "lead~1";

function leadEngine(
	options: {
		/** The lead's allocation on `/kv`; absent means it holds none. */
		lead?: { cells: number; used: number };
		/** Refuse this many worker requests as "worker of ... full". */
		refuseWorkersTimes?: number;
		/** Refuse only after this many worker requests were served. */
		refuseAfter?: number;
		/** Refuse every pool create, as a full slot or reservoir does. */
		refusePools?: boolean;
		/** Leave `X-Context-Window` off worker responses, as a lapsed lead does. */
		dropContextWindow?: boolean;
	} = {},
) {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	let nextPool = 0;
	let refusals = options.refuseWorkersTimes ?? 0;
	let served = 0;
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
		const json = (value: unknown, status = 200, headers = {}) =>
			new Response(JSON.stringify(value), {
				status,
				headers: { "content-type": "application/json", ...headers },
			});
		if (url.pathname === "/kv") {
			return json({
				session_ctx_max: 262_144,
				allocations: options.lead
					? [{ key: LEAD_ENGINE, ...options.lead }]
					: [],
			});
		}
		if (url.pathname === "/apply-template") {
			return json({
				prompt: render(
					body.messages as Array<{ role: string; content: unknown }>,
				),
			});
		}
		if (url.pathname === "/polykv/pools") {
			if (options.refusePools) {
				return json(
					{ error: { message: "session sub-pool limit reached" } },
					400,
				);
			}
			return json({ pool_id: nextPool++, parent: -1, prefix_len: 100 });
		}
		if (/^\/polykv\/pools\/\d+\/fork$/.test(url.pathname)) {
			return json({
				pool_id: nextPool++,
				parent: Number(url.pathname.split("/")[3]),
				prefix_len: 200,
			});
		}
		if (/^\/polykv\/pools\/\d+\/(unpin|release)$/.test(url.pathname)) {
			return json({ ok: true });
		}
		if (/^\/sessions\/[^/]+\/close$/.test(url.pathname)) {
			return json({ found: true, released: true });
		}
		if (url.pathname === "/v1/chat/completions") {
			if (
				body.pool_id !== undefined &&
				served >= (options.refuseAfter ?? 0) &&
				refusals > 0
			) {
				refusals -= 1;
				return json(
					{
						error: {
							message: `admission rejected: session allocation full (worker of '${LEAD_ENGINE}': 0 of 65536 cells free, needs 75) — compact the session`,
						},
					},
					429,
					{ "retry-after": "0" },
				);
			}
			served += 1;
			return json(
				{ choices: [{ message: { content: "ok" } }] },
				200,
				options.dropContextWindow ? {} : { "x-context-window": "131072" },
			);
		}
		return json({ error: "no route" }, 404);
	}) as unknown as typeof fetch;
	return { calls, fetch: fetchImpl };
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
		num_ctx: 262_144,
	};
}

function leadWorkerFetch(
	engine: ReturnType<typeof leadEngine>,
	sessionId: string,
) {
	return createOpencotiFetch({
		fetch: engine.fetch,
		baseUrl: "http://engine/v1",
		request: {
			worker: { group: LEAD, sessionId, layers: 2, owner: LEAD },
		},
	});
}

async function send(
	engine: ReturnType<typeof leadEngine>,
	sessionId: string,
	body: Record<string, unknown>,
) {
	return leadWorkerFetch(engine, sessionId)(
		"http://engine/v1/chat/completions",
		{ method: "POST", body: JSON.stringify(body) },
	);
}

const chats = (engine: ReturnType<typeof leadEngine>) =>
	engine.calls.filter((call) => call.path === "/v1/chat/completions");

afterEach(async () => {
	await releaseAllPolykvSwarms();
});

describe("priority 0: agents as sub-pools of the lead's own session", () => {
	it("builds the tree in the lead's window and opens no owner", async () => {
		const engine = leadEngine({ lead: { cells: 131_072, used: 20_000 } });
		const response = await send(engine, "agent-a", agentBody("r", "t"));
		expect(response.status).toBe(200);

		// No one-token owner-opening request: the lead's window already exists.
		expect(chats(engine).filter((call) => call.body.max_tokens === 1)).toEqual(
			[],
		);
		const created = engine.calls.filter(
			(call) => call.path === "/polykv/pools" || call.path.endsWith("/fork"),
		);
		expect(created.length).toBeGreaterThan(0);
		for (const call of created) {
			expect(call.body.session_id).toBe(LEAD_ENGINE);
		}
		const worker = chats(engine).at(-1);
		expect(worker?.body.session_id).toBe("agent-a");
		expect(worker?.body.pool_id).toBeDefined();
		expect(polykvSwarmState()[0]?.owners[0]).toMatchObject({
			sessionId: LEAD_ENGINE,
			borrowed: true,
		});
	});

	// Closing the owner is how a swarm's own owner goes back. The lead's is the
	// conversation's window: closing it would end the conversation's booking.
	it("releases its pools, never the lead's session, when its last agent ends", async () => {
		const engine = leadEngine({ lead: { cells: 131_072, used: 20_000 } });
		await send(engine, "agent-a", agentBody("r", "t1"));
		await send(engine, "agent-b", agentBody("r", "t2"));

		await releasePolykvAgent("agent-a");
		expect(engine.calls.some((call) => call.path.includes("/release"))).toBe(
			false,
		);

		const last = await releasePolykvAgent("agent-b");
		const closes = engine.calls
			.filter((call) => call.path.startsWith("/sessions/"))
			.map((call) => call.path);
		expect(closes).not.toContain(`/sessions/${LEAD_ENGINE}/close`);
		expect(last.closed).not.toContain(LEAD_ENGINE);
		// Every pool it built goes back, children before their parents.
		const released = engine.calls
			.filter((call) => call.path.endsWith("/release"))
			.map((call) => Number(call.path.split("/")[3]));
		expect(released).toEqual([2, 1, 0]);
		expect(polykvSwarmState()).toEqual([]);
	});

	// The hazard: a lead window below the room it keeps for the conversation
	// must send a new agent elsewhere, not start it there.
	it("refuses a new agent when the lead's window is below its reserve", async () => {
		const cells = 65_536;
		const engine = leadEngine({
			lead: { cells, used: cells - polykvLeadReserveCells(cells) + 1 },
		});
		const response = await send(engine, "agent-a", agentBody("r", "t"));

		expect(response.status).toBe(429);
		const text = await response.text();
		// Worded as the engine's own full-owner refusal, which is what the
		// spawn queue reads as "not started, place it on the next tier".
		expect(text).toMatch(/session allocation full \(worker of 'lead~1'/);
		expect(text).toMatch(/priority 0 is full/);
		expect(chats(engine)).toEqual([]);
	});

	it("starts an agent while the lead keeps its reserve", async () => {
		const cells = 65_536;
		const engine = leadEngine({
			lead: { cells, used: cells - polykvLeadReserveCells(cells) },
		});
		const response = await send(engine, "agent-a", agentBody("r", "t"));
		expect(response.status).toBe(200);
	});

	// Without dynamicContextSize the lead books no window, owns nothing, and
	// has nothing for this to protect: the engine is the only judge.
	it("does not refuse when the lead holds no allocation", async () => {
		const engine = leadEngine();
		const response = await send(engine, "agent-a", agentBody("r", "t"));
		expect(response.status).toBe(200);
	});

	// An ordinary swarm worker waits out a full owner and then tries a fresh
	// one. A priority-0 agent that has not started has somewhere better to be.
	it("hands a first-turn full-window refusal straight back instead of waiting", async () => {
		const engine = leadEngine({
			lead: { cells: 131_072, used: 0 },
			refuseWorkersTimes: 5,
		});
		const response = await send(engine, "agent-a", agentBody("r", "t"));

		expect(response.status).toBe(429);
		expect(await response.text()).toMatch(/session allocation full/);
		// One attempt, no fresh owner, no wait.
		expect(chats(engine)).toHaveLength(1);
	});

	// 17d3f63bf: once an agent has work in flight a full window is a wait, not
	// a lost worker -- and the reserve does not apply to it either, or the
	// lead dipping below it would kill agents that have already started.
	it("waits out a full window after its first turn, whatever the reserve", async () => {
		const lead = { cells: 131_072, used: 0 };
		const engine = leadEngine({ lead, refuseWorkersTimes: 2, refuseAfter: 1 });
		expect((await send(engine, "agent-a", agentBody("r", "t"))).status).toBe(
			200,
		);

		// A later turn builds a new fetch, as a new model does per turn.
		lead.used = lead.cells;
		const next = await send(engine, "agent-a", agentBody("r", "t"));
		expect(next.status).toBe(200);
		expect(
			chats(engine).filter((call) => call.body.max_tokens !== 1),
		).toHaveLength(4);
	});

	// The lead's session has eight sub-pools and its own conversation needs one
	// of them (its `Ls`, re-made after each compaction).
	it("never takes the sub-pool the lead's own conversation needs", async () => {
		const engine = leadEngine({ lead: { cells: 1_048_576, used: 0 } });
		for (let index = 0; index < 8; index++) {
			await send(
				engine,
				`agent-${index}`,
				agentBody(`role ${index}`, "t", `knowledge ${index}`),
			);
		}
		const created = engine.calls.filter(
			(call) => call.path === "/polykv/pools" || call.path.endsWith("/fork"),
		);
		expect(created.length).toBe(POLYKV_LEAD_WORKER_POOL_MAX);
		expect(POLYKV_LEAD_WORKER_POOL_MAX).toBe(7);
		// The agents past the limit still run, sharing what exists.
		expect(
			chats(engine).filter((call) => call.body.max_tokens !== 1),
		).toHaveLength(8);
	});

	it("keeps an ordinary swarm on owners of its own", async () => {
		const engine = leadEngine({ lead: { cells: 131_072, used: 0 } });
		await createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: "http://engine/v1",
			request: { worker: { group: LEAD, sessionId: "x", layers: 2 } },
		})("http://engine/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(agentBody("r", "t")),
		});
		const created = engine.calls.find((call) => call.path === "/polykv/pools");
		expect(created?.body.session_id).not.toBe(LEAD_ENGINE);
		expect(String(created?.body.session_id)).toMatch(/polykv-owner-1$/);
	});
});

describe("opencoti's two caveats (mail 269)", () => {
	// Limits: eight sub-pools per slot, and a pool reservoir shared by every
	// slot. A refusal for either is priority 0 being full, never a failure.
	it("sends an agent to the nodes when the lead's session cannot give it a sub-pool", async () => {
		const engine = leadEngine({
			lead: { cells: 131_072, used: 0 },
			refusePools: true,
		});
		const response = await send(engine, "agent-a", agentBody("r", "t"));

		expect(response.status).toBe(429);
		expect(await response.text()).toMatch(
			/session allocation full .*no sub-pool.*priority 0 is full/,
		);
		// Not run unpooled on the lead's server as a session of its own.
		expect(chats(engine)).toEqual([]);
	});

	it("asks again for a sub-pool once one could not be had", async () => {
		const engine = leadEngine({
			lead: { cells: 131_072, used: 0 },
			refusePools: true,
		});
		await send(engine, "agent-a", agentBody("r", "t"));
		await releasePolykvAgent("agent-a");
		await send(engine, "agent-b", agentBody("r", "t"));
		expect(
			engine.calls.filter((call) => call.path === "/polykv/pools"),
		).toHaveLength(2);
	});

	// Lifetime: the lead's close releases its sub-pools, and a worker naming a
	// released pool is silently prefilled in full.
	it("holds the lead's close until its last priority-0 agent ends", async () => {
		const engine = leadEngine({ lead: { cells: 131_072, used: 0 } });
		await send(engine, "agent-a", agentBody("r", "t1"));
		await send(engine, "agent-b", agentBody("r", "t2"));
		expect(polykvLeadLent(LEAD)).toBe(true);

		const closed: string[] = [];
		expect(
			deferPolykvLeadClose(LEAD, async () => {
				closed.push(LEAD);
			}),
		).toBe(true);

		await releasePolykvAgent("agent-a");
		expect(closed).toEqual([]);
		await releasePolykvAgent("agent-b");
		expect(closed).toEqual([LEAD]);
		// Pools first, then the session.
		expect(engine.calls.some((call) => call.path.endsWith("/release"))).toBe(
			true,
		);
		expect(polykvLeadLent(LEAD)).toBe(false);
	});

	it("does not hold a close with no priority-0 agent running", () => {
		expect(deferPolykvLeadClose(LEAD, async () => {})).toBe(false);
	});

	it("warns when a priority-0 turn comes back without its window header", async () => {
		const engine = leadEngine({
			lead: { cells: 131_072, used: 0 },
			dropContextWindow: true,
		});
		const notices: Array<{ severity: string; text: string }> = [];
		const stop = onPolykvNotice("agent-a", (notice) => notices.push(notice));
		try {
			expect((await send(engine, "agent-a", agentBody("r", "t"))).status).toBe(
				200,
			);
		} finally {
			stop();
		}
		expect(notices).toHaveLength(1);
		expect(notices[0]?.severity).toBe("warn");
		expect(notices[0]?.text).toMatch(/No X-Context-Window/);
	});

	it("does not warn while the header is there", async () => {
		const engine = leadEngine({ lead: { cells: 131_072, used: 0 } });
		const notices: unknown[] = [];
		const stop = onPolykvNotice("agent-a", (notice) => notices.push(notice));
		try {
			await send(engine, "agent-a", agentBody("r", "t"));
		} finally {
			stop();
		}
		expect(notices).toEqual([]);
	});
});

describe("the lead's reserve", () => {
	it("is a quarter of the window, never below a worker's minimum room", () => {
		expect(polykvLeadReserveCells(262_144)).toBe(65_536);
		expect(polykvLeadReserveCells(32_768)).toBe(16_384);
	});
});
