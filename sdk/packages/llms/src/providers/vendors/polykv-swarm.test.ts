import { afterEach, describe, expect, it } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import {
	engineSessionId,
	polykvSwarmState,
	releaseAllPolykvSwarms,
	releasePolykvAgent,
} from "./polykv-swarm";

/**
 * A stub engine with the parts of the contract the swarm relies on.
 *
 * `/apply-template` renders messages the way a chat template does -- one
 * delimited block per turn -- so a layer cut at the sentinel is a byte-prefix
 * of the full rendering exactly when the real template's would be.
 */
function stubEngine(options: { refuseWorkersTimes?: number } = {}) {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	let nextPool = 0;
	let refusals = options.refuseWorkersTimes ?? 0;
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
			return json({ pool_id: nextPool++, parent: -1, prefix_len: 100 });
		}
		if (/^\/polykv\/pools\/\d+\/fork$/.test(url.pathname)) {
			return json({
				pool_id: nextPool++,
				parent: Number(url.pathname.split("/")[3]),
				prefix_len: 200,
			});
		}
		if (/^\/sessions\/[^/]+\/close$/.test(url.pathname)) {
			return json({ found: true, released: true });
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
			return json({ choices: [{ message: { content: "ok" } }] });
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

	// A summary call is the agent's, but not its conversation: charged to the
	// owner as a worker, it books no window of its own.
	it("attaches an agent's other requests to its tree without building", async () => {
		const engine = stubEngine();
		await send(engine, "a", agentBody("r", "t"));
		const poolsBefore = engine.calls.filter((call) =>
			call.path.startsWith("/polykv"),
		).length;

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
		expect(
			engine.calls.filter((call) => call.path.startsWith("/polykv")).length,
		).toBe(poolsBefore);
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
