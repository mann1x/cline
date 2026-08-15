import { getPolykvSession, resetPolykvSessions } from "@cline/llms";
import { afterEach, describe, expect, it } from "vitest";
import {
	ensurePolykvPool,
	isPolykvProvider,
	polykvSaysCompact,
	readPolykvCapacity,
	releasePolykvSession,
	renderPolykvPrefix,
	repointPolykvAfterCompaction,
} from "./polykv-session";

/** A stand-in engine that records what the control plane was asked for. */
function engine(
	overrides: {
		tokenize?: number[];
		pools?: Array<{ pool_id: string; prefix_len: number }>;
		capacity?: Record<string, unknown>;
		fail?: string;
	} = {},
) {
	const calls: Array<{ method: string; path: string; body?: unknown }> = [];
	let created = 0;
	const pools = overrides.pools ?? [
		{ pool_id: "pool-root", prefix_len: 12_859 },
		{ pool_id: "pool-fork", prefix_len: 14_000 },
	];
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body ? JSON.parse(String(init.body)) : undefined;
		calls.push({
			method: init?.method ?? "GET",
			path: `${url.pathname}${url.search}`,
			body,
		});
		if (overrides.fail && url.pathname.includes(overrides.fail)) {
			return new Response("nope", { status: 500 });
		}
		if (url.pathname === "/tokenize") {
			return Response.json({ tokens: overrides.tokenize ?? [1, 2, 3] });
		}
		if (url.pathname.endsWith("/capacity")) {
			return Response.json(
				overrides.capacity ?? { can_admit: true, compaction_pressure: 0.1 },
			);
		}
		if (url.pathname.endsWith("/pin") || init?.method === "DELETE") {
			return new Response(null, { status: 204 });
		}
		const pool = pools[Math.min(created, pools.length - 1)];
		created += 1;
		return Response.json(pool);
	}) as unknown as typeof fetch;
	return { calls, fetch: fetchImpl };
}

const provider = (fetchImpl: typeof fetch) => ({
	providerId: "opencoti",
	baseUrl: "http://localhost:8080/v1",
	fetch: fetchImpl,
});

afterEach(() => {
	resetPolykvSessions();
});

describe("deciding whether there is a pool tree at all", () => {
	it("is opencoti with a base URL, and nothing else", () => {
		expect(
			isPolykvProvider({ providerId: "opencoti", baseUrl: "http://h/v1" }),
		).toBe(true);
		expect(isPolykvProvider({ providerId: "opencoti" })).toBe(false);
		expect(
			isPolykvProvider({ providerId: "ollama", baseUrl: "http://h" }),
		).toBe(false);
		expect(isPolykvProvider(undefined)).toBe(false);
	});
});

describe("the shared prefix", () => {
	// The engine matches a prefix by hashing tokens, so a prefix assembled in a
	// different order than it is sent matches nothing and the pool buys nothing.
	it("is the system prompt then the tools, in that order", () => {
		const prefix = renderPolykvPrefix({
			systemPrompt: "You are Cline.",
			tools: [{ name: "editor" }],
		});
		expect(prefix.indexOf("You are Cline.")).toBeLessThan(
			prefix.indexOf("editor"),
		);
	});

	it("is empty when there is nothing stable to pin", () => {
		expect(renderPolykvPrefix({})).toBe("");
	});
});

describe("pinning the session's root pool", () => {
	it("tokenizes the prefix, creates the pool pinned, and remembers it", async () => {
		const server = engine({ tokenize: [1, 2, 3, 4] });
		const poolId = await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
			systemPrompt: "You are Cline.",
			tools: [{ name: "editor" }],
		});

		expect(poolId).toBe("pool-root");
		expect(getPolykvSession("s1")).toEqual({
			poolId: "pool-root",
			prefixTokens: 12_859,
		});
		expect(server.calls[0].path).toBe("/tokenize");
		expect(server.calls[1]).toMatchObject({
			method: "POST",
			path: "/polykv/pools",
			body: { tokens: [1, 2, 3, 4], pin: true },
		});
	});

	it("does not create a second pool for a session that has one", async () => {
		const server = engine();
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: config,
			systemPrompt: "prompt",
		});
		const again = await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: config,
			systemPrompt: "prompt",
		});

		expect(again).toBe("pool-root");
		expect(server.calls.filter((c) => c.path === "/polykv/pools")).toHaveLength(
			1,
		);
	});

	// Slower, never broken: a session that cannot pin its prefix is the session
	// every other provider already runs.
	it("runs unpooled when the engine will not create a pool", async () => {
		const server = engine({ fail: "/polykv/pools" });
		const poolId = await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
			systemPrompt: "prompt",
		});

		expect(poolId).toBeUndefined();
		expect(getPolykvSession("s1")).toBeUndefined();
	});

	it("stays out of the way of every other provider", async () => {
		const server = engine();
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: {
				providerId: "ollama",
				baseUrl: "http://localhost:11434",
				fetch: server.fetch,
			},
			systemPrompt: "prompt",
		});

		expect(server.calls).toHaveLength(0);
	});
});

describe("what the engine says about its own room", () => {
	it("asks about the pool, for the turn about to be sent", async () => {
		const server = engine({
			capacity: { can_admit: true, compaction_pressure: 0.92 },
		});
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: config,
			systemPrompt: "prompt",
		});

		const capacity = await readPolykvCapacity({
			sessionId: "s1",
			providerConfig: config,
			expectedTokens: 94_454,
		});

		expect(capacity?.compaction_pressure).toBe(0.92);
		expect(server.calls.at(-1)?.path).toBe(
			"/polykv/pools/pool-root/capacity?expected_tokens=94454",
		);
		expect(polykvSaysCompact(capacity)).toBe(true);
	});

	it("says nothing for a session with no pool", async () => {
		const server = engine();
		expect(
			await readPolykvCapacity({
				sessionId: "s1",
				providerConfig: provider(server.fetch),
			}),
		).toBeUndefined();
		expect(server.calls).toHaveLength(0);
	});

	// A settling pool reports pressure that describes a state it is leaving.
	it("does not act on a pool that is still settling", () => {
		expect(
			polykvSaysCompact({
				can_admit: true,
				compaction_pressure: 0.99,
				settling: true,
			}),
		).toBe(false);
		expect(
			polykvSaysCompact({ can_admit: true, compaction_pressure: 0.4 }),
		).toBe(false);
		expect(polykvSaysCompact(undefined)).toBe(false);
	});
});

describe("re-rooting after a compaction", () => {
	it("forks at the shared prefix, migrates, then releases the old pool", async () => {
		const server = engine({ tokenize: [9, 9, 9] });
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: config,
			systemPrompt: "prompt",
		});
		server.calls.length = 0;

		const forked = await repointPolykvAfterCompaction({
			sessionId: "s1",
			providerConfig: config,
			compactedPrompt: "the summary and the recent tail",
		});

		expect(forked).toBe("pool-fork");
		// The branch is the prefix the compaction did not touch, which is the
		// whole saving; the suffix is the rewritten transcript.
		expect(server.calls[1]).toMatchObject({
			path: "/polykv/pools/pool-root/fork",
			body: { branch_pos: 12_859, tokens: [9, 9, 9] },
		});
		const paths = server.calls.map((c) => `${c.method} ${c.path}`);
		expect(paths).toContain("POST /polykv/pools/pool-fork/pin");
		expect(paths).toContain("DELETE /polykv/pools/pool-root");
		expect(paths.indexOf("POST /polykv/pools/pool-fork/pin")).toBeLessThan(
			paths.indexOf("DELETE /polykv/pools/pool-root"),
		);
	});

	// Reading the branch back off the fork would set it to the compacted suffix
	// and make the prefix unshareable one compaction later.
	it("keeps branching at the same prefix across repeated compactions", async () => {
		const server = engine({
			pools: [
				{ pool_id: "pool-root", prefix_len: 12_859 },
				{ pool_id: "pool-a", prefix_len: 40_000 },
				{ pool_id: "pool-b", prefix_len: 55_000 },
			],
		});
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: config,
			systemPrompt: "prompt",
		});
		await repointPolykvAfterCompaction({
			sessionId: "s1",
			providerConfig: config,
			compactedPrompt: "first",
		});
		server.calls.length = 0;
		await repointPolykvAfterCompaction({
			sessionId: "s1",
			providerConfig: config,
			compactedPrompt: "second",
		});

		expect(server.calls[1]).toMatchObject({
			path: "/polykv/pools/pool-a/fork",
			body: { branch_pos: 12_859 },
		});
		expect(getPolykvSession("s1")?.prefixTokens).toBe(12_859);
	});

	// The safe side of the failure: the old pool is still pinned and still
	// serving, and the conversation pays full prefill rather than stopping.
	it("stays on the old pool when the fork fails", async () => {
		const server = engine({ fail: "/fork" });
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: config,
			systemPrompt: "prompt",
		});

		const forked = await repointPolykvAfterCompaction({
			sessionId: "s1",
			providerConfig: config,
			compactedPrompt: "rewritten",
		});

		expect(forked).toBeUndefined();
		expect(getPolykvSession("s1")?.poolId).toBe("pool-root");
	});
});

describe("ending the session", () => {
	it("unpins before releasing, and forgets the session either way", async () => {
		const server = engine();
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: config,
			systemPrompt: "prompt",
		});
		server.calls.length = 0;

		await releasePolykvSession({ sessionId: "s1", providerConfig: config });

		expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
			"POST /polykv/pools/pool-root/pin",
			"DELETE /polykv/pools/pool-root",
		]);
		expect(server.calls[0].body).toEqual({ pinned: false });
		expect(getPolykvSession("s1")).toBeUndefined();
	});

	it("does nothing for a session that never had a pool", async () => {
		const server = engine();
		await releasePolykvSession({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
		});
		expect(server.calls).toHaveLength(0);
	});
});
