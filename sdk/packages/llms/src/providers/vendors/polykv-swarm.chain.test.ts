import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpencotiFetch, type OpencotiLog } from "./opencoti";
import { resetPolykvAvailability } from "./polykv";
import {
	POLYKV_LAYER_RETRY_MS,
	polykvRootGeneration,
	releaseAllPolykvSwarms,
	releasePolykvAgent,
} from "./polykv-swarm";

/**
 * A stub opencoti that keeps the parts of the owner contract the live swarm
 * of 2026-09-25 tripped on (bs2:8244, session 1790347250782_qphzs):
 *
 * - a pool created with `session_id` belongs to that owner, and an owner holds
 *   at most `cap` of them (`--polykv-max-pools`, 8 per slot): the next create
 *   is a 503 naming the limit;
 * - closing an owner releases every pool it owns;
 * - `GET /polykv/pools` names each pool's `owner`;
 * - every completion carries `X-OpenCoti-Boot-Id`.
 */
function ownedEngine(options: { cap?: number } = {}) {
	const cap = options.cap ?? 8;
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	const owners = new Set<string>();
	const closed: string[] = [];
	let pools = new Map<
		number,
		{ prompt: string; parent: number; owner: string | null }
	>();
	let nextPool = 0;
	let bootId = 1;
	let refuseCreates = 0;
	const render = (messages: Array<{ role: string; content: unknown }>) =>
		messages
			.map(
				(m) =>
					`<|${m.role}|>${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}<|end|>`,
			)
			.join("");
	const limit = (owner: string) =>
		`session sub-pool limit reached (${cap} per slot, --polykv-max-pools) — release one of '${owner}''s pools first`;
	const owned = (owner: string) =>
		[...pools.values()].filter((pool) => pool.owner === owner).length;
	const makePool = (
		prompt: string,
		parent: number,
		asked: string | undefined,
	): { id?: number; refusal?: string } => {
		const parentOwner = parent >= 0 ? pools.get(parent)?.owner : undefined;
		const owner =
			asked && owners.has(asked) ? asked : (parentOwner ?? null) || null;
		if (owner && (refuseCreates > 0 || owned(owner) >= cap)) {
			refuseCreates = Math.max(0, refuseCreates - 1);
			return { refusal: limit(owner) };
		}
		const id = nextPool++;
		pools.set(id, { prompt, parent, owner });
		return { id };
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
			return json({ session_ctx_max: 65_536 });
		}
		if (url.pathname === "/props") {
			return json({ opencoti: { boot_id: `b-${bootId}` } });
		}
		if (url.pathname === "/health") {
			return json({ status: "ok" });
		}
		if (url.pathname === "/apply-template") {
			return json({ prompt: render(body.messages as never) });
		}
		if (url.pathname === "/polykv/pools" && init?.method === "GET") {
			return json({
				pools: [...pools.entries()].map(([id, pool]) => ({
					pool_id: id,
					parent: pool.parent,
					prefix_len: pool.prompt.length,
					owner: pool.owner,
				})),
			});
		}
		const created =
			url.pathname === "/polykv/pools"
				? makePool(String(body.prompt), -1, body.session_id as string)
				: /^\/polykv\/pools\/\d+\/fork$/.test(url.pathname)
					? makePool(
							String(body.prompt),
							Number(url.pathname.split("/")[3]),
							body.session_id as string,
						)
					: undefined;
		if (created) {
			if (created.refusal !== undefined) {
				return json(
					{ error: { message: created.refusal, type: "unavailable_error" } },
					503,
				);
			}
			const pool = pools.get(created.id as number);
			return json({
				pool_id: created.id,
				parent: pool?.parent,
				prefix_len: pool?.prompt.length,
			});
		}
		const action = /^\/polykv\/pools\/(\d+)\/(unpin|release|admission)$/.exec(
			url.pathname,
		);
		if (action) {
			const id = Number(action[1]);
			if (!pools.has(id)) {
				return json({ error: { message: "no such pool" } }, 404);
			}
			if (action[2] === "release") {
				if ([...pools.values()].some((pool) => pool.parent === id)) {
					return json({ error: { message: "release children first" } }, 400);
				}
				pools.delete(id);
			}
			return json({ ok: true });
		}
		const close = /^\/sessions\/([^/]+)\/close$/.exec(url.pathname);
		if (close) {
			const id = decodeURIComponent(close[1] ?? "");
			closed.push(id);
			const found = owners.delete(id);
			for (const [poolId, pool] of [...pools]) {
				if (pool.owner === id) {
					pools.delete(poolId);
				}
			}
			return json({ found });
		}
		if (url.pathname === "/v1/chat/completions") {
			if (body.max_tokens === 1) {
				owners.add(String(body.session_id));
			}
			const known = typeof body.pool_id === "number" && pools.has(body.pool_id);
			return json({ choices: [{ message: { content: "ok" } }] }, 200, {
				"x-opencoti-boot-id": `b-${bootId}`,
				...(known || body.pool_id === undefined
					? { "x-context-window": "65536" }
					: {}),
			});
		}
		return json({ error: "no route" }, 404);
	}) as unknown as typeof fetch;
	return {
		calls,
		closed,
		owners,
		fetch: fetchImpl,
		pools: () => pools,
		/** Pools the owner holds that no one here made: a previous process's. */
		preload: (owner: string, count: number) => {
			owners.add(owner);
			let parent = -1;
			for (let index = 0; index < count; index++) {
				const id = nextPool++;
				pools.set(id, { prompt: `stale ${index}`, parent, owner });
				parent = id;
			}
		},
		/** Refuse the next `n` pool creates at the sub-pool limit. */
		refuseCreates: (n: number) => {
			refuseCreates = n;
		},
		/** A new process: new boot id, no owners, no pools, ids from 0. */
		restart: () => {
			bootId += 1;
			pools = new Map();
			owners.clear();
			nextPool = 0;
		},
	};
}

type Engine = ReturnType<typeof ownedEngine>;

function agentBody(task: string) {
	return {
		model: "m",
		messages: [
			{ role: "system", content: "base prompt and tools" },
			{ role: "user", content: "the shared knowledge" },
			{ role: "user", content: "the role" },
			{ role: "user", content: task },
		],
		num_ctx: 65_536,
	};
}

const GROUP = "1790347250782_qphzs";

async function send(
	engine: Engine,
	sessionId: string,
	body: object,
	log?: OpencotiLog,
) {
	const fetchImpl = createOpencotiFetch({
		fetch: engine.fetch,
		baseUrl: "http://engine/v1",
		request: { worker: { group: GROUP, sessionId, layers: 2 } },
		...(log ? { log } : {}),
	});
	return fetchImpl("http://engine/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify(body),
	});
}

const turns = (engine: Engine) =>
	engine.calls.filter(
		(call) =>
			call.path === "/v1/chat/completions" && call.body.max_tokens !== 1,
	);

const openedOwners = (engine: Engine) =>
	engine.calls
		.filter(
			(call) =>
				call.path === "/v1/chat/completions" && call.body.max_tokens === 1,
		)
		.map((call) => String(call.body.session_id));

/** Per owner, how many pools hold each prompt: >1 is a duplicate chain. */
function duplicates(engine: Engine): string[] {
	const seen = new Map<string, number>();
	for (const pool of engine.pools().values()) {
		const key = `${pool.owner}\n${pool.prompt}`;
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	return [...seen].filter(([, n]) => n > 1).map(([key]) => key);
}

afterEach(async () => {
	vi.useRealTimers();
	await releaseAllPolykvSwarms();
	resetPolykvAvailability();
});

describe("one owner's pool chain", () => {
	it("is built once by N agents that start together", async () => {
		const engine = ownedEngine();
		await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				send(engine, `agent-${index}`, agentBody(`task ${index}`)),
			),
		);
		expect(openedOwners(engine)).toHaveLength(1);
		expect(engine.pools().size).toBe(3);
		expect(duplicates(engine)).toEqual([]);
	});

	// The live failure: an agent that never got a place on the tree (its first
	// request was not shaped for one) outlived the group it was filed under.
	// Its release deleted the group that had replaced it, and the next agent
	// opened `~polykv-owner-1` again -- the owner that already held a chain --
	// and built the same chain in it a second time.
	it("is not built again when an agent of a replaced group is released", async () => {
		const engine = ownedEngine();
		// Unpooled: [system, task] cannot hold two shared layers.
		await send(engine, "stray", {
			model: "m",
			messages: [
				{ role: "system", content: "base prompt and tools" },
				{ role: "user", content: "hello" },
			],
		});
		await send(engine, "a1", agentBody("t1"));
		await releasePolykvAgent("a1");
		await send(engine, "a2", agentBody("t2"));
		await releasePolykvAgent("stray");
		await send(engine, "a3", agentBody("t3"));
		await send(engine, "a4", agentBody("t4"));

		expect(duplicates(engine)).toEqual([]);
		const [, , a2, a3, a4] = turns(engine).map((call) => call.body.pool_id);
		expect(a2).toBeTypeOf("number");
		expect(a3).toBe(a2);
		expect(a4).toBe(a2);
	});

	// A new group reused `~polykv-owner-1` as its first owner's name, so the
	// close of the old owner -- in flight as the last agent left -- could land
	// on the new one, or the new one could land on the old one's pools.
	it("never reopens an owner name this process has used", async () => {
		const engine = ownedEngine();
		await send(engine, "b1", agentBody("t1"));
		await releasePolykvAgent("b1");
		await send(engine, "b2", agentBody("t2"));
		await releasePolykvAgent("b2");
		await send(engine, "b3", agentBody("t3"));
		const opened = openedOwners(engine);
		expect(opened).toHaveLength(3);
		expect(new Set(opened).size).toBe(3);
	});
});

describe("every worker dispatch", () => {
	it("carries the pool id, for agents that start, end and start again", async () => {
		const engine = ownedEngine();
		for (let wave = 0; wave < 3; wave++) {
			await Promise.all(
				Array.from({ length: 6 }, (_, index) =>
					send(engine, `w${wave}-${index}`, agentBody(`t${wave}-${index}`)),
				),
			);
			// Half the wave ends while the other half keeps going.
			await Promise.all(
				Array.from({ length: 3 }, (_, index) =>
					releasePolykvAgent(`w${wave}-${index}`),
				),
			);
		}
		const sentTurns = turns(engine);
		expect(sentTurns).toHaveLength(18);
		expect(
			sentTurns.every((call) => typeof call.body.pool_id === "number"),
		).toBe(true);
		expect(duplicates(engine)).toEqual([]);
	});

	it("that goes out without a pool says why, at warn", async () => {
		const engine = ownedEngine({ cap: 0 });
		const lines: Array<[string, string]> = [];
		await send(engine, "c1", agentBody("t1"), (message, severity) =>
			lines.push([message, severity]),
		);
		expect(turns(engine)[0]?.body.pool_id).toBeUndefined();
		const warned = lines.filter(([, severity]) => severity === "warn");
		expect(warned).toHaveLength(1);
		expect(warned[0]?.[0]).toMatch(/c1.*without a pool/);
		expect(warned[0]?.[0]).toMatch(/sub-pool limit/);
	});
});

describe("the sub-pool limit", () => {
	// A previous process's chain under the same owner name fills its eight.
	it("releases the owner's pools no one here holds, and retries", async () => {
		const engine = ownedEngine();
		engine.preload(`${GROUP}~polykv-owner-1`, 8);
		await send(engine, "d1", agentBody("t1"));
		const [turn] = turns(engine);
		expect(turn?.body.pool_id).toBeTypeOf("number");
		const pool = engine.pools().get(turn?.body.pool_id as number);
		expect(pool?.prompt).toContain("the role");
		expect(
			[...engine.pools().values()].some((p) => p.prompt.startsWith("stale")),
		).toBe(false);
	});

	it("releases this owner's pools no running agent uses, and retries", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const engine = ownedEngine({ cap: 4 });
		const other = (task: string) => ({
			...agentBody(task),
			messages: [
				{ role: "system", content: "base prompt and tools" },
				{ role: "user", content: "other knowledge" },
				{ role: "user", content: "other role" },
				{ role: "user", content: task },
			],
		});
		// Role A's chain: three pools of the owner's four.
		await send(engine, "e1", agentBody("t1"));
		// Role B gets its root, and the limit stops it there.
		await send(engine, "e2", other("t2"));
		const shallow = turns(engine).at(-1)?.body.pool_id;
		expect(shallow).toBeTypeOf("number");
		expect(engine.pools().get(shallow as number)?.prompt).not.toContain(
			"other role",
		);
		// Role A's last agent ends; its chain is nobody's now, and the owner
		// stays up for e2.
		await releasePolykvAgent("e1");
		vi.setSystemTime(Date.now() + POLYKV_LAYER_RETRY_MS + 1);
		await send(engine, "e3", other("t3"));
		const deep = turns(engine).at(-1)?.body.pool_id;
		expect(engine.pools().get(deep as number)?.prompt).toContain("other role");
		expect(
			[...engine.pools().values()].some((p) => p.prompt.includes("the role")),
		).toBe(false);
	});

	it("is not remembered: the layer is tried again, and attaches", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const engine = ownedEngine();
		engine.refuseCreates(1);
		await send(engine, "f1", agentBody("t1"));
		expect(turns(engine).at(-1)?.body.pool_id).toBeUndefined();
		vi.setSystemTime(Date.now() + POLYKV_LAYER_RETRY_MS + 1);
		await send(engine, "f1", agentBody("t2"));
		await send(engine, "f2", agentBody("t3"));
		expect(turns(engine).at(-1)?.body.pool_id).toBeTypeOf("number");
		expect(turns(engine).at(-2)?.body.pool_id).toBeTypeOf("number");
		expect(duplicates(engine)).toEqual([]);
	});
});

describe("after a restart", () => {
	it("rebuilds the chain once, for every agent on it", async () => {
		const engine = ownedEngine();
		await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				send(engine, `g${index}`, agentBody(`t${index}`)),
			),
		);
		const generation = polykvRootGeneration("http://engine/v1");
		engine.restart();
		// The first answer from the new process says so...
		await send(engine, "g0", agentBody("next 0"));
		expect(polykvRootGeneration("http://engine/v1")).toBe(generation + 1);
		const createsBefore = engine.calls.filter(
			(call) => call.path === "/polykv/pools" && call.body.prompt !== undefined,
		).length;
		const forksBefore = engine.calls.filter((call) =>
			call.path.endsWith("/fork"),
		).length;
		// ...and every agent's next turn attaches to one chain built anew.
		await Promise.all(
			Array.from({ length: 6 }, (_, index) =>
				send(engine, `g${index}`, agentBody(`again ${index}`)),
			),
		);
		const creates =
			engine.calls.filter(
				(call) =>
					call.path === "/polykv/pools" && call.body.prompt !== undefined,
			).length - createsBefore;
		const forks =
			engine.calls.filter((call) => call.path.endsWith("/fork")).length -
			forksBefore;
		expect(creates).toBe(1);
		expect(forks).toBe(2);
		expect(engine.pools().size).toBe(3);
		const last = turns(engine).slice(-6);
		expect(new Set(last.map((call) => call.body.pool_id)).size).toBe(1);
		expect(last[0]?.body.pool_id).toBeTypeOf("number");
	});
});
