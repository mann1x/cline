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

/**
 * Whether the pool attached is the one fact about a pooled turn worth having,
 * and until `attach_in_response_v1` it was not on the response at all.
 *
 * The number that matters is `n_pool_shared`. A pool named on the request and
 * `0` shared tokens back is the silent degradation this whole vendor exists to
 * prevent: the turn succeeds, the answer is right, and the prefix was prefilled
 * from scratch anyway. It is indistinguishable from a working attach from
 * anywhere else in the client, which is why it is read here.
 */
describe("reading the attach off the response", () => {
	function facts(response: Response, body = '{"messages":[]}') {
		const seen: OpencotiResponseFacts[] = [];
		const fetchImpl = createOpencotiFetch({
			fetch: (async () => response) as unknown as typeof fetch,
			onFacts: (f) => seen.push(f),
		});
		return {
			seen,
			run: () =>
				fetchImpl("http://x/v1/chat/completions", { body, method: "POST" }),
		};
	}

	it("takes the pool and the shared count off a plain JSON turn", async () => {
		const probe = facts(
			ok({ choices: [], opencoti: { pool_id: 4, n_pool_shared: 12_859 } }),
		);
		await probe.run();
		expect(probe.seen.at(-1)).toMatchObject({
			poolId: "4",
			poolSharedTokens: 12_859,
		});
	});

	// Pool id `0` is the first pool on a fresh server, and it arrives as a
	// NUMBER. Left as one it is falsy, and every `if (poolId)` downstream drops
	// it -- the same trap the control plane's own reader exists to close.
	it("keeps pool 0, which is falsy as a number", async () => {
		const probe = facts(
			ok({ choices: [], opencoti: { pool_id: 0, n_pool_shared: 900 } }),
		);
		await probe.run();
		expect(probe.seen.at(-1)?.poolId).toBe("0");
	});

	// The degraded attach. Reported, not dropped: zero shared tokens is a fact
	// about the turn, and an absent field is the server not saying.
	it("reports a pool that shared nothing rather than staying quiet", async () => {
		const probe = facts(
			ok({ choices: [], opencoti: { pool_id: 2, n_pool_shared: 0 } }),
		);
		await probe.run();
		expect(probe.seen.at(-1)?.poolSharedTokens).toBe(0);
	});

	// Cline streams, so a read that only worked on a buffered response would be
	// dead on arrival -- the shape the previous header-based path failed in.
	it("finds it on the last frame of a stream", async () => {
		const stream = [
			'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
			'data: {"choices":[],"opencoti":{"pool_id":7,"n_pool_shared":4096}}\n\n',
			"data: [DONE]\n\n",
		].join("");
		const probe = facts(
			new Response(stream, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
		);
		const response = await probe.run();
		// The body must still arrive intact: this is a pass-through, not a tap
		// that consumes what it read.
		expect(await response.text()).toBe(stream);
		expect(probe.seen.at(-1)).toMatchObject({
			poolId: "7",
			poolSharedTokens: 4096,
		});
	});

	it("says nothing about a pool on a server that does not report one", async () => {
		const probe = facts(ok({ choices: [] }));
		await probe.run();
		expect(probe.seen.at(-1)?.poolId).toBeUndefined();
	});
});
