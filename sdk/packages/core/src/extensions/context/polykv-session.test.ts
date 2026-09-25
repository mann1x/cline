import {
	getPolykvGrantedWindow,
	getPolykvSession,
	preparePolykvWorker,
	recordPolykvGrantedWindow,
	releaseAllPolykvSwarms,
	releasePolykvAgent,
	resetPolykvAvailability,
	resetPolykvSessions,
	setPolykvSession,
} from "@cline/llms";
import { markPromptEnvironment } from "@cline/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearPolykvAllocationCache,
	clearPolykvCapacityCache,
	endAtTokenBoundary,
	ensurePolykvPool,
	isPolykvProvider,
	polykvSaysCompact,
	readPolykvAllocation,
	readPolykvCapacity,
	releasePolykvPool,
	releasePolykvSession,
	renderPolykvPrefixMessages,
	repointPolykvAfterCompaction,
	resolveGrantedContextWindow,
	snapshotPolykvSession,
} from "./polykv-session";

/** A stand-in engine that records what the control plane was asked for. */
function engine(
	overrides: {
		tokenize?: number[];
		pools?: Array<{ pool_id: string; prefix_len: number }>;
		capacity?: Record<string, unknown>;
		templated?: string;
		fail?: string;
		features?: string[];
		sessionHeld?: boolean;
		allocations?: Array<Record<string, unknown>>;
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
		if (url.pathname === "/apply-template") {
			return Response.json({
				prompt:
					overrides.templated ??
					"<|im_start|>system\nYou are Cline.<|im_end|>\n",
			});
		}
		if (url.pathname === "/tokenize") {
			return Response.json({ tokens: overrides.tokenize ?? [1, 2, 3] });
		}
		if (url.pathname.endsWith("/capacity")) {
			return Response.json(
				overrides.capacity ?? { can_admit: true, compaction_pressure: 0.1 },
			);
		}
		// Every action the server actually registers, answered as itself. These
		// used to fall through to the create branch and hand back a pool, which
		// would let a client calling a route that does not exist look healthy.
		if (
			url.pathname.endsWith("/pin") ||
			url.pathname.endsWith("/unpin") ||
			url.pathname.endsWith("/release")
		) {
			return new Response(null, { status: 204 });
		}
		if (url.pathname === "/kv") {
			return Response.json({ allocations: overrides.allocations ?? [] });
		}
		if (url.pathname === "/props") {
			return Response.json({
				features: overrides.features ?? [],
				opencoti: { polykv: { pools_enabled: true } },
			});
		}
		// `found` is the answer, not the status: the server replies 200 with
		// `found: false` for a session it never held.
		if (url.pathname.endsWith("/close")) {
			return Response.json({ found: overrides.sessionHeld !== false });
		}
		if (init?.method === "DELETE") {
			// There is no DELETE route on this server. Say so.
			return new Response("not found", { status: 404 });
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
	clearPolykvAllocationCache();
	// The `/props` probe is cached per server root, and every case here uses
	// the same one. Left standing, the first test's feature list decides what
	// every later test believes the server can do.
	resetPolykvAvailability();
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
	// Handed to the server as a chat body, because the order and the framing are
	// the template's decision, not ours -- which is the whole correction here.
	it("is the system prompt and the tools, for the template to render", () => {
		expect(
			renderPolykvPrefixMessages({
				systemPrompt: "You are Cline.",
				tools: [
					{
						name: "editor",
						description: "edits a file",
						inputSchema: { type: "object" },
					},
				],
			}),
		).toEqual({
			messages: [{ role: "system", content: "You are Cline." }],
			tools: [
				{
					type: "function",
					function: {
						name: "editor",
						description: "edits a file",
						parameters: { type: "object" },
					},
				},
			],
		});
	});

	// Measured on pandorum 2026-09-18: every `/apply-template` answered
	// `500 Failed to parse tools: Missing tool type` on the `skills` tool, so
	// the prefix was never rendered and the whole session ran unpooled with
	// nothing but one warn line to say so. The runtime's own tool shape is
	// `{name, description, inputSchema}`; the engine parses OpenAI's.
	it("gives every tool the type the engine parses", () => {
		const rendered = renderPolykvPrefixMessages({
			systemPrompt: "You are Cline.",
			tools: [
				{ name: "skills", inputSchema: { type: "object" } },
				{
					type: "function",
					function: { name: "already_shaped", parameters: {} },
				},
			],
		});

		expect(rendered?.tools).toEqual([
			{
				type: "function",
				function: {
					name: "skills",
					description: "",
					parameters: { type: "object" },
				},
			},
			{
				type: "function",
				function: { name: "already_shaped", parameters: {} },
			},
		]);
	});

	// A tool with no name cannot be rendered and cannot be described. Sending
	// it costs the pool; dropping it costs one tool's schema off a prefix that
	// is a cache key, not the request.
	it("drops a tool it cannot name rather than losing the pool", () => {
		expect(
			renderPolykvPrefixMessages({
				systemPrompt: "You are Cline.",
				tools: [{ description: "nameless" }],
			}),
		).toEqual({ messages: [{ role: "system", content: "You are Cline." }] });
	});

	it("is nothing when there is nothing stable to pin", () => {
		expect(renderPolykvPrefixMessages({})).toBeUndefined();
	});

	it("ends the prefix at a token boundary", () => {
		// A trailing space merges with the next word into one token, and the
		// contiguous-prefix check then 400s the fork.
		expect(endAtTokenBoundary("system block ")).toBe("system block\n");
		expect(endAtTokenBoundary("already ended\n")).toBe("already ended\n");
	});
});

/**
 * A pool with no owner is charged to nobody -- and a worker attaching to it
 * still books a guaranteed window of its own.
 *
 * Measured live on 8240 (2026-09-22): a 12-worker swarm against a lead with a
 * 65,536-token window produced THIRTEEN allocations of 65,536, 82% of the
 * server's million cells, because every pool this client creates was unowned.
 * The engine prices a request that attaches to a pool owned by a session as a
 * worker OF that session: it books nothing server-wide and is priced against
 * the owner's free window, which is the whole of the sub-pool arrangement.
 */
describe("who owns the pools", () => {
	it("names the session as the owner of its root pool", async () => {
		const server = engine();
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
			systemPrompt: "You are Cline.",
			tools: [],
		});

		expect(
			server.calls.find((call) => call.path === "/polykv/pools")?.body,
		).toMatchObject({
			session_id: "s1",
		});
	});

	it("names it on the fork a compaction re-roots onto", async () => {
		const server = engine();
		setPolykvSession("s1", { poolId: "pool-root", prefixTokens: 12_859 });
		await repointPolykvAfterCompaction({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
			compactedPrompt: "a summary of the conversation so far",
		});

		const fork = server.calls.find((call) => call.path.endsWith("/fork"));
		expect(fork?.body).toMatchObject({ session_id: "s1" });
	});

	it("names it on the swarm snapshot, which from_session would otherwise imply", async () => {
		const server = engine();
		setPolykvSession("s1", { poolId: "pool-root", prefixTokens: 12_859 });
		await snapshotPolykvSession({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
		});

		expect(
			server.calls.find((call) => call.path === "/polykv/pools")?.body,
		).toMatchObject({
			from_session: "s1",
			session_id: "s1",
		});
	});
});

describe("pinning the session's root pool", () => {
	it("templates the prefix, creates the pool pinned, and remembers it", async () => {
		const server = engine();
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
		expect(server.calls[0].path).toBe("/apply-template");
		expect(server.calls[1]).toMatchObject({
			method: "POST",
			path: "/polykv/pools",
			body: {
				prompt: "<|im_start|>system\nYou are Cline.<|im_end|>\n",
				pin: true,
			},
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

	// On c7 every `GET /capacity` FOLDS the settle and bias EWMAs -- it is not a
	// read, it advances the learner. The compaction check runs once a turn and
	// an admission decision runs once a round, so without a bound here the two
	// of them roughly double the fold rate the engine's own gate produces, and
	// then act on the answer they skewed.
	it("folds the engine's learner no more than once in its own window", async () => {
		clearPolykvCapacityCache();
		const server = engine({
			capacity: { can_admit: true, compaction_pressure: 0.5 },
		});
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: config,
			systemPrompt: "prompt",
		});
		const before = server.calls.length;

		const first = await readPolykvCapacity({
			sessionId: "s1",
			providerConfig: config,
		});
		const second = await readPolykvCapacity({
			sessionId: "s1",
			providerConfig: config,
		});

		expect(server.calls.length - before).toBe(1);
		// The second caller gets the first caller's answer, not nothing.
		expect(second).toEqual(first);
	});

	// A sibling session's pool is a different learner; sharing one answer
	// between them would report the wrong pool's room.
	it("bounds each session's reads separately", async () => {
		clearPolykvCapacityCache();
		const server = engine({
			capacity: { can_admit: true, compaction_pressure: 0.5 },
		});
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: config,
			systemPrompt: "prompt",
		});
		await ensurePolykvPool({
			sessionId: "s2",
			providerConfig: config,
			systemPrompt: "prompt",
		});
		const before = server.calls.length;

		await readPolykvCapacity({ sessionId: "s1", providerConfig: config });
		await readPolykvCapacity({ sessionId: "s2", providerConfig: config });

		expect(server.calls.length - before).toBe(2);
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
	// A swarm worker attached to the lead's snapshot: the pool is the lead's,
	// and every other worker of the round is on it.
	it("never forks or releases a pool the session only borrows", async () => {
		const server = engine({ features: ["session_close_v1"] });
		const config = provider(server.fetch);
		setPolykvSession("lead~worker", {
			poolId: "lead-pool",
			prefixTokens: 0,
			layout: "borrowed",
		});

		const forked = await repointPolykvAfterCompaction({
			sessionId: "lead~worker",
			providerConfig: config,
			compactedPrompt: "the summary",
		});
		expect(forked).toBeUndefined();
		expect(getPolykvSession("lead~worker")?.poolId).toBe("lead-pool");

		await releasePolykvSession({
			sessionId: "lead~worker",
			providerConfig: config,
		});
		const paths = server.calls.map((c) => `${c.method} ${c.path}`);
		expect(paths.filter((p) => p.includes("lead-pool"))).toEqual([]);
		// Its own session is still closed: that window is the worker's.
		expect(paths).toContain("POST /sessions/lead~worker/close");
	});

	it("forks at the shared prefix, migrates, then releases the old pool", async () => {
		const server = engine();
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
		// whole saving. The child itself comes from the live session, because the
		// body a fork takes is the FULL child path, not the rewritten tail.
		expect(server.calls[0]).toMatchObject({
			path: "/polykv/pools/pool-root/fork",
			body: { branch_pos: 12_859, from_session: "s1" },
		});
		const paths = server.calls.map((c) => `${c.method} ${c.path}`);
		expect(paths).toContain("POST /polykv/pools/pool-fork/pin");
		expect(paths).toContain("POST /polykv/pools/pool-root/release");
		expect(paths.indexOf("POST /polykv/pools/pool-fork/pin")).toBeLessThan(
			paths.indexOf("POST /polykv/pools/pool-root/release"),
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

		expect(server.calls[0]).toMatchObject({
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

		// Both are real actions on the server's own table. `pin` with a flag in
		// the body is not an unpin -- the handler dispatches on the path segment
		// and never reads the body -- and there is no DELETE route at all.
		expect(
			server.calls
				.map((c) => `${c.method} ${c.path}`)
				.filter((c) => !c.endsWith("/props")),
		).toEqual([
			"POST /polykv/pools/pool-root/unpin",
			"POST /polykv/pools/pool-root/release",
		]);
		expect(getPolykvSession("s1")).toBeUndefined();
	});

	it("does nothing for a session that never had a pool", async () => {
		const server = engine();
		await releasePolykvSession({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
		});
		// `/props` is the flag probe and is cached per root; it is a read, not
		// an action, so it does not count as doing something.
		expect(server.calls.filter((c) => c.path !== "/props")).toHaveLength(0);
	});

	// A session can hold a booked WINDOW without holding a pool -- pooling off,
	// or a window asked for before a pool was ever built. Gating the close on
	// pool state would leak exactly those, and they are the expensive ones:
	// the whole allocation stays booked until the idle TTL.
	it("closes a session that booked a window but never built a pool", async () => {
		const server = engine({ features: ["session_close_v1"] });
		await releasePolykvSession({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
		});
		expect(server.calls.map((c) => `${c.method} ${c.path}`)).toContain(
			"POST /sessions/s1/close",
		);
	});

	// "Use PolyKV agents as Priority 0": agents may be sub-pools of this very
	// session. Closing it releases their pools, and the engine then prefills a
	// worker naming a released pool in full rather than refusing it (opencoti,
	// mail 269). The close waits for the last of them.
	it("closes a lead only after its last priority-0 agent ends", async () => {
		const server = engine({ features: ["session_close_v1"] });
		const config = provider(server.fetch);
		try {
			await preparePolykvWorker({
				spec: { group: "s1", sessionId: "s1~agent-1", layers: 0, owner: "s1" },
				baseUrl: config.baseUrl,
				fetch: server.fetch,
				body: {
					messages: [
						{ role: "system", content: "s" },
						{ role: "user", content: "t" },
					],
				},
			});

			await releasePolykvSession({ sessionId: "s1", providerConfig: config });
			const closes = () =>
				server.calls
					.map((c) => `${c.method} ${c.path}`)
					.filter((c) => c === "POST /sessions/s1/close");
			expect(closes()).toEqual([]);

			await releasePolykvAgent("s1~agent-1");
			expect(closes()).toEqual(["POST /sessions/s1/close"]);
		} finally {
			await releaseAllPolykvSwarms();
		}
	});

	it("closes the session after releasing its pool, not instead", async () => {
		const server = engine({ features: ["session_close_v1"] });
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: config,
			systemPrompt: "prompt",
		});
		server.calls.length = 0;

		await releasePolykvSession({ sessionId: "s1", providerConfig: config });

		expect(
			server.calls
				.map((c) => `${c.method} ${c.path}`)
				.filter((c) => !c.endsWith("/props")),
		).toEqual([
			"POST /polykv/pools/pool-root/unpin",
			"POST /polykv/pools/pool-root/release",
			"POST /sessions/s1/close",
		]);
	});

	// An older server has no such route, and a 404 landing in a catch that
	// reads as "closed" is this module's founding bug wearing a new hat.
	it("does not call a close route the server never advertised", async () => {
		const server = engine();
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: config,
			systemPrompt: "prompt",
		});
		server.calls.length = 0;

		await releasePolykvSession({ sessionId: "s1", providerConfig: config });

		expect(server.calls.some((c) => c.path.endsWith("/close"))).toBe(false);
	});
});

describe("the prefix goes through the server's template", () => {
	// The fault this covers: the pool used to be built from the raw system
	// prompt plus `JSON.stringify(tools)`, while the engine prefills what its
	// chat template produced. Those are different token sequences, so the pool
	// was created, pinned, attached -- and shared nothing, on every turn, with
	// no error anywhere. Only the server knows which template it loaded.
	it("renders through /apply-template and pins what comes back", async () => {
		const server = engine({
			templated: "<|im_start|>system\nYou are Cline.<|im_end|>\n",
		});
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
			systemPrompt: "You are Cline.",
			tools: [{ name: "editor" }],
		});

		expect(server.calls[0]).toMatchObject({
			method: "POST",
			path: "/apply-template",
		});
		expect(server.calls[1]).toMatchObject({
			method: "POST",
			path: "/polykv/pools",
			body: {
				prompt: "<|im_start|>system\nYou are Cline.<|im_end|>\n",
				pin: true,
			},
		});
	});

	it("sends the tools to the template, not a JSON dump of them", async () => {
		// A template renders tool schemas its own way -- inside the system block,
		// as a separate turn, or not at all. Stringifying them here guesses.
		const server = engine();
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
			systemPrompt: "You are Cline.",
			tools: [{ name: "editor" }],
		});

		expect(server.calls[0].body).toMatchObject({
			messages: [{ role: "system", content: "You are Cline." }],
			// Shaped on the way out, because the engine's tool parser refuses
			// anything without a `type` -- see "gives every tool the type the
			// engine parses" above.
			tools: [{ type: "function", function: { name: "editor" } }],
		});
	});

	it("does not send a prompt that ends mid-token", async () => {
		// A prefix ending in a trailing space merges with the next word into one
		// token and the contract check 400s the fork. Pools end at a newline.
		const server = engine({ templated: "<|im_start|>system\nYou are Cline. " });
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
			systemPrompt: "You are Cline.",
		});

		const created = server.calls.find((call) => call.path === "/polykv/pools")
			?.body as { prompt?: string };
		expect(created.prompt?.endsWith("\n")).toBe(true);
	});
});

describe("re-rooting after a compaction", () => {
	// The engine validates the child's prefix token-exact against the parent
	// over `[0, branch_pos)` and answers 400 on a mismatch. The old code sent
	// the compacted text alone -- a suffix -- so every fork was rejected and the
	// catch reported "staying on pool X", which reads as a server that does not
	// support it rather than a request that is malformed.
	it("snapshots the live session rather than re-sending tokens", async () => {
		const server = engine();
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
			systemPrompt: "You are Cline.",
		});
		server.calls.length = 0;

		const poolId = await repointPolykvAfterCompaction({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
			compactedPrompt: "a summary of what happened",
		});

		expect(poolId).toBe("pool-fork");
		const fork = server.calls.find((call) => call.path.endsWith("/fork"));
		expect(fork).toMatchObject({
			method: "POST",
			body: { branch_pos: 12_859, from_session: "s1" },
		});
		// Never a bare suffix: that is the 400.
		expect((fork?.body as { tokens?: unknown }).tokens).toBeUndefined();
	});

	it("releases the old pool through the actions that exist", async () => {
		const server = engine();
		await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
			systemPrompt: "You are Cline.",
		});
		server.calls.length = 0;

		await repointPolykvAfterCompaction({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
			compactedPrompt: "a summary",
		});

		const paths = server.calls.map((call) => call.path);
		expect(paths).toContain("/polykv/pools/pool-root/unpin");
		expect(paths).toContain("/polykv/pools/pool-root/release");
	});
});

describe("the PolyKV switch", () => {
	// Off unless explicitly off: a profile written before the section existed
	// carries no `enabled`, and reading that as "disabled" would silently take
	// pooling away from every session that already had it.
	it("pools when the section says nothing", () => {
		expect(
			isPolykvProvider({ providerId: "opencoti", baseUrl: "http://h/v1" }),
		).toBe(true);
	});

	it("stands down when the section is switched off", () => {
		expect(
			isPolykvProvider({
				providerId: "opencoti",
				baseUrl: "http://h/v1",
				polykv: { enabled: false },
			}),
		).toBe(false);
	});

	it("creates no pool at all when pooling is off", async () => {
		const server = engine();
		const poolId = await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: {
				...provider(server.fetch),
				polykv: { enabled: false },
			},
			systemPrompt: "You are Cline.",
		});

		expect(poolId).toBeUndefined();
		expect(server.calls).toHaveLength(0);
	});
});

describe("when the engine says it is time to compact", () => {
	it("uses the profile's threshold over the built-in one", () => {
		// The built-in is 0.85. A profile that says 0.5 wants to compact earlier
		// than that, and reading the constant regardless would ignore it.
		expect(
			polykvSaysCompact({ can_admit: true, compaction_pressure: 0.6 }, 0.5),
		).toBe(true);
		expect(
			polykvSaysCompact({ can_admit: true, compaction_pressure: 0.6 }),
		).toBe(false);
	});

	it("still ignores a pool that is still settling", () => {
		// Pressure measured mid-settle describes a state the pool is leaving.
		expect(
			polykvSaysCompact(
				{ can_admit: true, compaction_pressure: 0.99, settling: true },
				0.5,
			),
		).toBe(false);
	});
});

describe("snapshotting the lead's live context for a swarm", () => {
	it("takes the prefix server-side, and never sends tokens", async () => {
		clearPolykvCapacityCache();
		const server = engine();
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "lead",
			providerConfig: config,
			systemPrompt: "prompt",
		});
		const before = server.calls.length;

		const snapshot = await snapshotPolykvSession({
			sessionId: "lead",
			providerConfig: config,
		});

		expect(snapshot?.poolId).toBeDefined();
		const created = server.calls.slice(before).at(-1);
		expect(created?.method).toBe("POST");
		expect(created?.path).toBe("/polykv/pools");
		// `from_session` is the whole point: the engine takes the prefix from
		// the slot's own token history, so the failure class where a
		// re-tokenised prefix does not match the prefilled one cannot arise.
		expect(created?.body).toMatchObject({
			from_session: "lead",
			ephemeral: true,
		});
		expect(created?.body).not.toHaveProperty("tokens");
		expect(created?.body).not.toHaveProperty("prompt");
	});

	// Ephemeral so the engine's 60-second sweep can reclaim it if this process
	// dies mid-round; the explicit release below is still the plan.
	it("says nothing rather than throwing when the engine will not snapshot", async () => {
		const server = engine({ fail: "/polykv/pools" });
		expect(
			await snapshotPolykvSession({
				sessionId: "lead2",
				providerConfig: provider(server.fetch),
			}),
		).toBeUndefined();
	});

	it("unpins before releasing, because a pin blocks reclaim forever", async () => {
		const server = engine();
		const config = provider(server.fetch);
		const before = server.calls.length;

		await releasePolykvPool({ poolId: "pool-7", providerConfig: config });

		expect(
			server.calls.slice(before).map((call) => `${call.method} ${call.path}`),
		).toEqual([
			"POST /polykv/pools/pool-7/unpin",
			"POST /polykv/pools/pool-7/release",
		]);
	});
});

/**
 * A `from_session` snapshot fails often, and on a busy server it fails a lot.
 *
 * Measured by the engine's own soak against the shipped bytes: **331 of 715**
 * `from_session` creates answered `400`. The reason is correct behaviour, not a
 * fault — the snapshot is taken from the cache still resident in that session's
 * LAST slot, and if the slot has since been bound to someone else the session
 * has no affinity left. Refusing is right: the alternative is building this
 * session's pool out of another session's context. The rate rises exactly when
 * a swarm is most useful, because it tracks how hard the slots are churning.
 *
 * Returning nothing there costs the whole point of the round: the workers run
 * unpooled and each re-prefills the lead's entire context. The session's own
 * root pool is still pinned and still holds the system prompt and the tool
 * schemas — about a third of the window by measurement — so borrowing it shares
 * most of what matters and needs nothing that is not already there.
 */
describe("snapshotting a session whose slot has moved on", () => {
	it("borrows the session's root pool when the engine refuses the snapshot", async () => {
		// `fail: "/polykv/pools"` would also refuse the root create, so the
		// pool is built first and only the snapshot is made to fail.
		const server = engine();
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "lead",
			providerConfig: config,
			systemPrompt: "prompt",
		});
		const refusing = provider((async (input: unknown, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/polykv/pools" && init?.method === "POST") {
				return new Response("no slot affinity for session lead", {
					status: 400,
				});
			}
			return server.fetch(input as never, init);
		}) as unknown as typeof fetch);

		const snapshot = await snapshotPolykvSession({
			sessionId: "lead",
			providerConfig: refusing,
		});

		expect(snapshot?.poolId).toBe("pool-root");
		expect(snapshot?.borrowed).toBe(true);
	});

	// The trap this exists to close. A borrowed pool is the LEAD's, pinned and
	// serving the conversation. Releasing it at the end of a swarm round would
	// unpin and drop the prefix the lead is still using, so the next turn pays
	// full prefill and the pool tree loses its root — a much worse outcome than
	// the unpooled round this fallback was meant to avoid.
	it("marks the borrowed pool so the round cannot release it", async () => {
		const server = engine();
		const config = provider(server.fetch);
		await ensurePolykvPool({
			sessionId: "lead",
			providerConfig: config,
			systemPrompt: "prompt",
		});
		const refusing = provider((async (input: unknown, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/polykv/pools" && init?.method === "POST") {
				return new Response("nope", { status: 400 });
			}
			return server.fetch(input as never, init);
		}) as unknown as typeof fetch);

		const snapshot = await snapshotPolykvSession({
			sessionId: "lead",
			providerConfig: refusing,
		});

		// A real snapshot is this session's to drop; a borrowed one never is.
		expect(snapshot?.borrowed).toBe(true);
		expect(getPolykvSession("lead")?.poolId).toBe("pool-root");
	});

	it("says nothing when there is no pool to borrow either", async () => {
		const refusing = provider(
			(async () =>
				new Response("nope", { status: 400 })) as unknown as typeof fetch,
		);

		const snapshot = await snapshotPolykvSession({
			sessionId: "lead",
			providerConfig: refusing,
		});

		expect(snapshot).toBeUndefined();
	});

	// A successful snapshot is owned, and saying so is what lets the caller
	// release it. Without the flag every round would have to guess.
	it("marks a real snapshot as owned", async () => {
		const server = engine();
		const snapshot = await snapshotPolykvSession({
			sessionId: "lead",
			providerConfig: provider(server.fetch),
		});

		expect(snapshot?.borrowed).toBeFalsy();
	});
});

describe("a lead conversation in the server-wide lead tree", () => {
	// The vendor's fetch attaches such a conversation on the wire; a root of
	// its own here would be the private copy the lead tree exists to share.
	it("builds no pool of its own for a prompt carrying environment spans", async () => {
		const server = engine();
		const pool = await ensurePolykvPool({
			sessionId: "s1",
			providerConfig: provider(server.fetch),
			systemPrompt: `static${markPromptEnvironment("Date", "today")}`,
		});
		expect(pool).toBeUndefined();
		expect(server.calls.filter((c) => c.path !== "/props")).toHaveLength(0);
	});

	// Its pool may be the root every other conversation attaches to.
	it("neither re-roots nor releases a lead pool by id", async () => {
		const server = engine({ features: ["session_close_v1"] });
		const config = provider(server.fetch);
		setPolykvSession("s1", { poolId: "7", prefixTokens: 0, layout: "lead" });
		expect(
			await repointPolykvAfterCompaction({
				sessionId: "s1",
				providerConfig: config,
				compactedPrompt: "summary",
			}),
		).toBeUndefined();
		await releasePolykvSession({ sessionId: "s1", providerConfig: config });
		const actions = server.calls
			.map((c) => `${c.method} ${c.path}`)
			.filter((c) => !c.endsWith("/props"));
		expect(actions).toEqual(["POST /sessions/s1/close"]);
		expect(getPolykvSession("s1")).toBeUndefined();
	});

	it("closes the id the wire carried", async () => {
		const server = engine({ features: ["session_close_v1"] });
		await releasePolykvSession({
			sessionId: "lead/one",
			providerConfig: provider(server.fetch),
		});
		expect(server.calls.map((c) => c.path)).toContain(
			"/sessions/lead~one/close",
		);
	});
});

/**
 * P4, ruled: the trigger is the RAW `used/window` ratio, compared against the
 * threshold the user set. `compaction_pressure` is a 0.70..1.0 ramp over the
 * same denominator and is read only where no raw figure is stated.
 */
describe("the pressure that decides a compaction", () => {
	it("takes the session's raw pressure from /kv over the pool's ramp", () => {
		// The ramp reads 0.99 of a window that is 60% used: acting on it
		// compacts a conversation with 40% of its room left.
		expect(
			polykvSaysCompact({ can_admit: true, compaction_pressure: 0.99 }, 0.85, {
				pressure: 0.6,
			}),
		).toBe(false);
		expect(polykvSaysCompact(undefined, 0.85, { pressure: 0.9 })).toBe(true);
	});

	it("takes the pool's raw pressure over its ramp", () => {
		expect(
			polykvSaysCompact(
				{ can_admit: true, pressure: 0.5, compaction_pressure: 0.95 },
				0.85,
			),
		).toBe(false);
	});

	it("falls back to the ramp only where no raw figure is stated", () => {
		expect(
			polykvSaysCompact({ can_admit: true, compaction_pressure: 0.95 }, 0.85),
		).toBe(true);
	});

	it("reads this session's row of /kv, by the id the wire carried", async () => {
		const stub = engine({
			features: ["kv_status_v1"],
			allocations: [
				{ session_id: "other", window: 65_536, used: 60_000, pressure: 0.92 },
				{ session_id: "a~b", window: 65_536, used: 32_768, pressure: 0.5 },
			],
		});
		const row = await readPolykvAllocation({
			sessionId: "a/b",
			providerConfig: provider(stub.fetch),
		});
		expect(row?.pressure).toBe(0.5);
	});

	it("asks nothing of a server that does not offer /kv", async () => {
		const stub = engine({ features: [] });
		const row = await readPolykvAllocation({
			sessionId: "conv",
			providerConfig: provider(stub.fetch),
		});
		expect(row).toBeUndefined();
		expect(stub.calls.some((call) => call.path === "/kv")).toBe(false);
	});

	it("reads /kv no more than once in the capacity window", async () => {
		const stub = engine({
			features: ["kv_status_v1"],
			allocations: [{ session_id: "conv", window: 65_536, used: 1 }],
		});
		for (let turn = 0; turn < 3; turn++) {
			await readPolykvAllocation({
				sessionId: "conv",
				providerConfig: provider(stub.fetch),
			});
		}
		expect(stub.calls.filter((call) => call.path === "/kv")).toHaveLength(1);
	});
});

/**
 * A delegated agent on a PolyKV node reads the `/kv` row of the booking it
 * actually lives in: the owner it is charged to when its turns are pooled,
 * its own session's row when they are not. It read none: every worker was
 * turned away before the read.
 */
describe("a delegated agent's pressure", () => {
	const workerConfig = (fetchImpl: typeof fetch, owner?: string) => ({
		...provider(fetchImpl),
		polykvWorker: {
			group: "s1",
			layers: 0,
			...(owner ? { owner } : {}),
			attachOnly: true,
		},
	});

	it("reads the owner's row for a worker charged to it", async () => {
		const server = engine({
			features: ["kv_status_v1"],
			allocations: [
				{ session_id: "s1", window: 131_072, used: 118_000, pressure: 0.9 },
				{ session_id: "s1~agent-1", window: 4_096, used: 40, pressure: 0.01 },
			],
		});
		// The layer must be a prefix of the request's rendering to be pooled:
		// render what was sent rather than one fixed prompt.
		const rendering = (async (input: unknown, init?: RequestInit) => {
			if (new URL(String(input)).pathname === "/apply-template") {
				const body = JSON.parse(String(init?.body)) as {
					messages: Array<{ role: string; content: string }>;
				};
				return Response.json({
					prompt: body.messages
						.map((m) => `<|${m.role}|>${m.content}<|end|>`)
						.join(""),
				});
			}
			return server.fetch(input as never, init);
		}) as unknown as typeof fetch;
		try {
			const attach = await preparePolykvWorker({
				spec: { group: "s1", sessionId: "s1/agent-1", layers: 0, owner: "s1" },
				baseUrl: "http://localhost:8080/v1",
				fetch: rendering,
				body: {
					messages: [
						{ role: "system", content: "s" },
						{ role: "user", content: "t" },
					],
				},
			});
			expect(attach.poolId).toBeDefined();
			const row = await readPolykvAllocation({
				sessionId: "s1/agent-1",
				providerConfig: workerConfig(server.fetch, "s1"),
			});
			expect(row?.sessionId).toBe("s1");
			expect(polykvSaysCompact(undefined, 0.85, row)).toBe(true);
		} finally {
			await releaseAllPolykvSwarms();
		}
	});

	it("reads its own row for a worker whose turns go out unpooled", async () => {
		const server = engine({
			features: ["kv_status_v1"],
			allocations: [
				{ session_id: "s1", window: 131_072, used: 1_000, pressure: 0.01 },
				{
					session_id: "s1~agent-2",
					window: 65_536,
					used: 60_000,
					pressure: 0.92,
				},
			],
		});
		const row = await readPolykvAllocation({
			sessionId: "s1/agent-2",
			providerConfig: workerConfig(server.fetch),
		});
		expect(row?.sessionId).toBe("s1~agent-2");
		expect(row?.pressure).toBe(0.92);
	});
});

describe("the window compaction sizes against", () => {
	it("is the granted window when it is smaller than the configured one", () => {
		recordPolykvGrantedWindow("conv", 163_840, { asked: 262_144 });
		expect(resolveGrantedContextWindow("conv", "opencoti", 262_144)).toBe(
			163_840,
		);
	});

	// A private budget books the window minus the shared prefix; the prefix
	// still fills the window, so the conversation can use both.
	it("counts a shared prefix riding above a private budget", () => {
		recordPolykvGrantedWindow("conv", 150_000, {
			asked: 150_000,
			sharedTokens: 10_000,
		});
		expect(resolveGrantedContextWindow("conv", "opencoti", 262_144)).toBe(
			160_000,
		);
	});

	it("is the configured one when nothing smaller was granted", () => {
		expect(resolveGrantedContextWindow("conv", "opencoti", 262_144)).toBe(
			undefined,
		);
		recordPolykvGrantedWindow("conv", 262_144);
		expect(resolveGrantedContextWindow("conv", "opencoti", 262_144)).toBe(
			undefined,
		);
	});

	it("belongs to opencoti alone", () => {
		recordPolykvGrantedWindow("conv", 163_840);
		expect(resolveGrantedContextWindow("conv", "ollama", 262_144)).toBe(
			undefined,
		);
	});
});

describe("closing a session that booked a window", () => {
	// The resume rule: the cells go back, the window the conversation was
	// opened with does not change. A turn after the close asks for it again.
	it("keeps the granted window for the conversation's next turn", async () => {
		const stub = engine({ features: ["session_close_v1"] });
		recordPolykvGrantedWindow("conv", 163_840);
		await releasePolykvSession({
			sessionId: "conv",
			providerConfig: provider(stub.fetch),
		});
		expect(getPolykvGrantedWindow("conv")).toBe(163_840);
	});
});
