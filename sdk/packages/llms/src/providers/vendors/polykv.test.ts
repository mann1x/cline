import { beforeEach, describe, expect, it } from "vitest";
import {
	createPolykvClient,
	probeOpencotiProps,
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
