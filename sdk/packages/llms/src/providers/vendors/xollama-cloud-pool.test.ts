import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveAgentSlotLimit } from "../agent-slots";
import { resetOllamaAccountStatus } from "./ollama-account";
import {
	ollamaAccountSlotUsage,
	resetOllamaAccountSlots,
	withOllamaAccountSlots,
} from "./ollama-account-slots";
import { resetXollamaProbes } from "./xollama";
import {
	describeXollamaCloudPool,
	parseXollamaCloudPool,
	readXollamaCloudPool,
	resetXollamaCloudPools,
	XOLLAMA_CLOUD_POOL_TTL_MS,
	xollamaPoolKey,
} from "./xollama-cloud-pool";

afterEach(() => {
	resetOllamaAccountSlots();
	resetOllamaAccountStatus();
	resetXollamaCloudPools();
	resetXollamaProbes();
	vi.restoreAllMocks();
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const CLOUD = "deepseek-v4.1-flash:cloud";

/**
 * An xOllama server whose primary account is on Pro (3 at once by the plan
 * table) and which serves cloud models through a pool. `features` without
 * `cloud_accounts_v1` is an older build; `key` puts the pool route behind
 * the local API key.
 */
function xollama(options: {
	pool: Record<string, unknown>;
	features?: string[];
	key?: string;
	chatStatus?: number;
}) {
	const state = {
		pool: options.pool,
		poolReads: 0,
		chatStatus: options.chatStatus ?? 200,
	};
	const chats: Array<{ finish: () => void }> = [];
	const fetchImpl = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = String(input);
		if (url.endsWith("/api/xollama")) {
			return json({
				xollama: true,
				version: "0.41.0",
				features: options.features ?? ["cloud_accounts_v1"],
			});
		}
		if (url.endsWith("/api/xollama/cloud")) {
			const auth = new Headers(init?.headers).get("authorization");
			if (options.key && auth !== `Bearer ${options.key}`) {
				return json({ error: "unauthorized" }, 401);
			}
			state.poolReads += 1;
			return json(state.pool);
		}
		if (url.endsWith("/api/tags")) {
			return json({
				models: [
					{ name: CLOUD, remote_host: "https://ollama.com:443" },
					{ name: "qwen3:8b" },
				],
			});
		}
		if (url.endsWith("/api/experimental/model-recommendations"))
			return json({});
		if (url.endsWith("/api/me")) {
			return json({ ID: "primary", Name: "owner", Plan: "pro" });
		}
		if (url.endsWith("/api/chat")) {
			if (state.chatStatus !== 200) {
				return json(
					{
						error:
							"every Ollama Cloud account of this server has reached its usage limit or is not signed in; the first one is back at 2026-11-23T00:00:00Z",
					},
					state.chatStatus,
				);
			}
			let finish = () => {};
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode("{}\n"));
					finish = () => controller.close();
				},
			});
			chats.push({ finish: () => finish() });
			return new Response(body, { status: 200 });
		}
		return json({}, 404);
	}) as typeof fetch;
	return { fetchImpl, chats, state };
}

const BASE = "http://pool:11435";

const chat = (f: typeof fetch) =>
	f(`${BASE}/api/chat`, {
		method: "POST",
		body: JSON.stringify({ model: CLOUD, messages: [] }),
	});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const POOL = {
	accounts: 4,
	accounts_at_once: 3,
	parallel: 9,
	parallel_now: 9,
	in_use: 0,
	queued: 0,
	exhausted: 0,
	next_reset: "2026-11-23T00:00:00Z",
	pool: [{ label: "work-2", plan: "pro", parallel: 3, in_use: 0 }],
};

describe("describeXollamaCloudPool", () => {
	// Live, 2026-11-22: a signed-out primary counts in `accounts`, and an
	// omitted accounts_at_once means all of them.
	it("says 'at once' only when fewer accounts take requests than are configured", () => {
		const pool = parseXollamaCloudPool({
			accounts: 2,
			parallel: 3,
			parallel_now: 3,
		});
		expect(describeXollamaCloudPool(pool as never)).toBe(
			"xOllama pool of 2 Ollama Cloud account(s)",
		);
		expect(describeXollamaCloudPool(parseXollamaCloudPool(POOL) as never)).toBe(
			"xOllama pool of 4 Ollama Cloud account(s), 3 at once",
		);
	});
});

describe("parseXollamaCloudPool", () => {
	it("reads the route, and is nothing for a server with no pool", () => {
		expect(parseXollamaCloudPool(POOL)).toEqual({
			accounts: 4,
			accountsAtOnce: 3,
			parallel: 9,
			parallelNow: 9,
			exhausted: 0,
			nextReset: "2026-11-23T00:00:00Z",
		});
		expect(parseXollamaCloudPool({ accounts: 0 })).toBeUndefined();
		expect(parseXollamaCloudPool(null)).toBeUndefined();
	});
});

// xollama mail 2381 (2026-11-22): /api/me answers for the primary account
// alone, so the plan cap stopped at 3 while the server served 9.
describe("an xOllama server with a pool of cloud accounts", () => {
	it("is capped at the pool's parallel_now, not the primary account's plan", async () => {
		const s = xollama({ pool: POOL });
		const f = withOllamaAccountSlots(s.fetchImpl, {
			baseUrl: BASE,
			probeFetch: s.fetchImpl,
			providerId: "xollama",
		});
		for (let i = 0; i < 9; i += 1) await chat(f);
		let tenth: Response | undefined;
		void chat(f).then((response) => {
			tenth = response;
		});
		await tick();
		expect(s.chats).toHaveLength(9);
		expect(tenth).toBeUndefined();
		expect(ollamaAccountSlotUsage(xollamaPoolKey(BASE))).toEqual({
			active: 9,
			waiting: 1,
			limit: 9,
		});
	});

	it("keeps the plan cap on a server without the feature", async () => {
		const s = xollama({ pool: POOL, features: [] });
		const f = withOllamaAccountSlots(s.fetchImpl, {
			baseUrl: BASE,
			probeFetch: s.fetchImpl,
			providerId: "xollama",
		});
		for (let i = 0; i < 3; i += 1) await chat(f);
		void chat(f);
		await tick();
		expect(s.chats).toHaveLength(3);
		expect(s.state.poolReads).toBe(0);
	});

	it("keeps the plan cap on the Ollama provider, which has no pool", async () => {
		const s = xollama({ pool: POOL });
		const f = withOllamaAccountSlots(s.fetchImpl, {
			baseUrl: BASE,
			probeFetch: s.fetchImpl,
			providerId: "ollama",
		});
		for (let i = 0; i < 3; i += 1) await chat(f);
		void chat(f);
		await tick();
		expect(s.chats).toHaveLength(3);
	});

	it("lets a request through when every account is out, so the server's 402 says when one is back", async () => {
		const s = xollama({
			pool: { ...POOL, parallel_now: 0, exhausted: 4 },
			chatStatus: 402,
		});
		const f = withOllamaAccountSlots(s.fetchImpl, {
			baseUrl: BASE,
			probeFetch: s.fetchImpl,
			providerId: "xollama",
		});
		const response = await chat(f);
		expect(response.status).toBe(402);
		expect(await response.text()).toContain("the first one is back at");
	});

	it("reads the pool again right after a 402", async () => {
		const s = xollama({ pool: POOL, chatStatus: 402 });
		const f = withOllamaAccountSlots(s.fetchImpl, {
			baseUrl: BASE,
			probeFetch: s.fetchImpl,
			providerId: "xollama",
		});
		await chat(f);
		await tick();
		expect(s.state.poolReads).toBe(2);
	});

	it("is read again once a minute old, without making a request wait for it", async () => {
		const s = xollama({ pool: POOL });
		let now = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		expect((await readXollamaCloudPool(BASE, s.fetchImpl))?.parallelNow).toBe(
			9,
		);
		s.state.pool = { ...POOL, parallel_now: 6, exhausted: 1 };
		expect((await readXollamaCloudPool(BASE, s.fetchImpl))?.parallelNow).toBe(
			9,
		);
		now += XOLLAMA_CLOUD_POOL_TTL_MS;
		// The stale reading answers; the new one lands behind it.
		expect((await readXollamaCloudPool(BASE, s.fetchImpl))?.parallelNow).toBe(
			9,
		);
		await tick();
		expect((await readXollamaCloudPool(BASE, s.fetchImpl))?.parallelNow).toBe(
			6,
		);
	});
});

describe("resolveAgentSlotLimit on a pooled xOllama", () => {
	it("uses parallel_now, and a profile may only lower it", async () => {
		const s = xollama({ pool: POOL });
		const base = {
			providerId: "xollama",
			baseUrl: BASE,
			modelId: CLOUD,
			fetch: s.fetchImpl,
		};
		const unset = await resolveAgentSlotLimit(base);
		expect(unset.limit).toBe(9);
		expect(unset.accountCap).toEqual({ plan: "xOllama pool", limit: 9 });
		expect(unset.reason).toContain("4 Ollama Cloud account(s), 3 at once");
		expect(
			(await resolveAgentSlotLimit({ ...base, parallelSessions: 4 })).limit,
		).toBe(4);
		expect(
			(await resolveAgentSlotLimit({ ...base, parallelSessions: 20 })).limit,
		).toBe(9);
	});

	it("reads the pool with the endpoint's key, and falls back to the plan without it", async () => {
		const s = xollama({ pool: POOL, key: "local-key" });
		const base = {
			providerId: "xollama",
			baseUrl: BASE,
			modelId: CLOUD,
			fetch: s.fetchImpl,
		};
		expect((await resolveAgentSlotLimit(base)).limit).toBe(3);
		resetXollamaCloudPools();
		expect(
			(await resolveAgentSlotLimit({ ...base, apiKey: "local-key" })).limit,
		).toBe(9);
	});

	it("stays at one, never uncapped, when every account is out, and says when the first is back", async () => {
		const s = xollama({ pool: { ...POOL, parallel_now: 0, exhausted: 4 } });
		const slots = await resolveAgentSlotLimit({
			providerId: "xollama",
			baseUrl: BASE,
			modelId: CLOUD,
			fetch: s.fetchImpl,
		});
		expect(slots.limit).toBe(1);
		expect(slots.reason).toContain("reached its usage limit or is signed out");
		expect(slots.reason).toContain("the first is back at 2026-11-23T00:00:00Z");
	});
});
