import { beforeEach, describe, expect, it } from "vitest";
import {
	createPolykvClient,
	probeOpencotiProps,
	readOpencotiStatus,
	resetPolykvAvailability,
} from "./polykv";

/**
 * Route shapes, asserted verb-and-path exactly.
 *
 * This file exists because the client was written against the design document
 * rather than the engine, and every call in it type-checked and passed its own
 * tests while hitting a route the server does not register. The server's own
 * table (`server.cpp:458-462`) is five routes and no `DELETE`; the action set
 * (`server-context.cpp:12375-12449`) is `release|pin|unpin|fork|admission|
 * sampling`, dispatched on the path segment with the body never consulted for
 * which action it is.
 *
 * So these assert the literal string. A test that accepted "some POST to
 * something containing the pool id" would have passed on the broken client.
 */
function recordingFetch(): {
	calls: Array<{ method: string; path: string; body: unknown }>;
	fetch: typeof fetch;
} {
	const calls: Array<{ method: string; path: string; body: unknown }> = [];
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		calls.push({
			method: init?.method ?? "GET",
			path: new URL(String(input)).pathname,
			body:
				typeof init?.body === "string"
					? (JSON.parse(init.body) as unknown)
					: undefined,
		});
		return new Response(JSON.stringify({ pool_id: "p1", prefix_len: 10 }), {
			status: 200,
		});
	}) as unknown as typeof fetch;
	return { calls, fetch: fetchImpl };
}

describe("the PolyKV control plane", () => {
	it("releases with the action the server registers, not DELETE", async () => {
		// `DELETE /polykv/pools/{id}` is not a route. It 404s, the catch swallows
		// it, and the pool stays pinned for the life of the server.
		const { calls, fetch: fetchImpl } = recordingFetch();
		await createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: fetchImpl,
		}).releasePool("p1");

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/polykv/pools/p1/release",
		});
	});

	it("unpins through the unpin action, not a flag on pin", async () => {
		// The handler reads `task.polykv.pin = action == "pin"` and never looks
		// at the body, so posting `{pinned:false}` to `.../pin` pins it again --
		// the exact opposite of unpin-after-migrate.
		const { calls, fetch: fetchImpl } = recordingFetch();
		await createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: fetchImpl,
		}).unpin("p1");

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/polykv/pools/p1/unpin",
		});
	});

	it("creates a pool from a server-rendered prompt", async () => {
		// The alternative is tokenizing here and sending ids, which is the path
		// that made the prefix unmatchable: the server tokenizes a `prompt` with
		// the same BOS and special-token treatment a completion gets, and it is
		// the only side that knows what that treatment is.
		const { calls, fetch: fetchImpl } = recordingFetch();
		await createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: fetchImpl,
		}).createPool({ prompt: "<|im_start|>system\n", pin: true });

		expect(calls[0]).toMatchObject({ method: "POST", path: "/polykv/pools" });
		expect(calls[0].body).toEqual({
			prompt: "<|im_start|>system\n",
			pin: true,
		});
	});

	it("snapshots a live session without sending any tokens", async () => {
		// The whole point of `from_session`: the engine takes the prefix from the
		// slot's own token history, so a re-tokenization mismatch is not possible
		// on this path.
		const { calls, fetch: fetchImpl } = recordingFetch();
		await createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: fetchImpl,
		}).createPool({ from_session: "session-3", ephemeral: true });

		expect(calls[0].body).toEqual({
			from_session: "session-3",
			ephemeral: true,
		});
	});

	it("forks from a live session too", async () => {
		const { calls, fetch: fetchImpl } = recordingFetch();
		await createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: fetchImpl,
		}).forkPool("p1", { branch_pos: 10, from_session: "session-3" });

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/polykv/pools/p1/fork",
		});
		expect(calls[0].body).toEqual({
			branch_pos: 10,
			from_session: "session-3",
		});
	});

	it("pins through the pin action", async () => {
		const { calls, fetch: fetchImpl } = recordingFetch();
		await createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: fetchImpl,
		}).pin("p1");

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/polykv/pools/p1/pin",
		});
	});
});

describe("the /props probe", () => {
	// The probe answers once per server and caches it, which is the point of it;
	// these cases are four different servers wearing the same address.
	beforeEach(() => {
		resetPolykvAvailability();
	});

	function propsFetch(body: unknown, status = 200) {
		const paths: string[] = [];
		const fetchImpl = (async (input: unknown) => {
			paths.push(new URL(String(input)).pathname);
			return new Response(JSON.stringify(body), { status });
		}) as unknown as typeof fetch;
		return { paths, fetch: fetchImpl };
	}

	it("asks /props, not /polykv/pools", async () => {
		// `GET /polykv/pools` errors on a server booted without
		// `--polykv-max-pools`, which is the default -- so the probe that was
		// meant to detect "pools off" fails in a way indistinguishable from an
		// unreachable server. `/props` answers on every build.
		const { paths, fetch: fetchImpl } = propsFetch({
			build_info: "opencoti-0.10.5-c7-2609031229001",
			opencoti: { polykv: { pools_enabled: true } },
		});
		await probeOpencotiProps("http://localhost:8080/v1", fetchImpl);

		expect(paths).toEqual(["/props"]);
	});

	it("reads the release off build_info", async () => {
		// The c7/c8 split decides which signals are trustworthy, so it is read
		// once per server rather than inferred per call site.
		const { fetch: fetchImpl } = propsFetch({
			build_info: "opencoti-0.10.5-c7-2609031229001",
			opencoti: { polykv: { pools_enabled: true, max_pools: 4 } },
		});
		const props = await probeOpencotiProps(
			"http://localhost:8080/v1",
			fetchImpl,
		);

		expect(props).toMatchObject({
			release: "c7",
			poolsEnabled: true,
			elastic: false,
		});
	});

	it("sees elastic slots turned on", async () => {
		const { fetch: fetchImpl } = propsFetch({
			build_info: "opencoti-0.10.5-c7-2609031229001",
			opencoti: {
				polykv: { pools_enabled: false },
				elastic_slots: { enabled: true, slots_live: 1, slots_max: 4 },
			},
		});
		const props = await probeOpencotiProps(
			"http://localhost:8080/v1",
			fetchImpl,
		);

		expect(props).toMatchObject({ poolsEnabled: false, elastic: true });
	});

	it("answers 'not opencoti' for a server that will not say", async () => {
		// A plain llama.cpp server answers /props without an opencoti block, and
		// an unreachable one answers nothing. Both mean the fixed slot count,
		// which is the safe reading when the question cannot be asked.
		const { fetch: fetchImpl } = propsFetch({}, 500);
		const props = await probeOpencotiProps(
			"http://localhost:8080/v1",
			fetchImpl,
		);

		expect(props).toMatchObject({ poolsEnabled: false, elastic: false });
		expect(props.release).toBeUndefined();
	});
});

describe("the read-only status the panel shows", () => {
	beforeEach(resetPolykvAvailability);

	/** A server answering the three endpoints that are safe to read. */
	function statusServer(
		overrides: {
			props?: Record<string, unknown>;
			pools?: Record<string, unknown>;
			tps?: Record<string, unknown>;
		} = {},
	) {
		const paths: string[] = [];
		const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			paths.push(new URL(url).pathname);
			if (url.endsWith("/props")) {
				return new Response(
					JSON.stringify(
						overrides.props ?? {
							build_info: "opencoti-0.10.5-c7-2609031229001",
							opencoti: {
								polykv: { pools_enabled: true },
								elastic_slots: {
									enabled: true,
									slots_live: 3,
									slots_max: 8,
									reason: "saturated, hold",
									grows: 2,
									shrinks: 0,
									vram_free_mib: null,
									tps_floor: 1,
								},
							},
						},
					),
					{ status: 200 },
				);
			}
			if (url.endsWith("/polykv/pools")) {
				return new Response(
					JSON.stringify(
						overrides.pools ?? {
							pools_max: 4,
							tree_depth: 2,
							pools: [
								{
									pool_id: 0,
									parent: -1,
									prefix_len: 12_859,
									pinned: true,
									ephemeral: false,
									orphaned_pin: false,
									children: [1],
									source_session: "",
								},
								{
									pool_id: 1,
									parent: 0,
									branch_pos: 12_859,
									prefix_len: 20_000,
									pinned: false,
									ephemeral: true,
									orphaned_pin: true,
									children: [],
									source_session: "lead",
								},
							],
						},
					),
					{ status: 200 },
				);
			}
			if (url.endsWith("/polykv/tps")) {
				return new Response(
					JSON.stringify(
						overrides.tps ?? {
							sessions: [
								{
									slot_id: 0,
									session_id: "lead",
									pool_id: -1,
									tps_ewma: 41.2,
									active: true,
									ctx_used: 18_000,
									ctx_total: 32_768,
								},
								{
									slot_id: 1,
									session_id: "worker-1",
									pool_id: -1,
									tps_ewma: 0,
									active: true,
								},
							],
						},
					),
					{ status: 200 },
				);
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		return { fetchImpl, paths };
	}

	// The one endpoint the panel may never touch. On c7 every GET of it folds
	// the settle and bias EWMAs, so a strip that refreshed would corrupt the
	// admission projection it was drawing.
	it("never asks /capacity", async () => {
		const server = statusServer();
		await readOpencotiStatus("http://localhost:8080/v1", server.fetchImpl);
		expect(server.paths).toEqual(["/props", "/polykv/pools", "/polykv/tps"]);
	});

	it("reads the elastic state from /props, reason included", async () => {
		const server = statusServer();
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			server.fetchImpl,
		);
		expect(status.reachable).toBe(true);
		expect(status.release).toBe("c7");
		expect(status.slotsLive).toBe(3);
		expect(status.slotsMax).toBe(8);
		// Kept distinct from "kv headroom exhausted" by the engine on purpose:
		// one says raise --max-parallel, the other says this context does not
		// fit, and collapsing them throws that away.
		expect(status.elasticReason).toBe("saturated, hold");
	});

	// `vram_free_mib` is null, not 0, when the number would be a lie -- no GPU
	// layers, or integrated memory where the device reports host RAM. A reader
	// that sees 0 cannot tell "no headroom" from "no measurement".
	it("does not read an absent VRAM figure as zero", async () => {
		const server = statusServer();
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			server.fetchImpl,
		);
		expect(status.vramFreeMib).toBeUndefined();
	});

	it("lists the pool tree, including a pin nothing references", async () => {
		const server = statusServer();
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			server.fetchImpl,
		);
		expect(status.poolsMax).toBe(4);
		expect(status.pools).toHaveLength(2);
		expect(status.pools[0]).toMatchObject({
			poolId: "0",
			pinned: true,
			prefixLen: 12_859,
			children: 1,
		});
		// An orphaned pin blocks reclaim forever; it is the leak this whole
		// change set exists to stop, so the panel names it.
		expect(status.pools[1]).toMatchObject({
			poolId: "1",
			parent: "0",
			ephemeral: true,
			orphanedPin: true,
			sourceSession: "lead",
		});
	});

	// On c7 `/polykv/tps` reports `-1` as the pool key for every registry-pool
	// session, so it identifies nothing. The session id is the key that works.
	it("keys sessions by session id, not by the pool key c7 does not set", async () => {
		const server = statusServer();
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			server.fetchImpl,
		);
		expect(status.sessions.map((s) => s.sessionId)).toEqual([
			"lead",
			"worker-1",
		]);
		expect(status.sessions[0]).toMatchObject({ tps: 41.2, active: true });
		// Zero from a slot that is processing means the EWMA has not warmed,
		// not that the slot is producing nothing.
		expect(status.sessions[1]?.tps).toBeUndefined();
	});

	it("reports a server it cannot reach as unreachable rather than empty", async () => {
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			(async () => {
				throw new Error("ECONNREFUSED");
			}) as unknown as typeof fetch,
		);
		expect(status.reachable).toBe(false);
		expect(status.pools).toEqual([]);
	});

	// A server booted without `--polykv-max-pools` errors on the pool routes.
	// That is "pools off", which /props already said, and must not read as a
	// server that is down.
	it("stays reachable when the pool routes are not served", async () => {
		const server = statusServer({
			props: {
				build_info: "opencoti-0.10.5-c7-2609031229001",
				opencoti: { polykv: { pools_enabled: false, max_pools: 0 } },
			},
		});
		const status = await readOpencotiStatus("http://localhost:8080/v1", (async (
			input: Parameters<typeof fetch>[0],
		) => {
			if (String(input).endsWith("/polykv/pools")) {
				return new Response("pools disabled", { status: 501 });
			}
			return server.fetchImpl(input);
		}) as unknown as typeof fetch);
		expect(status.reachable).toBe(true);
		expect(status.poolsEnabled).toBe(false);
		expect(status.pools).toEqual([]);
	});
});

describe("what the engine actually puts on the wire", () => {
	beforeEach(resetPolykvAvailability);

	/** A server that answers exactly as the c7 binary was observed to. */
	function liveShapedServer() {
		const seen: Array<{ path: string; body?: unknown }> = [];
		const fetchImpl = (async (input: unknown, init?: RequestInit) => {
			const url = new URL(String(input));
			seen.push({
				path: url.pathname,
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
			});
			if (url.pathname === "/apply-template") {
				return Response.json({ prompt: "<|im_start|>system\nx<|im_end|>\n" });
			}
			// `pool_id` and `parent` are NUMBERS here, which is what the engine
			// sends -- and the first pool on a fresh server is id 0.
			return Response.json({
				pool_id: 0,
				parent: -1,
				branch_pos: 0,
				prefix_len: 38,
			});
		}) as unknown as typeof fetch;
		return { fetchImpl, seen };
	}

	// The first pool a fresh server hands out is id `0`, and the engine sends it
	// as a number. Left as one it is FALSY, so every `if (poolId)` on the way to
	// the request body drops it and the session silently stops attaching -- on
	// the one pool every first session gets.
	it("hands back pool ids as strings, so id 0 survives a truthiness check", async () => {
		const server = liveShapedServer();
		const client = createPolykvClient({
			baseUrl: "http://localhost:8247/v1",
			fetch: server.fetchImpl,
		});

		const pool = await client.createPool({ prompt: "x\n", pin: true });

		expect(pool.pool_id).toBe("0");
		expect(Boolean(pool.pool_id)).toBe(true);
		// `-1` is the engine's "no parent"; it must not read as pool "-1".
		expect(pool.parent).toBeUndefined();
	});

	it("does the same for a fork", async () => {
		const server = liveShapedServer();
		const client = createPolykvClient({
			baseUrl: "http://localhost:8247/v1",
			fetch: server.fetchImpl,
		});
		expect((await client.forkPool("0", { from_session: "s" })).pool_id).toBe(
			"0",
		);
	});

	// The release is NOT in `build_info` on the shipped binary -- measured as
	// `b1788384120-c588c4f47`, a build number and a commit. Anything that
	// branched on it would take the wrong branch on the one server it was
	// written for, silently.
	it("reports no release when the build does not stamp one", async () => {
		const status = await readOpencotiStatus("http://localhost:8247/v1", (async (
			input: Parameters<typeof fetch>[0],
		) => {
			if (String(input).endsWith("/props")) {
				return new Response(
					JSON.stringify({
						build_info: "b1788384120-c588c4f47",
						features: ["lock_v1", "slots_nonblocking_v1"],
						opencoti: { polykv: { pools_enabled: true } },
					}),
				);
			}
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch);
		expect(status.reachable).toBe(true);
		expect(status.release).toBeUndefined();
		expect(status.poolsEnabled).toBe(true);
	});

	// `/apply-template` appends the assistant generation header by default, so
	// the templated string ends `<|im_start|>assistant\n<think>`. A real request
	// has a USER turn at that position, so a pool built from it diverges from
	// every request that would attach to it -- measured on the c7 binary as
	// `n_pool_shared: 0` on an exact-looking prefix.
	it("asks the template engine not to append a generation prompt", async () => {
		const server = liveShapedServer();
		const client = createPolykvClient({
			baseUrl: "http://localhost:8247/v1",
			fetch: server.fetchImpl,
		});

		await client.applyTemplate({
			messages: [{ role: "system", content: "x" }],
		});

		const call = server.seen.find((entry) => entry.path === "/apply-template");
		expect(call?.body).toMatchObject({ add_generation_prompt: false });
	});
});
