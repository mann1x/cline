import { describe, expect, it } from "vitest";
import {
	createOpencotiFetch,
	normalizeOpencotiBaseUrl,
	type OpencotiResponseFacts,
	readOpencotiRequestOptions,
} from "./opencoti";
import { polykvRoot } from "./polykv";

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
		let sent: RequestInit["body"];
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
	// These used to assert a throw from inside the fetch wrapper. That is what
	// kept the refusal away from the error classifier, so a server saying "come
	// back in 12 seconds" read as a transport fault and the turn was abandoned.
	// The refusal is now a response; `error-classification.ts` names it
	// `rate_limited`, and the retry belongs to the middleware that can wait.
	it("hands the refusal back with its retry interval intact", async () => {
		const fetchImpl = createOpencotiFetch({
			fetch: (async () =>
				new Response("", {
					status: 429,
					headers: { "retry-after": "12" },
				})) as unknown as typeof fetch,
		});

		const response = await fetchImpl(
			"http://localhost:8080/v1/chat/completions",
			{ method: "POST", body: "{}" },
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("12");
	});

	it("does not swallow a 503 either", async () => {
		const fetchImpl = createOpencotiFetch({
			fetch: (async () =>
				new Response("", { status: 503 })) as unknown as typeof fetch,
		});

		const response = await fetchImpl(
			"http://localhost:8080/v1/chat/completions",
			{ method: "POST", body: "{}" },
		);

		expect(response.status).toBe(503);
	});
});

describe("what the engine reports back", () => {
	// This used to assert `x-pool-id`, `x-cached-prefix-tokens` and
	// `x-session-tps`. The server sets none of them -- they were specified and
	// then deferred, since a header must go out before the body while the slot,
	// and so the tps, is assigned only after the task is queued. The test passed
	// because it supplied the headers itself; against a real server the callback
	// it exercises had never fired.
	it("reads the two headers the server actually sets", async () => {
		const facts: Array<Record<string, unknown>> = [];
		const fetchImpl = createOpencotiFetch({
			fetch: (async () =>
				ok(
					{},
					{
						"x-sessions-remaining": "3",
						"x-polykv-settle-waived": "4200",
					},
				)) as unknown as typeof fetch,
			onFacts: (fact) => facts.push(fact as unknown as Record<string, unknown>),
		});

		await fetchImpl("http://localhost:8080/v1/chat/completions", {
			method: "POST",
			body: "{}",
		});

		expect(facts).toEqual([{ sessionsRemaining: 3, settleWaivedMs: 4200 }]);
	});

	it("says nothing when the response carries neither", async () => {
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

describe("what the engine actually says back", () => {
	// The gate is `enforced` by default, so a refusal is routine. Thrown from
	// inside the fetch it never reaches the classifier, which is the layer that
	// knows a 429 is worth waiting out -- so it surfaced as a transport failure
	// and the turn died. Handing the response back lets it be classified.
	it("returns the refusal rather than throwing past the classifier", async () => {
		const fetchImpl = createOpencotiFetch({
			fetch: (async () =>
				new Response(
					JSON.stringify({
						error: {
							code: 503,
							type: "unavailable_error",
							message: "saturated",
						},
					}),
					{ status: 429, headers: { "retry-after": "2" } },
				)) as unknown as typeof fetch,
		});

		const response = await fetchImpl(
			"http://localhost:8080/v1/chat/completions",
			{
				method: "POST",
				body: JSON.stringify({ model: "m", messages: [] }),
			},
		);

		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("2");
	});

	// `X-Sessions-Remaining` is omitted when headroom is not computable, and on
	// c7 it can also be a wrong `0`. Reading absence -- or that `0` -- as "no
	// room left" invents backpressure the server never reported.
	it("does not invent backpressure from a header that is not there", async () => {
		let facts: OpencotiResponseFacts | undefined;
		const fetchImpl = createOpencotiFetch({
			fetch: (async () =>
				new Response(JSON.stringify({ choices: [] }), {
					status: 200,
				})) as unknown as typeof fetch,
			onFacts: (next) => {
				facts = next;
			},
		});

		await fetchImpl("http://localhost:8080/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [] }),
		});

		expect(facts?.sessionsRemaining).toBeUndefined();
	});

	// The one admit that is not evidence of room: the hold timed out and the
	// request went through on the clock, not on a measurement.
	it("reports a settling hold that was waived on a timer", async () => {
		let facts: OpencotiResponseFacts | undefined;
		const fetchImpl = createOpencotiFetch({
			fetch: (async () =>
				new Response(JSON.stringify({ choices: [] }), {
					status: 200,
					headers: {
						"x-polykv-settle-waived": "5000",
						"x-sessions-remaining": "3",
					},
				})) as unknown as typeof fetch,
			onFacts: (next) => {
				facts = next;
			},
		});

		await fetchImpl("http://localhost:8080/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [] }),
		});

		expect(facts).toMatchObject({ settleWaivedMs: 5000, sessionsRemaining: 3 });
	});
});
