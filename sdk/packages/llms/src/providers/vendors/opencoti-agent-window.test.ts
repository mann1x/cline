import { estimateRequestInputTokens } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGatewayConfig } from "../compat";
import { createOpencotiFetch, readOpencotiRequestOptions } from "./opencoti";
import { agentWindowFloorForBody } from "./opencoti-agent-window";
import {
	getPolykvGrantedWindow,
	resetPolykvAvailability,
	resetPolykvSessions,
} from "./polykv";
import { releaseAllPolykvSwarms } from "./polykv-swarm";

const GUARANTEED = "elastic_guaranteed_alloc_v1";
const ATOMIC = "ctx_min_negotiation_v1";
const WINDOW = 131_072;

/**
 * A stub opencoti that negotiates windows and hosts swarms: `/props` names the
 * features, `/kv` the per-session maximum, and the pool routes build a tree.
 * Every chat body is recorded.
 */
function engine(features: string[] = [GUARANTEED, ATOMIC]) {
	const chats: Array<Record<string, unknown>> = [];
	let nextPool = 0;
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: {};
		const json = (value: unknown, headers: Record<string, string> = {}) =>
			new Response(JSON.stringify(value), {
				status: 200,
				headers: { "content-type": "application/json", ...headers },
			});
		if (url.pathname === "/props") {
			return json({ features });
		}
		if (url.pathname === "/kv") {
			return json({ session_ctx_max: 262_144 });
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
			return json({ pool_id: nextPool++, parent: -1, prefix_len: 10 });
		}
		if (/^\/sessions\/[^/]+\/close$/.test(url.pathname)) {
			return json({ found: true, released: true });
		}
		if (url.pathname === "/v1/chat/completions") {
			chats.push(body);
			const granted =
				typeof body.num_ctx === "number" ? String(body.num_ctx) : undefined;
			return json(
				{ choices: [{ message: { content: "ok" } }] },
				granted ? { "x-context-window": granted } : {},
			);
		}
		return new Response("{}", { status: 404 });
	}) as unknown as typeof fetch;
	return { chats, fetch: fetchImpl };
}

function agentBody(extra: Record<string, unknown> = {}) {
	return {
		model: "m",
		messages: [
			{ role: "system", content: "You are an agent. ".repeat(200) },
			{ role: "user", content: "the shared knowledge" },
			{ role: "user", content: "the role" },
			{ role: "user", content: "the task" },
		],
		tools: [
			{
				type: "function",
				function: {
					name: "read_files",
					description: "Read files. ".repeat(100),
					parameters: { type: "object", properties: {} },
				},
			},
		],
		max_tokens: 24_000,
		...extra,
	};
}

/** The minimum the body itself costs: its system turn, its tools, its cap. */
function minimumOf(body: ReturnType<typeof agentBody>): number {
	return (
		estimateRequestInputTokens({
			systemPrompt: body.messages[0]?.content ?? "",
			messages: [],
			tools: body.tools,
		}) + body.max_tokens
	);
}

beforeEach(() => {
	resetPolykvAvailability();
	resetPolykvSessions();
});

afterEach(async () => {
	await releaseAllPolykvSwarms();
});

describe("the agent window floor, measured off the request", () => {
	const body = agentBody();
	const minimum = minimumOf(body);

	it("is the minimum at 0%", () => {
		expect(
			agentWindowFloorForBody(body, { contextWindow: WINDOW, sharePercent: 0 }),
		).toBe(minimum);
	});

	it("is half way at 50%", () => {
		expect(
			agentWindowFloorForBody(body, {
				contextWindow: WINDOW,
				sharePercent: 50,
			}),
		).toBe(Math.floor(minimum + (WINDOW - minimum) / 2));
	});

	it("is the whole window at 100%", () => {
		expect(
			agentWindowFloorForBody(body, {
				contextWindow: WINDOW,
				sharePercent: 100,
			}),
		).toBe(WINDOW);
	});
});

describe("reading the agent window off the provider config", () => {
	it("carries the node's window and share through the gateway config", () => {
		const gateway = buildGatewayConfig({
			providerId: "opencoti",
			modelId: "m",
			agentWindow: { sharePercent: 30 },
		} as never);
		expect(gateway.options.agentWindow).toEqual({ sharePercent: 30 });
		const request = readOpencotiRequestOptions({
			config: { options: gateway.options },
			model: { contextWindow: WINDOW },
		} as never);
		expect(request.agentWindow).toEqual({
			contextWindow: WINDOW,
			sharePercent: 30,
		});
		// A per-agent session asks for the node's window.
		expect(request.numCtx).toBe(WINDOW);
	});

	// pandorum, 2026-09-25: Node1 set to 128,000 ran its agents at the
	// engine's 262,144. With the node's window resolved onto the model, every
	// kind of agent session asks for exactly that.
	it("asks for a 128,000 node window as num_ctx on every agent path", async () => {
		const nodeRequest = (options: Record<string, unknown>) =>
			readOpencotiRequestOptions({
				config: { options: { agentWindow: { sharePercent: 50 }, ...options } },
				model: { contextWindow: 128_000 },
			} as never);
		const sendWith = async (
			request: ReturnType<typeof readOpencotiRequestOptions>,
			body: Record<string, unknown>,
		) => {
			const stub = engine();
			const fetchImpl = createOpencotiFetch({
				fetch: stub.fetch,
				baseUrl: "http://x/v1",
				request,
			});
			await fetchImpl("http://x/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify(body),
			});
			return stub.chats;
		};

		// A per-agent session.
		const own = await sendWith(
			nodeRequest({ polykvSessionId: "node1-agent" }),
			agentBody(),
		);
		expect(own[0]?.num_ctx).toBe(128_000);
		expect(own[0]?.num_ctx_min).toBeLessThan(128_000);

		// A swarm worker's owner: the window for every agent it carries --
		// two of 128,000 in the engine's 262,144 (the node window is the
		// budget per agent, and the engine charges each worker to its owner).
		const pooled = await sendWith(
			nodeRequest({
				polykvWorker: {
					group: "node1-lead",
					sessionId: "node1-worker",
					layers: 2,
				},
			}),
			agentBody(),
		);
		expect(pooled.find((chat) => chat.max_tokens === 1)?.num_ctx).toBe(
			2 * 128_000,
		);

		// The same worker, unpooled.
		const alone = await sendWith(
			nodeRequest({
				polykvWorker: {
					group: "node1-lead-2",
					sessionId: "node1-alone",
					layers: 2,
				},
			}),
			{ ...agentBody(), messages: agentBody().messages.slice(0, 2) },
		);
		expect(alone.at(-1)?.num_ctx).toBe(128_000);
	});

	it("gives a swarm worker the default share when its config names none", () => {
		const request = readOpencotiRequestOptions({
			config: {
				options: {
					polykvWorker: { group: "g", sessionId: "w", layers: 2 },
				},
			},
			model: { contextWindow: 128_000 },
		} as never);
		expect(request.agentWindow).toEqual({ contextWindow: 128_000 });
	});

	it("reads nothing where the config says nothing", () => {
		const request = readOpencotiRequestOptions({
			config: { options: {} },
			model: { contextWindow: WINDOW },
		} as never);
		expect(request.agentWindow).toBeUndefined();
		expect(request.numCtx).toBeUndefined();
	});
});

describe("an agent's opencoti request", () => {
	it("asks a per-agent session for the node's window, floored at the share", async () => {
		const stub = engine();
		const body = agentBody();
		const fetchImpl = createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://x/v1",
			request: {
				sessionId: "agent-own",
				numCtx: WINDOW,
				agentWindow: { contextWindow: WINDOW, sharePercent: 50 },
			},
		});
		await fetchImpl("http://x/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		const minimum = minimumOf(body);
		expect(stub.chats[0]?.num_ctx).toBe(WINDOW);
		expect(stub.chats[0]?.num_ctx_min).toBe(
			Math.floor(minimum + (WINDOW - minimum) / 2),
		);
		// The grant is recorded, so compaction sizes against it.
		expect(getPolykvGrantedWindow("agent-own")).toBe(WINDOW);
	});

	it("opens a swarm owner for the agents it carries, floored at one agent's share", async () => {
		const stub = engine();
		const body = agentBody();
		const fetchImpl = createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://x/v1",
			request: {
				worker: { group: "lead-window", sessionId: "agent-pooled", layers: 2 },
				agentWindow: { contextWindow: WINDOW, sharePercent: 50 },
			},
		});
		await fetchImpl("http://x/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		const owner = stub.chats.find((chat) => chat.max_tokens === 1);
		const minimum = minimumOf(body);
		// The node's window for each agent it can carry -- two of 131,072 in
		// the engine's 262,144 -- and one agent's share as the floor.
		expect(owner?.num_ctx).toBe(2 * WINDOW);
		expect(owner?.num_ctx_min).toBe(
			Math.floor(minimum + (WINDOW - minimum) / 2),
		);
		// The pooled worker itself still books nothing: its window is the owner's.
		const worker = stub.chats.find((chat) => chat.max_tokens !== 1);
		expect(worker?.pool_id).toBeDefined();
		expect(worker).not.toHaveProperty("num_ctx");
	});

	it("books the node's window, floored, when the worker falls back to unpooled", async () => {
		const stub = engine();
		// Not shaped [system, 2 shared turns, task]: the worker runs unpooled.
		const body = {
			...agentBody(),
			messages: agentBody().messages.slice(0, 2),
		};
		const fetchImpl = createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://x/v1",
			request: {
				worker: { group: "lead-unpooled", sessionId: "agent-alone", layers: 2 },
				agentWindow: { contextWindow: WINDOW, sharePercent: 0 },
			},
		});
		await fetchImpl("http://x/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		const chat = stub.chats.at(-1);
		expect(chat).not.toHaveProperty("pool_id");
		expect(chat?.num_ctx).toBe(WINDOW);
		expect(chat?.num_ctx_min).toBe(minimumOf(body as never));
		expect(getPolykvGrantedWindow("agent-alone")).toBe(WINDOW);
	});

	it("sends no floor on a server that cannot negotiate one", async () => {
		const stub = engine([GUARANTEED]);
		const fetchImpl = createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://x/v1",
			request: {
				sessionId: "agent-old-engine",
				numCtx: WINDOW,
				agentWindow: { contextWindow: WINDOW, sharePercent: 50 },
			},
		});
		await fetchImpl("http://x/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(agentBody()),
		});
		expect(stub.chats[0]?.num_ctx).toBe(WINDOW);
		expect(stub.chats[0]).not.toHaveProperty("num_ctx_min");
	});
});
