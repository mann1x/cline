import { afterEach, describe, expect, it } from "vitest";
import { buildGatewayConfig } from "../compat";
import { createOpencotiFetch, readOpencotiRequestOptions } from "./opencoti";
import {
	createPolykvClient,
	getPolykvGrantedWindow,
	recordPolykvGrantedWindow,
	resetPolykvAvailability,
	resetPolykvSessions,
} from "./polykv";

const GUARANTEED = "elastic_guaranteed_alloc_v1";
const ATOMIC = "ctx_min_negotiation_v1";

/** A stub opencoti: `/props`, the chat route (granting what was asked), slots. */
function engine() {
	const chats: Array<Record<string, unknown>> = [];
	const posts: Array<{ path: string; body: unknown }> = [];
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
		if (init?.method === "POST") {
			posts.push({ path: `${url.pathname}${url.search}`, body });
		}
		if (url.pathname === "/props") {
			return json({ features: [GUARANTEED, ATOMIC] });
		}
		if (url.pathname === "/v1/chat/completions") {
			chats.push(body);
			return json(
				{ choices: [{ message: { content: "ok" } }] },
				typeof body.num_ctx === "number"
					? { "x-context-window": String(body.num_ctx) }
					: {},
			);
		}
		if (url.pathname === "/slots") {
			return json([
				{ id: 0, opencoti: { session_id: "someone-else" } },
				{ id: 3, opencoti: { session_id: "lead~cc1-critic-first" } },
			]);
		}
		if (url.pathname === "/slots/3") {
			return json({ id_slot: 3, n_erased: 4096 });
		}
		if (/^\/sessions\/[^/]+\/close$/.test(url.pathname)) {
			return json({ session_id: "x", found: false, kv_dropped: true });
		}
		if (url.pathname === "/polykv/pools") {
			return json({ pool_id: 0, parent: -1, prefix_len: 2950, owner: "" });
		}
		if (url.pathname.endsWith("/fork")) {
			return json({
				pool_id: 1,
				parent: 0,
				prefix_len: 3409,
				owner: "lead",
			});
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetch: fetchImpl, chats, posts };
}

afterEach(() => {
	resetPolykvSessions();
	resetPolykvAvailability();
});

describe("a compaction call's exact booking", () => {
	it("carries the booking and the lead-tree opt-out through the gateway config", () => {
		const gateway = buildGatewayConfig({
			providerId: "opencoti",
			modelId: "m",
			engineSessionId: "lead~cc1-synth",
			polykvBooking: { numCtx: 6_144 },
			polykvLeadPool: false,
		} as never);
		expect(gateway.options.polykvBooking).toEqual({ numCtx: 6_144 });
		expect(gateway.options.polykvLeadPool).toBe(false);
	});

	it("asks for exactly the booking, floored at itself, and never the lead tree", () => {
		const request = readOpencotiRequestOptions({
			config: {
				options: {
					polykvSessionId: "lead~cc1-synth",
					polykvBooking: { numCtx: 6_144 },
					polykvLeadPool: false,
					polykv: { dynamicContextSize: true, contextFloor: 32_768 },
				},
			},
			model: { contextWindow: 131_072 },
		} as never);
		expect(request.numCtx).toBe(6_144);
		expect(request.numCtxMin).toBe(6_144);
		expect(request.transientBooking).toBe(true);
		expect(request.leadPool).toBeUndefined();
		expect(request.resume).toBeUndefined();
	});

	// A per-request lead's writer books an exact window under the lead's own
	// session id. Recording that grant would size every later turn of the
	// conversation against one summary call's window.
	it("does not record the transient grant as the session's window", async () => {
		const stub = engine();
		const fetchImpl = createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://x/v1",
			request: {
				sessionId: "lead-session",
				numCtx: 9_000,
				numCtxMin: 9_000,
				transientBooking: true,
			},
		});
		await fetchImpl("http://x/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
		});
		expect(stub.chats[0]?.num_ctx).toBe(9_000);
		expect(stub.chats[0]?.num_ctx_min).toBe(9_000);
		expect(getPolykvGrantedWindow("lead-session")).toBeUndefined();
	});

	it("leaves a window the session already holds exactly as it was", async () => {
		recordPolykvGrantedWindow("lead-held", 65_536);
		const stub = engine();
		const fetchImpl = createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://x/v1",
			request: {
				sessionId: "lead-held",
				numCtx: 9_000,
				numCtxMin: 9_000,
				transientBooking: true,
			},
		});
		await fetchImpl("http://x/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
		});
		expect(getPolykvGrantedWindow("lead-held")).toBe(65_536);
	});
});

describe("the control-plane calls compaction releases with", () => {
	it("reads a pool's owner, empty when it is unowned", async () => {
		const stub = engine();
		const client = createPolykvClient({
			baseUrl: "http://x",
			fetch: stub.fetch,
		});
		const root = await client.createPool({ from_session: "lead", pin: true });
		expect(root.owner).toBe("");
		const child = await client.forkPool(root.pool_id, {
			from_session: "lead",
			branch_pos: 2922,
			pin: true,
		});
		expect(child.owner).toBe("lead");
		expect(child.parent).toBe("0");
	});

	it("reports that a close with no booking still dropped the slot's cells", async () => {
		const stub = engine();
		const client = createPolykvClient({
			baseUrl: "http://x",
			fetch: stub.fetch,
		});
		expect(await client.closeSessionReport("lead~cc1-critic-first")).toEqual({
			found: false,
			kvDropped: true,
		});
	});

	it("erases the slot a session last ran in, and only that one", async () => {
		const stub = engine();
		const client = createPolykvClient({
			baseUrl: "http://x",
			fetch: stub.fetch,
		});
		expect(await client.eraseSessionSlot("lead~cc1-critic-first")).toBe(4096);
		expect(stub.posts.map((post) => post.path)).toEqual([
			"/slots/3?action=erase",
		]);
		expect(await client.eraseSessionSlot("nobody")).toBeUndefined();
	});
});
