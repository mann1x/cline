import { afterEach, describe, expect, it } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import {
	getPolykvSession,
	resetPolykvAvailability,
	resetPolykvSessions,
	setPolykvSession,
} from "./polykv";

/** A stub opencoti: `/props`, the chat route, `/apply-template`, pools. */
function engine() {
	const chats: Array<Record<string, unknown>> = [];
	const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
	let nextPool = 10;
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: {};
		const json = (value: unknown) =>
			new Response(JSON.stringify(value), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		if (init?.method === "POST") {
			posts.push({ path: url.pathname, body });
		}
		if (url.pathname === "/props") {
			return json({ features: ["pool_continue_v1"] });
		}
		if (url.pathname === "/v1/chat/completions") {
			chats.push(body);
			return json({ choices: [{ message: { content: "ok" } }] });
		}
		if (url.pathname === "/apply-template") {
			const think = body.reasoning_budget_tokens !== 0 ? "<|think|>" : "";
			return json({ prompt: `<bos><|turn>system\n${think}rendered<turn|>` });
		}
		if (url.pathname === "/polykv/pools") {
			return json({ pool_id: nextPool++, parent: -1, prefix_len: 5_600 });
		}
		if (/\/polykv\/pools\/\d+\/(unpin|release)$/.test(url.pathname)) {
			return json({ ok: true });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetch: fetchImpl, chats, posts };
}

const send = (
	fetchImpl: typeof fetch,
	body: Record<string, unknown>,
): Promise<Response> =>
	fetchImpl("http://x/v1/chat/completions", {
		method: "POST",
		body: JSON.stringify(body),
	});

const conversation = {
	messages: [
		{ role: "system", content: "You are the agent." },
		{ role: "user", content: "task" },
		{ role: "assistant", content: "summary" },
		{ role: "user", content: "review the first half" },
	],
	tools: [{ type: "function", function: { name: "read_files" } }],
	tool_choice: "none",
	reasoning_budget_tokens: 0,
};

afterEach(() => {
	resetPolykvSessions();
	resetPolykvAvailability();
});

describe("a request that continues its pool", () => {
	it("sends only the new turn, flagged, without the tools", async () => {
		const stub = engine();
		setPolykvSession("lead~cc1-critic-first", {
			poolId: "6",
			prefixTokens: 19_009,
			layout: "borrowed",
			continueTail: 1,
		});
		const fetchImpl = createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://x/v1",
			request: { sessionId: "lead~cc1-critic-first" },
		});
		await send(fetchImpl, conversation);
		expect(stub.chats).toHaveLength(1);
		const wire = stub.chats[0];
		expect(wire.continue_pool).toBe(true);
		expect(wire.pool_id).toBe(6);
		expect(wire.messages).toEqual([
			{ role: "user", content: "review the first half" },
		]);
		expect(wire.tools).toBeUndefined();
		expect(wire.tool_choice).toBeUndefined();
		// A continuation never renders the root again: its prefix is the pool.
		expect(stub.posts.some((post) => post.path === "/apply-template")).toBe(
			false,
		);
	});

	it("leaves a request without the flag as it was", async () => {
		const stub = engine();
		setPolykvSession("lead~cc1-critic-first", {
			poolId: "6",
			prefixTokens: 19_009,
			layout: "borrowed",
		});
		const fetchImpl = createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://x/v1",
			request: { sessionId: "lead~cc1-critic-first" },
		});
		await send(fetchImpl, conversation);
		expect(stub.chats[0].continue_pool).toBeUndefined();
		expect(stub.chats[0].messages).toHaveLength(4);
	});
});

describe("a session's own root", () => {
	it("is rendered again with the request's fields, once, and the old pool released", async () => {
		const stub = engine();
		// What `ensurePolykvPool` leaves: a root rendered before any request.
		setPolykvSession("lead", { poolId: "4", prefixTokens: 141 });
		const fetchImpl = createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://x/v1",
			request: { sessionId: "lead", poolId: "4" },
		});
		await send(fetchImpl, conversation);
		const render = stub.posts.find((post) => post.path === "/apply-template");
		// The fields that decide `<|think|>` travel with the rendering.
		expect(render?.body.reasoning_budget_tokens).toBe(0);
		expect(render?.body.messages).toEqual([conversation.messages[0]]);
		expect(render?.body.add_generation_prompt).toBe(false);
		const create = stub.posts.find((post) => post.path === "/polykv/pools");
		expect(create?.body.prompt).toBe("<bos><|turn>system\nrendered<turn|>\n");
		expect(stub.chats[0].pool_id).toBe(10);
		expect(getPolykvSession("lead")?.poolId).toBe("10");
		expect(stub.posts.map((post) => post.path)).toEqual(
			expect.arrayContaining([
				"/polykv/pools/4/unpin",
				"/polykv/pools/4/release",
			]),
		);

		// The same fields again: nothing is rendered, the new root is attached.
		await send(fetchImpl, conversation);
		expect(
			stub.posts.filter((post) => post.path === "/apply-template"),
		).toHaveLength(1);
		expect(stub.chats[1].pool_id).toBe(10);
	});

	it("is rendered again when the reasoning fields change the template", async () => {
		const stub = engine();
		setPolykvSession("lead", { poolId: "4", prefixTokens: 141 });
		const fetchImpl = createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://x/v1",
			request: { sessionId: "lead", poolId: "4" },
		});
		await send(fetchImpl, conversation);
		await send(fetchImpl, { ...conversation, reasoning_budget_tokens: 2_048 });
		const renders = stub.posts.filter(
			(post) => post.path === "/apply-template",
		);
		expect(renders).toHaveLength(2);
		expect(stub.chats[1].pool_id).toBe(11);
	});
});
