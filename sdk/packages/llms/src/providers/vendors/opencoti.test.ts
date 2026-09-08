import { describe, expect, it } from "vitest";
import {
	createOpencotiFetch,
	normalizeOpencotiBaseUrl,
	readOpencotiRequestOptions,
} from "./opencoti";
import { PolykvSaturatedError, polykvRoot } from "./polykv";

function ok(body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status: 200, headers });
}

describe("the opencoti request body", () => {
	// The pool is the whole point of this vendor: without these fields the
	// server prefills the shared prefix again on every turn, which is the cost
	// the pool tree exists to remove.
	it("carries the pool, the session and the prefix hint", async () => {
		let sent: Record<string, unknown> | undefined;
		const fetchImpl = createOpencotiFetch({
			fetch: (async (_input: unknown, init?: RequestInit) => {
				sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return ok({ choices: [] });
			}) as unknown as typeof fetch,
			request: {
				poolId: "pool-7",
				sessionId: "session-3",
				sharedPrefixTokens: 12_859,
				overcommit: true,
			},
		});

		await fetchImpl("http://localhost:8080/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [] }),
		});

		expect(sent).toMatchObject({
			model: "m",
			pool_id: "pool-7",
			session_id: "session-3",
			shared_prefix_n_tokens: 12_859,
			overcommit: true,
		});
	});

	// An unpooled request is slower; a mangled one is broken.
	it("leaves a body it cannot parse exactly as it was", async () => {
		let sent: BodyInit | null | undefined;
		const fetchImpl = createOpencotiFetch({
			fetch: (async (_input: unknown, init?: RequestInit) => {
				sent = init?.body;
				return ok({});
			}) as unknown as typeof fetch,
			request: { poolId: "pool-7" },
		});

		await fetchImpl("http://localhost:8080/v1/chat/completions", {
			method: "POST",
			body: "not json",
		});

		expect(sent).toBe("not json");
	});

	it("sends nothing extra when no pool was named", async () => {
		let sent: Record<string, unknown> | undefined;
		const fetchImpl = createOpencotiFetch({
			fetch: (async (_input: unknown, init?: RequestInit) => {
				sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return ok({});
			}) as unknown as typeof fetch,
			request: {},
		});

		await fetchImpl("http://localhost:8080/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m" }),
		});

		expect(sent).toEqual({ model: "m" });
	});
});

describe("when the engine declines the request", () => {
	// Saturation used to present as a stall that read like a network fault. It
	// is neither: the server said no, and said for how long.
	it("raises a saturation error carrying the retry delay", async () => {
		const fetchImpl = createOpencotiFetch({
			fetch: (async () =>
				new Response("", {
					status: 429,
					headers: { "retry-after": "12", "x-polykv-reason": "kv_exhausted" },
				})) as unknown as typeof fetch,
		});

		const error = await fetchImpl("http://localhost:8080/v1/chat/completions", {
			method: "POST",
			body: "{}",
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(PolykvSaturatedError);
		expect((error as PolykvSaturatedError).retryAfterMs).toBe(12_000);
		expect((error as PolykvSaturatedError).reason).toBe("kv_exhausted");
	});

	it("treats 503 the same way, with no delay when none was given", async () => {
		const fetchImpl = createOpencotiFetch({
			fetch: (async () =>
				new Response("", { status: 503 })) as unknown as typeof fetch,
		});

		const error = await fetchImpl("http://localhost:8080/v1/chat/completions", {
			method: "POST",
			body: "{}",
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(PolykvSaturatedError);
		expect((error as PolykvSaturatedError).retryAfterMs).toBeUndefined();
	});
});

describe("what the engine reports back", () => {
	it("reads the pool it served from and the prefix it did not prefill", async () => {
		const facts: Array<Record<string, unknown>> = [];
		const fetchImpl = createOpencotiFetch({
			fetch: (async () =>
				ok(
					{},
					{
						"x-pool-id": "pool-7",
						"x-cached-prefix-tokens": "12859",
						"x-session-tps": "41.5",
						"x-sessions-remaining": "0",
					},
				)) as unknown as typeof fetch,
			onFacts: (fact) => facts.push(fact as unknown as Record<string, unknown>),
		});

		await fetchImpl("http://localhost:8080/v1/chat/completions", {
			method: "POST",
			body: "{}",
		});

		expect(facts).toEqual([
			{
				poolId: "pool-7",
				cachedTokens: 12_859,
				sessionTps: 41.5,
				backpressure: true,
			},
		]);
	});

	it("says nothing when the response carries no pool headers", async () => {
		const facts: unknown[] = [];
		const fetchImpl = createOpencotiFetch({
			fetch: (async () => ok({})) as unknown as typeof fetch,
			onFacts: (fact) => facts.push(fact),
		});

		await fetchImpl("http://localhost:8080/v1/chat/completions", {
			method: "POST",
			body: "{}",
		});

		expect(facts).toHaveLength(0);
	});
});

describe("the two halves of the server's address", () => {
	// The chat endpoint lives under `/v1`; the pool tree does not.
	it("puts the chat endpoint under /v1 and the control plane at the root", () => {
		expect(normalizeOpencotiBaseUrl("http://host:8240")).toBe(
			"http://host:8240/v1",
		);
		expect(normalizeOpencotiBaseUrl("http://host:8240/")).toBe(
			"http://host:8240/v1",
		);
		expect(normalizeOpencotiBaseUrl("http://host:8240/v1")).toBe(
			"http://host:8240/v1",
		);
		expect(polykvRoot("http://host:8240/v1")).toBe("http://host:8240");
		expect(polykvRoot("http://host:8240/")).toBe("http://host:8240");
	});

	it("leaves an unset base URL unset", () => {
		expect(normalizeOpencotiBaseUrl(undefined)).toBeUndefined();
	});
});

describe("reading the per-request pool options", () => {
	it("takes only the values that are of the right shape", () => {
		const options = readOpencotiRequestOptions({
			config: {
				options: {
					polykvPoolId: "pool-7",
					polykvSessionId: "",
					polykvSharedPrefixTokens: "12859",
					polykvOvercommit: false,
				},
			},
		} as never);

		expect(options).toEqual({ poolId: "pool-7", overcommit: false });
	});

	it("is empty when the config holds none", () => {
		expect(readOpencotiRequestOptions({} as never)).toEqual({});
	});
});
