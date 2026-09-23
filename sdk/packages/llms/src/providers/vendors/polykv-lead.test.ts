import { markPromptEnvironment } from "@cline/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import { getPolykvSession, resetPolykvAvailability } from "./polykv";
import {
	hoistLeadEnvironment,
	POLYKV_LEAD_RECHECK_MS,
	polykvLeadState,
	prepareLeadPool,
	releaseAllPolykvLeads,
	releasePolykvLead,
} from "./polykv-lead";

/**
 * A stub engine: pools on, a template that renders one delimited block per
 * turn, and a pool registry the listing reads back.
 */
function stubEngine(options: { poolsEnabled?: boolean } = {}) {
	const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
	const pools = new Set<string>();
	let nextPool = 0;
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
		const json = (value: unknown, status = 200) =>
			new Response(JSON.stringify(value), {
				status,
				headers: { "content-type": "application/json" },
			});
		if (url.pathname === "/props") {
			return json({
				opencoti: {
					polykv: { pools_enabled: options.poolsEnabled !== false },
					elastic_slots: { enabled: true },
				},
			});
		}
		if (url.pathname === "/apply-template") {
			return json({
				prompt: render(
					body.messages as Array<{ role: string; content: unknown }>,
				),
			});
		}
		if (url.pathname === "/polykv/pools" && init?.method === "POST") {
			const id = String(nextPool++);
			pools.add(id);
			return json({ pool_id: Number(id), parent: -1, prefix_len: 100 });
		}
		if (url.pathname === "/polykv/pools") {
			return json({ pools: [...pools].map((id) => ({ pool_id: Number(id) })) });
		}
		const fork = url.pathname.match(/^\/polykv\/pools\/(\d+)\/fork$/);
		if (fork) {
			const id = String(nextPool++);
			pools.add(id);
			return json({
				pool_id: Number(id),
				parent: Number(fork[1]),
				prefix_len: 140,
			});
		}
		const release = url.pathname.match(/^\/polykv\/pools\/(\d+)\/release$/);
		if (release) {
			pools.delete(release[1] as string);
			return json({ released: true });
		}
		if (/^\/polykv\/pools\/\d+\/(un)?pin$/.test(url.pathname)) {
			return json({ ok: true });
		}
		if (url.pathname === "/v1/chat/completions") {
			return json({ choices: [{ message: { content: "ok" } }] });
		}
		return json({ error: "no route" }, 404);
	}) as unknown as typeof fetch;
	return { calls, pools, fetch: fetchImpl };
}

const STATIC = "You are Cline. Working Directory: see <environment>";

function leadBody(cwd: string, task = "fix the bug") {
	return {
		model: "m",
		messages: [
			{
				role: "system",
				content: `${STATIC}\n\n${markPromptEnvironment("Working Directory", cwd)}`,
			},
			{ role: "user", content: task },
		],
		tools: [{ type: "function", function: { name: "read_files" } }],
	};
}

/** The body as the lead fetch rewrites it, before any pool is chosen. */
function hoisted(cwd: string, task?: string) {
	const body = leadBody(cwd, task) as Record<string, unknown>;
	hoistLeadEnvironment(body);
	return body;
}

async function prepare(
	engine: ReturnType<typeof stubEngine>,
	sessionId: string,
	body: Record<string, unknown>,
	now?: number,
) {
	return prepareLeadPool({
		baseUrl: "http://engine/v1",
		fetch: engine.fetch,
		body,
		sessionId,
		...(now !== undefined ? { now } : {}),
	});
}

const creates = (engine: ReturnType<typeof stubEngine>) =>
	engine.calls.filter(
		(call) => call.path === "/polykv/pools" && call.body.prompt !== undefined,
	);
const forks = (engine: ReturnType<typeof stubEngine>) =>
	engine.calls.filter((call) => call.path.endsWith("/fork"));

afterEach(async () => {
	await releaseAllPolykvLeads();
	resetPolykvAvailability();
});

describe("the environment turn", () => {
	it("moves the spans out of the system turn into a user turn after it", () => {
		const body = hoisted("c:/work");
		const messages = body.messages as Array<{ role: string; content: string }>;
		expect(messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"user",
		]);
		expect(messages[0]?.content).toBe(STATIC);
		expect(messages[1]?.content).toContain("c:/work");
		expect(messages[2]?.content).toBe("fix the bug");
	});

	it("leaves a request without spans alone", () => {
		const body = {
			messages: [
				{ role: "system", content: "plain" },
				{ role: "user", content: "hi" },
			],
		};
		expect(hoistLeadEnvironment(body)).toBe(false);
		expect(body.messages).toHaveLength(2);
	});
});

describe("the lead tree", () => {
	// The point: conversations in different workspaces share one root, and no
	// one's window pays for it.
	it("gives every conversation on a server one unowned root", async () => {
		const engine = stubEngine();
		const one = await prepare(engine, "lead-1", hoisted("c:/one"));
		const two = await prepare(engine, "lead-2", hoisted("d:/two"));
		expect(one).toBe("0");
		expect(two).toBe("0");
		expect(creates(engine)).toHaveLength(1);
		expect(creates(engine)[0]?.body.session_id).toBeUndefined();
		expect(creates(engine)[0]?.body.pin).toBe(true);
		// The root ends after the environment turn's opener, and holds no
		// environment.
		expect(String(creates(engine)[0]?.body.prompt)).toMatch(/<\|user\|>$/);
		expect(String(creates(engine)[0]?.body.prompt)).not.toContain("c:/one");
		expect(polykvLeadState()[0]?.sessions).toEqual(["lead-1", "lead-2"]);
	});

	// A pool's owner must be a live allocation: the sub-pool waits for the
	// window, then lives inside it.
	it("forks the conversation's own sub-pool once it holds a window", async () => {
		const engine = stubEngine();
		const fetchImpl = createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: "http://engine/v1",
			request: { sessionId: "lead-1", leadPool: true, numCtx: 65_536 },
		});
		const send = () =>
			fetchImpl("http://engine/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify(leadBody("c:/one")),
			});
		await send();
		await send();
		const wire = engine.calls.filter(
			(call) => call.path === "/v1/chat/completions",
		);
		expect(wire[0]?.body.pool_id).toBe(0);
		expect(forks(engine)).toHaveLength(1);
		expect(forks(engine)[0]?.path).toBe("/polykv/pools/0/fork");
		expect(forks(engine)[0]?.body.session_id).toBe("lead-1");
		expect(String(forks(engine)[0]?.body.prompt)).toContain("c:/one");
		expect(wire[1]?.body.pool_id).toBe(1);
		// On the wire: the static system turn, then the environment.
		const messages = wire[1]?.body.messages as Array<{ content: string }>;
		expect(messages[0]?.content).toBe(STATIC);
		expect(getPolykvSession("lead-1")).toEqual({
			poolId: "1",
			prefixTokens: 140,
			layout: "lead",
		});
	});

	it("never forks without a window", async () => {
		const engine = stubEngine();
		const fetchImpl = createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: "http://engine/v1",
			request: { sessionId: "lead-1", leadPool: true },
		});
		for (let turn = 0; turn < 3; turn++) {
			await fetchImpl("http://engine/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify(leadBody("c:/one")),
			});
		}
		expect(forks(engine)).toHaveLength(0);
	});

	// A mode switch or a new day changes the environment: the old sub-pool no
	// longer matches, and holding it is a leak.
	it("replaces the sub-pool when the environment changes", async () => {
		const engine = stubEngine();
		const fetchImpl = (cwd: string) =>
			createOpencotiFetch({
				fetch: engine.fetch,
				baseUrl: "http://engine/v1",
				request: { sessionId: "lead-1", leadPool: true, numCtx: 65_536 },
			})("http://engine/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify(leadBody(cwd)),
			});
		await fetchImpl("c:/one");
		await fetchImpl("c:/one");
		await fetchImpl("c:/elsewhere");
		expect(forks(engine)).toHaveLength(2);
		expect(engine.pools.has("1")).toBe(false);
		expect(engine.pools.has("2")).toBe(true);
	});

	it("keeps the root until its last conversation ends", async () => {
		const engine = stubEngine();
		await prepare(engine, "lead-1", hoisted("c:/one"));
		await prepare(engine, "lead-2", hoisted("d:/two"));
		await releasePolykvLead("lead-1");
		expect(engine.pools.has("0")).toBe(true);
		await releasePolykvLead("lead-2");
		expect(engine.pools.has("0")).toBe(false);
		expect(polykvLeadState()).toEqual([]);
	});

	// A lapsed window takes its pools with it, and a request naming a released
	// pool is not refused -- it reprocesses in full, silently.
	it("re-makes a root the engine no longer holds after an idle gap", async () => {
		const engine = stubEngine();
		await prepare(engine, "lead-1", hoisted("c:/one"), 1_000);
		engine.pools.clear();
		await prepare(
			engine,
			"lead-1",
			hoisted("c:/one"),
			1_000 + POLYKV_LEAD_RECHECK_MS + 1,
		);
		expect(creates(engine)).toHaveLength(2);
	});

	it("runs unpooled on a server without pools", async () => {
		const engine = stubEngine({ poolsEnabled: false });
		expect(await prepare(engine, "lead-1", hoisted("c:/one"))).toBeUndefined();
		expect(creates(engine)).toHaveLength(0);
	});
});
