import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentSlotLimit } from "../agent-slots";
import { parseOllamaWhoami, resetOllamaAccountStatus } from "./ollama-account";
import {
	acquireOllamaAccountSlot,
	ollamaAccountSlotUsage,
	ollamaPlanConcurrency,
	resetOllamaAccountSlots,
	withOllamaAccountSlots,
} from "./ollama-account-slots";

afterEach(() => {
	resetOllamaAccountSlots();
	resetOllamaAccountStatus();
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/** An Ollama server signed in as `account` on `plan`, offering one cloud and one local model. */
function server(account: { id: string; plan: string } | undefined) {
	const chats: Array<{ model: string; finish: () => void }> = [];
	const fetchImpl = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = String(input);
		if (url.endsWith("/api/tags")) {
			return json({
				models: [
					{
						name: "deepseek-v4.1-flash:cloud",
						remote_host: "https://ollama.com:443",
					},
					{ name: "qwen3:8b" },
				],
			});
		}
		if (url.endsWith("/api/experimental/model-recommendations"))
			return json({});
		if (url.endsWith("/api/me")) {
			return account
				? json({ ID: account.id, Name: "someone", Plan: account.plan })
				: json({ signin_url: "https://ollama.com/connect" }, 401);
		}
		if (url.endsWith("/api/chat")) {
			const model = JSON.parse(String(init?.body)).model as string;
			let finish = () => {};
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("{}\n"));
					finish = () => controller.close();
				},
			});
			chats.push({ model, finish: () => finish() });
			return new Response(body, { status: 200 });
		}
		return json({}, 404);
	}) as typeof fetch;
	return { fetchImpl, chats };
}

const chat = (
	f: typeof fetch,
	base: string,
	model: string,
	signal?: AbortSignal,
) =>
	f(`${base}/api/chat`, {
		method: "POST",
		body: JSON.stringify({ model, messages: [] }),
		...(signal ? { signal } : {}),
	});

async function drain(response: Response): Promise<void> {
	const reader = (response.body as ReadableStream<Uint8Array>).getReader();
	while (!(await reader.read()).done) {}
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("the plan's allowance", () => {
	it("is what Ollama publishes, and nothing for a plan it does not know", () => {
		expect(ollamaPlanConcurrency("pro")).toBe(3);
		expect(ollamaPlanConcurrency("Free")).toBe(3);
		expect(ollamaPlanConcurrency("max")).toBe(10);
		expect(ollamaPlanConcurrency("team")).toBe(10);
		expect(ollamaPlanConcurrency("enterprise")).toBeUndefined();
		expect(ollamaPlanConcurrency(undefined)).toBeUndefined();
	});

	it("is keyed by an opaque account key that carries no identity", () => {
		const a = parseOllamaWhoami(200, { ID: "u-123", Name: "x", Plan: "pro" });
		const b = parseOllamaWhoami(200, { ID: "u-123", Name: "y", Plan: "pro" });
		const c = parseOllamaWhoami(200, { ID: "u-456", Name: "x", Plan: "pro" });
		expect(a.key).toBe(b.key);
		expect(a.key).not.toBe(c.key);
		expect(a.key).not.toContain("u-123");
		expect(a.name).toBe("x");
	});
});

describe("account slots", () => {
	const cap = { key: "acct-1", plan: "pro", limit: 2 };

	it("grants up to the limit, queues the rest, and grants in order on release", async () => {
		const first = await acquireOllamaAccountSlot(cap);
		await acquireOllamaAccountSlot(cap);
		let third: (() => void) | undefined;
		void acquireOllamaAccountSlot(cap).then((release) => {
			third = release;
		});
		await tick();
		expect(third).toBeUndefined();
		expect(ollamaAccountSlotUsage("acct-1")).toEqual({
			active: 2,
			waiting: 1,
			limit: 2,
		});
		first();
		first(); // idempotent
		await tick();
		expect(third).toBeTypeOf("function");
		expect(ollamaAccountSlotUsage("acct-1")).toEqual({
			active: 2,
			waiting: 0,
			limit: 2,
		});
	});

	it("drops a waiter whose request is cancelled", async () => {
		await acquireOllamaAccountSlot(cap);
		await acquireOllamaAccountSlot(cap);
		const controller = new AbortController();
		const waiting = acquireOllamaAccountSlot(cap, controller.signal);
		controller.abort(new Error("cancelled"));
		await expect(waiting).rejects.toThrow("cancelled");
		expect(ollamaAccountSlotUsage("acct-1")?.waiting).toBe(0);
	});
});

describe("withOllamaAccountSlots", () => {
	it("shares one pro allowance across two servers signed in as one account", async () => {
		const home = server({ id: "u-1", plan: "pro" });
		const e2g = server({ id: "u-1", plan: "pro" });
		const a = withOllamaAccountSlots(home.fetchImpl, {
			baseUrl: "http://home:11434",
			probeFetch: home.fetchImpl,
		});
		const b = withOllamaAccountSlots(e2g.fetchImpl, {
			baseUrl: "http://e2g:22434",
			probeFetch: e2g.fetchImpl,
		});
		const running = [
			await chat(a, "http://home:11434", "deepseek-v4.1-flash:cloud"),
			await chat(a, "http://home:11434", "deepseek-v4.1-flash:cloud"),
			await chat(b, "http://e2g:22434", "deepseek-v4.1-flash:cloud"),
		];
		let fourth: Response | undefined;
		void chat(b, "http://e2g:22434", "deepseek-v4.1-flash:cloud").then((r) => {
			fourth = r;
		});
		await tick();
		expect(fourth).toBeUndefined();
		expect(e2g.chats).toHaveLength(1);
		// The first stream ends: its slot goes to the waiting request.
		home.chats[0]?.finish();
		await drain(running[0] as Response);
		await tick();
		expect(fourth).toBeDefined();
		expect(e2g.chats).toHaveLength(2);
	});

	it("does not count local models, or a server that is not signed in", async () => {
		const signedIn = server({ id: "u-1", plan: "pro" });
		const f = withOllamaAccountSlots(signedIn.fetchImpl, {
			baseUrl: "http://home:11434",
			probeFetch: signedIn.fetchImpl,
		});
		for (let i = 0; i < 5; i += 1)
			await chat(f, "http://home:11434", "qwen3:8b");
		expect(signedIn.chats).toHaveLength(5);

		const anonymous = server(undefined);
		const g = withOllamaAccountSlots(anonymous.fetchImpl, {
			baseUrl: "http://other:11434",
			probeFetch: anonymous.fetchImpl,
		});
		for (let i = 0; i < 5; i += 1)
			await chat(g, "http://other:11434", "deepseek-v4.1-flash:cloud");
		expect(anonymous.chats).toHaveLength(5);
	});

	it("gives the slot back when a waiting request is cancelled", async () => {
		const s = server({ id: "u-2", plan: "pro" });
		const f = withOllamaAccountSlots(s.fetchImpl, {
			baseUrl: "http://home:11434",
			probeFetch: s.fetchImpl,
		});
		for (let i = 0; i < 3; i += 1)
			await chat(f, "http://home:11434", "deepseek-v4.1-flash:cloud");
		const controller = new AbortController();
		const waiting = chat(
			f,
			"http://home:11434",
			"deepseek-v4.1-flash:cloud",
			controller.signal,
		);
		await tick();
		controller.abort(new Error("stopped"));
		await expect(waiting).rejects.toThrow("stopped");
		expect(s.chats).toHaveLength(3);
	});
});

describe("resolveAgentSlotLimit on an Ollama cloud model", () => {
	it("uses the plan when nothing is configured, and never lets a profile exceed it", async () => {
		const s = server({ id: "u-3", plan: "pro" });
		const base = {
			providerId: "ollama",
			baseUrl: "http://home:11434",
			fetch: s.fetchImpl,
		};
		const cloud = "deepseek-v4.1-flash:cloud";
		expect(
			(await resolveAgentSlotLimit({ ...base, modelId: cloud })).limit,
		).toBe(3);
		expect(
			(
				await resolveAgentSlotLimit({
					...base,
					modelId: cloud,
					parallelSessions: 8,
				})
			).limit,
		).toBe(3);
		expect(
			(
				await resolveAgentSlotLimit({
					...base,
					modelId: cloud,
					parallelSessions: 2,
				})
			).limit,
		).toBe(2);
		const local = await resolveAgentSlotLimit({
			...base,
			modelId: "qwen3:8b",
			parallelSessions: 8,
		});
		expect(local.limit).toBe(8);
		expect(local.accountCap).toBeUndefined();
	});
});
