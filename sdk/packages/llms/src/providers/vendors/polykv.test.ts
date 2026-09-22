import { beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * The c8 signal upgrades, each gated on the flag that carries it.
 *
 * The rule this file enforces is §4a's: **behaviour branches on `features`,
 * never on a parsed release.** The published binary stamps no `c<N>` anywhere
 * in `/props`, and the build that does carry one carries `-c7-` on the artifact
 * that ships the c8 behaviours -- so a version gate reads the wrong answer on
 * both. Every test below therefore drives the branch from `features` alone, and
 * the c7 arm is the one with an empty array.
 */
describe("signal upgrades behind their feature flags", () => {
	beforeEach(resetPolykvAvailability);

	function capacityServer(features: string[]) {
		const urls: string[] = [];
		const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("/props")) {
				return new Response(
					JSON.stringify({
						features,
						opencoti: {
							polykv: { pools_enabled: true },
							elastic_slots: { enabled: true },
						},
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/capacity")) {
				return new Response(
					JSON.stringify({
						can_admit: true,
						folded: url.includes("fold=1"),
						kv_headroom_pct: 62.5,
						kv_cells_free: 640_000,
						kv_cells_total: 1_048_576,
						swa_active: true,
						swa_cells_free: 4096,
						swa_cells_total: 8192,
						swa_window: 4096,
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/polykv/pools")) {
				return new Response(
					JSON.stringify({
						pools: [{ pool_id: 0, parent: -1, prefix_len: 9, children: [] }],
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/polykv/tps")) {
				return new Response(
					JSON.stringify({
						sessions: [
							{
								session_id: "lead",
								pool_id: 3,
								alloc_key: "alloc-7",
								tps_ewma: 20,
								active: true,
							},
						],
					}),
					{ status: 200 },
				);
			}
			return new Response("{}", { status: 404 });
		}) as unknown as typeof fetch;
		return { fetchImpl, urls };
	}

	// On c7 the fold is what the GET *does*; on c8 it is what `?fold=1` asks
	// for. Asking for it on a server that does not know the parameter is
	// harmless -- it folds either way -- but asserting the echo is how a caller
	// learns which of the two it is talking to.
	it("asks for the fold explicitly and reads the echo back", async () => {
		const server = capacityServer(["capacity_readonly_v1"]);
		const client = createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: server.fetchImpl,
		});
		const capacity = await client.capacity("0", {
			expected_tokens: 500,
			fold: true,
		});
		expect(server.urls.at(-1)).toContain("fold=1");
		expect(server.urls.at(-1)).toContain("expected_tokens=500");
		expect(capacity.folded).toBe(true);
	});

	it("does not ask for the fold when it is only reading", async () => {
		const server = capacityServer(["capacity_readonly_v1"]);
		const client = createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: server.fetchImpl,
		});
		const capacity = await client.capacity("0");
		expect(server.urls.at(-1)).not.toContain("fold");
		expect(capacity.folded).toBe(false);
	});

	// The c7 guarantee, restated as a branch rather than an absolute: the panel
	// may read /capacity only once the server says the plain GET is read-only.
	it("leaves /capacity alone on a server that has not said it is read-only", async () => {
		const server = capacityServer([]);
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			server.fetchImpl,
		);
		expect(server.urls.some((url) => url.includes("/capacity"))).toBe(false);
		expect(status.kvHeadroomPct).toBeUndefined();
	});

	it("reads the headroom and the SWA arm once the GET is read-only", async () => {
		const server = capacityServer(["capacity_readonly_v1"]);
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			server.fetchImpl,
		);
		const capacityUrl = server.urls.find((url) => url.includes("/capacity"));
		expect(capacityUrl).toBeDefined();
		// Read-only means read-only: the panel must not fold on a poll.
		expect(capacityUrl).not.toContain("fold");
		expect(status.kvHeadroomPct).toBe(62.5);
		expect(status.kvCellsFree).toBe(640_000);
		expect(status.swaActive).toBe(true);
		expect(status.swaCellsFree).toBe(4096);
	});

	// c7 reports `-1` as the pool key for every registry pool, so grouping by it
	// collapses every session into one. c8 reports the real binding, plus an
	// `alloc_key` that survives the session being moved to another slot by
	// elastic growth.
	it("takes the real pool key only when the server says it sets one", async () => {
		const c7 = capacityServer([]);
		const before = await readOpencotiStatus(
			"http://localhost:8080/v1",
			c7.fetchImpl,
		);
		expect(before.sessions[0]?.poolId).toBeUndefined();
		expect(before.sessions[0]?.allocKey).toBeUndefined();

		resetPolykvAvailability();
		const c8 = capacityServer(["tps_real_pool_id_v1"]);
		const after = await readOpencotiStatus(
			"http://localhost:8081/v1",
			c8.fetchImpl,
		);
		expect(after.sessions[0]?.poolId).toBe("3");
		expect(after.sessions[0]?.allocKey).toBe("alloc-7");
	});
});

/**
 * A 503 and a 429 are different conditions, and the client used to raise the
 * same error for both.
 *
 * `429` is the admission gate pacing you: the server has told you when to come
 * back and waiting works. `503` is `--polykv-adm-on-error deny` -- the capacity
 * check itself failed, so the server does not know whether it has room and is
 * refusing rather than guessing. Retrying that on a timer is the wrong move;
 * it needs surfacing, because nothing about waiting fixes it.
 */
describe("telling pacing apart from a failed capacity check", () => {
	function refusingServer(status: number, body: unknown, retryAfter?: string) {
		return (async () =>
			new Response(JSON.stringify(body), {
				status,
				headers: retryAfter ? { "retry-after": retryAfter } : {},
			})) as unknown as typeof fetch;
	}

	it("reads a 429 as pacing, with the server's own delay", async () => {
		const client = createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: refusingServer(429, { reason: "kv headroom exhausted" }, "2"),
		});
		await expect(client.capacity("0")).rejects.toMatchObject({
			name: "PolykvSaturatedError",
			status: 429,
			retryAfterMs: 2000,
			capacityCheckFailed: false,
		});
	});

	it("reads a 503 as a failed capacity check, not as pacing", async () => {
		const client = createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: refusingServer(503, { reason: "capacity check failed" }),
		});
		await expect(client.capacity("0")).rejects.toMatchObject({
			name: "PolykvSaturatedError",
			status: 503,
			capacityCheckFailed: true,
		});
	});

	// c7's refusal carries a body saying `503`/`unavailable_error` on a `429`
	// status line. The status is the half that is right on both releases, so a
	// client that classified on the body would call every c7 refusal a failed
	// capacity check and stop retrying the one thing retrying fixes.
	it("classifies c7's lying body by its status line", async () => {
		const client = createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: refusingServer(
				429,
				{
					error: { code: 503, type: "unavailable_error" },
					reason: "saturated",
				},
				"1",
			),
		});
		await expect(client.capacity("0")).rejects.toMatchObject({
			status: 429,
			capacityCheckFailed: false,
		});
	});
});

/**
 * `GET /kv` is the server-wide account; `/capacity` is a pool's view of it.
 *
 * Under guarantees those are no longer the same number. A pool owned by a
 * session reports `kv_cells_total`, `kv_cells_free` and `kv_headroom_pct`
 * against **the owner's window**, not against the server -- so a panel reading
 * them off the first pool it finds and calling the result "KV headroom" states
 * one session's private occupancy as the machine's free capacity. It is wrong
 * in the most misleading direction available: a full server with one idle
 * session reads as nearly empty.
 *
 * `pressure_scope` is the field that says which it is, and `/kv` is the source
 * that never needs asking.
 */
describe("the server-wide KV account", () => {
	beforeEach(resetPolykvAvailability);

	function kvServer(features: string[], capacityScope?: string) {
		const urls: string[] = [];
		const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input);
			urls.push(url);
			if (url.includes("/props")) {
				return new Response(
					JSON.stringify({
						features,
						opencoti: {
							polykv: { pools_enabled: true },
							elastic_slots: { enabled: true, slots_live: 4, slots_max: 64 },
						},
					}),
					{ status: 200 },
				);
			}
			if (url.endsWith("/kv")) {
				return new Response(
					JSON.stringify({
						guaranteed: true,
						cells_total: 1_048_576,
						cells_free: 786_432,
						cells_used: 262_144,
						largest_admissible: 262_144,
						session_ctx_max: 262_144,
						pools_max_per_slot: 8,
						alloc_ttl_s: 300,
						swa: { cells_total: 131_072, cells_free: 131_072, window: 1024 },
						allocations: [
							{
								session_id: "lead",
								window: 262_144,
								used: 131_072,
								free: 131_072,
								pressure: 0.5,
								pools: 3,
							},
						],
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/capacity")) {
				return new Response(
					JSON.stringify({
						can_admit: true,
						kv_headroom_pct: 12.5,
						kv_cells_free: 8192,
						kv_cells_total: 65_536,
						window_cells: 65_536,
						pressure: 0.875,
						...(capacityScope ? { pressure_scope: capacityScope } : {}),
						...(capacityScope === "session" ? { owner: "lead" } : {}),
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/polykv/pools")) {
				return new Response(
					JSON.stringify({
						pools: [{ pool_id: 0, parent: -1, prefix_len: 9, children: [] }],
					}),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify({ sessions: [] }), { status: 200 });
		}) as unknown as typeof fetch;
		return { fetchImpl, urls };
	}

	it("takes the server-wide figures from /kv, not from a pool", async () => {
		const server = kvServer(["kv_status_v1", "capacity_readonly_v1"]);
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			server.fetchImpl,
		);
		expect(status.kvScope).toBe("server");
		expect(status.kvCellsFree).toBe(786_432);
		expect(status.kvCellsTotal).toBe(1_048_576);
		expect(status.largestAdmissible).toBe(262_144);
		expect(status.guaranteed).toBe(true);
		// The SWA ring comes from the same snapshot.
		expect(status.swaCellsFree).toBe(131_072);
	});

	// One read, not two. `/kv` answers everything `/capacity` was being asked
	// for and needs no pool to address.
	it("stops asking a pool once /kv can answer", async () => {
		const server = kvServer(["kv_status_v1", "capacity_readonly_v1"]);
		await readOpencotiStatus("http://localhost:8080/v1", server.fetchImpl);
		expect(server.urls.some((url) => url.includes("/capacity"))).toBe(false);
	});

	it("reports each session's own window and its raw pressure", async () => {
		const server = kvServer(["kv_status_v1"]);
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			server.fetchImpl,
		);
		expect(status.allocations).toEqual([
			{
				sessionId: "lead",
				window: 262_144,
				used: 131_072,
				free: 131_072,
				pressure: 0.5,
				pools: 3,
			},
		]);
	});

	// The fallback, on a server with the read-only GET but no /kv. An unowned
	// pool's view IS the server's, so it may be reported as such.
	it("still reads a pool when /kv is not offered, and says it is server-wide", async () => {
		const server = kvServer(["capacity_readonly_v1"], "unallocated");
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			server.fetchImpl,
		);
		expect(status.kvScope).toBe("server");
		expect(status.kvCellsFree).toBe(8192);
	});

	// The defect this describes: the same fields, scoped to one session's
	// window. Reported, but never as the server's.
	it("never calls one session's window the server's headroom", async () => {
		const server = kvServer(["capacity_readonly_v1"], "session");
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			server.fetchImpl,
		);
		expect(status.kvScope).toBe("session");
		expect(status.kvScopeOwner).toBe("lead");
		expect(status.kvCellsFree).toBe(8192);
	});

	// A server that predates `pressure_scope` has no per-session windows to
	// confuse them with, so its unscoped answer is server-wide by construction.
	it("reads an unscoped answer from an older build as server-wide", async () => {
		const server = kvServer(["capacity_readonly_v1"]);
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			server.fetchImpl,
		);
		expect(status.kvScope).toBe("server");
	});
});

/**
 * Closing a session gives its window back.
 *
 * Without this the server holds the whole booked allocation for the idle TTL --
 * five minutes on the build this was written against -- so a user who ends one
 * 256k conversation and starts another waits out their own first session. The
 * TTL is the crash net, not the mechanism.
 *
 * The verb matters more here than it looks. This client's founding bug was
 * `releasePool` calling a `DELETE` the server does not register: the 404 landed
 * in a catch that read as "released", and every session leaked its pool while
 * the code looked correct. So the route is asserted literally.
 */
describe("closing a session", () => {
	function closer(body: unknown) {
		const calls: Array<{ method: string; path: string }> = [];
		const fetchImpl = (async (input: unknown, init?: RequestInit) => {
			calls.push({
				method: init?.method ?? "GET",
				path: new URL(String(input)).pathname,
			});
			return new Response(JSON.stringify(body), { status: 200 });
		}) as unknown as typeof fetch;
		return { calls, fetchImpl };
	}

	it("posts to the close action the server registers", async () => {
		const server = closer({ session_id: "lead", found: true });
		const client = createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: server.fetchImpl,
		});
		expect(await client.closeSession("lead")).toBe(true);
		expect(server.calls).toEqual([
			{ method: "POST", path: "/sessions/lead/close" },
		]);
	});

	// `200` is not the answer. The server answers `200 {"found": false}` for a
	// session it never held, so a caller that checked the status would record a
	// close that released nothing -- and would keep doing it while the window
	// it meant to free stayed booked until its TTL.
	it("reads `found`, not the status, as whether anything was released", async () => {
		const server = closer({ session_id: "lead", found: false });
		const client = createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: server.fetchImpl,
		});
		expect(await client.closeSession("lead")).toBe(false);
	});

	it("escapes an id that would otherwise change the path", async () => {
		const server = closer({ found: true });
		const client = createPolykvClient({
			baseUrl: "http://localhost:8080/v1",
			fetch: server.fetchImpl,
		});
		await client.closeSession("a/b");
		expect(server.calls[0]?.path).toBe("/sessions/a%2Fb/close");
	});
});

/**
 * A read that answers its headers and never ends its body.
 *
 * Measured on bs2, 2026-09-22, on two different ports so it is the engine and
 * not a proxy in front of it: `GET /polykv/tps` returns `200` and then never
 * finishes. Every read in this file was unbounded, so `readOpencotiStatus`
 * simply never resolved -- and it is what the settings panel asks to decide
 * whether Parallel Sessions is elastic. The visible symptom was the field
 * offering "Default: 1" on a server whose admission gate was on.
 *
 * `/props` is the worse one: it is read at session start to resolve the slot
 * limit, so the same hang stalls a session rather than a panel.
 */
describe("a read that never ends", () => {
	beforeEach(() => {
		resetPolykvAvailability();
	});

	const PROPS = {
		build_info: "opencoti-0.10.5-c7-2609031229001",
		features: [],
		opencoti: {
			polykv: { pools_enabled: false },
			elastic_slots: { enabled: true, slots_live: 2, slots_max: 8 },
		},
	};

	/**
	 * A server that answers everything except one path, where it sends the
	 * headers and then stops -- the measured shape. The stub ignores the abort
	 * signal on purpose: a `fetch` that honours it would prove only that
	 * `AbortSignal` works, and the hang has to be survivable without that.
	 */
	function hangsOn(path: string, bodies: Record<string, unknown> = {}) {
		const aborted: string[] = [];
		const fetchImpl = (async (input: unknown, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === path) {
				init?.signal?.addEventListener("abort", () =>
					aborted.push(url.pathname),
				);
				return {
					ok: true,
					status: 200,
					json: () => new Promise<never>(() => {}),
				} as unknown as Response;
			}
			const body =
				url.pathname === "/props" ? PROPS : (bodies[url.pathname] ?? {});
			return new Response(JSON.stringify(body), { status: 200 });
		}) as unknown as typeof fetch;
		return { aborted, fetch: fetchImpl };
	}

	it("gives up on /polykv/tps and reports everything else", async () => {
		vi.useFakeTimers();
		try {
			const server = hangsOn("/polykv/tps");
			const pending = readOpencotiStatus(
				"http://localhost:8080/v1",
				server.fetch,
			);
			await vi.advanceTimersByTimeAsync(6_000);
			const status = await pending;

			// The panel's actual question. Before the bound it never got an
			// answer at all, and rendered the "could not be asked" placeholder.
			expect(status.reachable).toBe(true);
			expect(status.elastic).toBe(true);
			expect(status.release).toBe("c7");
			// The one thing that did not answer is the one thing that is empty.
			expect(status.sessions).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cancels the request it gave up on", async () => {
		vi.useFakeTimers();
		try {
			const server = hangsOn("/polykv/tps");
			const pending = readOpencotiStatus(
				"http://localhost:8080/v1",
				server.fetch,
			);
			await vi.advanceTimersByTimeAsync(6_000);
			await pending;

			// Abandoning the promise would leave the socket open for the life of
			// the process, once per poll.
			expect(server.aborted).toEqual(["/polykv/tps"]);
		} finally {
			vi.useRealTimers();
		}
	});

	// This one is on the session-start path through `probeOpencotiProps`, so an
	// unbounded read here stalls a session rather than a panel.
	it("gives up on /props and answers 'not opencoti'", async () => {
		vi.useFakeTimers();
		try {
			const server = hangsOn("/props");
			const pending = probeOpencotiProps(
				"http://localhost:8080/v1",
				server.fetch,
			);
			await vi.advanceTimersByTimeAsync(6_000);
			const props = await pending;

			// The same reading an unreachable server gets: the fixed slot count
			// is what you use when the question cannot be asked.
			expect(props).toMatchObject({ poolsEnabled: false, elastic: false });
			expect(props.release).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not bound a server that answers", async () => {
		// The bound must not truncate a slow-but-alive read into a wrong
		// "unreachable" -- the whole point is that a healthy answer is orders of
		// magnitude inside it.
		const server = hangsOn("/nothing");
		const status = await readOpencotiStatus(
			"http://localhost:8080/v1",
			server.fetch,
		);
		expect(status.reachable).toBe(true);
		expect(server.aborted).toEqual([]);
	});
});
