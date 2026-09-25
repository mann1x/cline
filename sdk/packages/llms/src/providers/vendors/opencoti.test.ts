import { beforeEach, describe, expect, it } from "vitest";
import {
	createOpencotiFetch,
	normalizeOpencotiBaseUrl,
	type OpencotiResponseFacts,
	readOpencotiRequestOptions,
} from "./opencoti";
import { OpencotiWindowUnavailableError } from "./opencoti-window";
import {
	clearPolykvGrantedWindow,
	getPolykvGrantedWindow,
	getPolykvWindowGrant,
	getPolykvWindowObservation,
	polykvRoot,
	recordPolykvGrantedWindow,
	resetPolykvAvailability,
	resetPolykvSessions,
} from "./polykv";

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
				poolId: "7",
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
			pool_id: 7,
			session_id: "session-3",
			shared_prefix_n_tokens: 12_859,
			overcommit: true,
		});
	});

	// Pool ids are held as strings on this side, because the first pool on a
	// fresh server is 0 and a numeric 0 is falsy. The engine parses the body
	// field as a number and 400s a string -- measured live on 8240: "Field
	// 'pool_id': type must be number, but is string", on the very first turn.
	it("sends the pool id as the number the engine parses, 0 included", async () => {
		const sent: Array<Record<string, unknown>> = [];
		for (const poolId of ["0", "12"]) {
			const fetchImpl = createOpencotiFetch({
				fetch: (async (_input: unknown, init?: RequestInit) => {
					sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
					return ok({ choices: [] });
				}) as unknown as typeof fetch,
				request: { poolId },
			});
			await fetchImpl("http://localhost:8080/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify({ model: "m", messages: [] }),
			});
		}

		expect(sent.map((body) => body.pool_id)).toEqual([0, 12]);
	});

	// Not an id the engine could have issued. Sending it would fail the turn;
	// leaving it off costs only the prefix share.
	it("leaves off a pool id that is not a number", async () => {
		let sent: Record<string, unknown> | undefined;
		const fetchImpl = createOpencotiFetch({
			fetch: (async (_input: unknown, init?: RequestInit) => {
				sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return ok({ choices: [] });
			}) as unknown as typeof fetch,
			request: { poolId: "pool-7", sessionId: "s" },
		});
		await fetchImpl("http://localhost:8080/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [] }),
		});

		expect(sent).not.toHaveProperty("pool_id");
		expect(sent?.session_id).toBe("s");
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

/**
 * Booking a window, and the floor that makes a smaller one acceptable.
 *
 * `num_ctx` asks for a guaranteed allocation. `num_ctx_min` is the floor below
 * which a smaller window is worse than no connection at all, and the server
 * settles the two in ONE admission: the largest window in the band, or a 429.
 *
 * Doing it server-side is not a convenience. The client-side version -- read
 * `largest_admissible` off the refusal, then retry at that -- has a race, since
 * another arrival can take the cells between the read and the retry. One
 * request has no gap to lose.
 */
describe("asking for a window", () => {
	beforeEach(() => {
		resetPolykvAvailability();
		resetPolykvSessions();
	});

	async function sent(
		request: Record<string, unknown>,
		features: string[] = [GUARANTEED, ATOMIC],
	) {
		const engine = windowEngine({ features, replies: [ok({ choices: [] })] });
		const fetchImpl = createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: "http://x/v1",
			request,
		});
		await fetchImpl("http://x/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		return engine.chats[0];
	}

	it("puts the window and its floor at the body root", async () => {
		const body = await sent({ numCtx: 262_144, numCtxMin: 65_536 });
		expect(body?.num_ctx).toBe(262_144);
		expect(body?.num_ctx_min).toBe(65_536);
	});

	// A floor with nothing to be a floor under says nothing. Sent alone it
	// would read as a demand for a minimum window on a request that never
	// asked for one.
	it("sends no floor when no window was asked for", async () => {
		const body = await sent({ numCtxMin: 65_536 });
		expect(body).not.toHaveProperty("num_ctx_min");
		expect(body).not.toHaveProperty("num_ctx");
	});

	// A floor above the ask is a contradiction, and the resolution is the one
	// that means something: exactly this window or refuse. That is also the
	// resume rule's shape, so it is the right way to be wrong.
	it("clamps a floor above the ask down to the ask", async () => {
		const body = await sent({ numCtx: 65_536, numCtxMin: 262_144 });
		expect(body?.num_ctx_min).toBe(65_536);
	});

	it("leaves both out when the user stated no window", async () => {
		const body = await sent({ sessionId: "s" });
		expect(body).not.toHaveProperty("num_ctx");
	});

	// K: a server that does not book windows makes no promise about one, so
	// nothing is asked of it.
	it("books nothing on a server without guaranteed allocations", async () => {
		const body = await sent({ numCtx: 262_144, numCtxMin: 65_536 }, [ATOMIC]);
		expect(body).not.toHaveProperty("num_ctx");
		expect(body).not.toHaveProperty("num_ctx_min");
	});

	// A: without the flag the field is not ours to send; the floor is applied
	// to the refusal on this side instead.
	it("keeps the floor to itself where the server cannot negotiate it", async () => {
		const body = await sent({ numCtx: 262_144, numCtxMin: 65_536 }, [
			GUARANTEED,
		]);
		expect(body?.num_ctx).toBe(262_144);
		expect(body).not.toHaveProperty("num_ctx_min");
	});

	it("asks a resume for exactly its window, floored at itself", async () => {
		const body = await sent({
			numCtx: 163_840,
			numCtxMin: 163_840,
			resume: true,
		});
		expect(body?.num_ctx).toBe(163_840);
		expect(body?.num_ctx_min).toBe(163_840);
	});
});

const GUARANTEED = "elastic_guaranteed_alloc_v1";
const ATOMIC = "ctx_min_negotiation_v1";

/**
 * A stub opencoti: `/props` names the features, and the chat route answers
 * from a script, one reply per request, recording every body it was sent.
 */
function windowEngine(options: { features: string[]; replies: Response[] }) {
	const chats: Array<Record<string, unknown>> = [];
	const replies = [...options.replies];
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		if (url.pathname === "/props") {
			return ok({ features: options.features });
		}
		chats.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
		const reply = replies.shift();
		if (!reply) {
			throw new Error("the script ran out of replies");
		}
		return reply;
	}) as unknown as typeof fetch;
	return { chats, fetch: fetchImpl };
}

/** A window refusal: 429 naming what would have fit. */
function refused(
	largest: number | undefined,
	options: { retryAfter?: string; inHeader?: boolean } = {},
): Response {
	return new Response(
		JSON.stringify({
			error: {
				code: 503,
				message: "no room",
				...(largest !== undefined && !options.inHeader
					? { largest_admissible: largest }
					: {}),
			},
		}),
		{
			status: 429,
			headers: {
				...(options.retryAfter ? { "retry-after": options.retryAfter } : {}),
				...(largest !== undefined && options.inHeader
					? { "x-context-largest-admissible": String(largest) }
					: {}),
			},
		},
	);
}

/**
 * The negotiation, PLANS §9c and the §9k rulings.
 *
 * A new session negotiates down to its floor and, below it, waits ONCE and
 * asks again before it is refused. A resume never negotiates and never waits.
 */
describe("negotiating a window the server cannot give", () => {
	beforeEach(() => {
		resetPolykvAvailability();
		resetPolykvSessions();
	});

	function negotiate(
		request: Record<string, unknown>,
		features: string[],
		replies: Response[],
	) {
		const engine = windowEngine({ features, replies });
		const waits: number[] = [];
		const fetchImpl = createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: "http://x/v1",
			request: { sessionId: "conv", ...request },
			sleep: async (ms) => {
				waits.push(ms);
			},
		});
		return {
			engine,
			waits,
			run: () =>
				fetchImpl("http://x/v1/chat/completions", {
					method: "POST",
					body: JSON.stringify({ model: "m", messages: [] }),
				}),
		};
	}

	it("retries once at largest_admissible when it clears the floor", async () => {
		const probe = negotiate(
			{ numCtx: 262_144, numCtxMin: 65_536 },
			[GUARANTEED],
			[
				refused(163_840, { inHeader: true }),
				ok({ choices: [] }, { "x-context-window": "163840" }),
			],
		);
		const response = await probe.run();
		expect(response.status).toBe(200);
		expect(probe.engine.chats.map((body) => body.num_ctx)).toEqual([
			262_144, 163_840,
		]);
		expect(probe.waits).toEqual([]);
		// The ask is the conversation's, not the retry's: "asked 256k, got 160k".
		expect(getPolykvWindowGrant("conv")).toEqual({
			granted: 163_840,
			asked: 262_144,
		});
	});

	it("reads largest_admissible off the body as well as the header", async () => {
		const probe = negotiate(
			{ numCtx: 262_144, numCtxMin: 65_536 },
			[GUARANTEED],
			[refused(131_072), ok({ choices: [] })],
		);
		await probe.run();
		expect(probe.engine.chats[1]?.num_ctx).toBe(131_072);
	});

	// §9k: a new session below its floor waits once, honouring Retry-After.
	it("waits once for a new session below its floor, then asks again", async () => {
		const probe = negotiate(
			{ numCtx: 262_144, numCtxMin: 131_072 },
			[GUARANTEED, ATOMIC],
			[
				refused(65_536, { retryAfter: "3" }),
				ok({ choices: [] }, { "x-context-window": "262144" }),
			],
		);
		const response = await probe.run();
		expect(response.status).toBe(200);
		expect(probe.waits).toEqual([3_000]);
		// The re-ask is the original ask, floor and all, not a smaller one.
		expect(probe.engine.chats[1]).toMatchObject({
			num_ctx: 262_144,
			num_ctx_min: 131_072,
		});
	});

	it("bounds that wait by maxRetryAfterMs", async () => {
		const probe = negotiate(
			{ numCtx: 262_144, numCtxMin: 131_072, maxRetryAfterMs: 1_500 },
			[GUARANTEED, ATOMIC],
			[refused(65_536, { retryAfter: "60" }), ok({ choices: [] })],
		);
		await probe.run();
		expect(probe.waits).toEqual([1_500]);
	});

	it("refuses a new session still below its floor after the one wait", async () => {
		const probe = negotiate(
			{ numCtx: 262_144, numCtxMin: 131_072 },
			[GUARANTEED, ATOMIC],
			[refused(65_536), refused(98_304)],
		);
		const error = await probe.run().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OpencotiWindowUnavailableError);
		expect((error as OpencotiWindowUnavailableError).details).toEqual({
			asked: 262_144,
			floor: 131_072,
			largestAdmissible: 98_304,
			resume: false,
		});
		expect(probe.waits).toHaveLength(1);
		expect(probe.engine.chats).toHaveLength(2);
	});

	// The resume rule: never a smaller window, never a wait. The user decides.
	it("refuses a resume at once, without waiting or negotiating", async () => {
		const probe = negotiate(
			{ numCtx: 262_144, numCtxMin: 262_144, resume: true },
			[GUARANTEED],
			[refused(131_072, { retryAfter: "2" })],
		);
		const error = await probe.run().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(OpencotiWindowUnavailableError);
		expect((error as OpencotiWindowUnavailableError).resume).toBe(true);
		expect((error as Error).message).toContain(
			"It was opened with a 256k window and needs the same to continue. The server has 128k free right now.",
		);
		expect(probe.waits).toEqual([]);
		expect(probe.engine.chats).toHaveLength(1);
	});

	// A 429 that names no window is the throughput floor, not ours: it goes
	// back as the response it is, for the rate-limit middleware to wait out.
	it("hands back a refusal that is not about the window", async () => {
		const probe = negotiate(
			{ numCtx: 262_144, numCtxMin: 65_536 },
			[GUARANTEED, ATOMIC],
			[refused(undefined, { retryAfter: "2" })],
		);
		const response = await probe.run();
		expect(response.status).toBe(429);
		expect(probe.waits).toEqual([]);
	});

	it("does not treat a refused ask as below the floor when the floor fits", async () => {
		const probe = negotiate(
			{ numCtx: 262_144, numCtxMin: 65_536 },
			[GUARANTEED, ATOMIC],
			[refused(131_072)],
		);
		const response = await probe.run();
		// Atomic: had 131,072 been grantable the server would have granted it,
		// so this refusal is about something else and is not negotiated here.
		expect(response.status).toBe(429);
		expect(probe.engine.chats).toHaveLength(1);
	});
});

/**
 * "Asked X, got Y", on every admitted response.
 */
describe("what an admitted response says about the window", () => {
	beforeEach(() => {
		resetPolykvAvailability();
		resetPolykvSessions();
	});

	async function admit(headers: Record<string, string>, numCtx = 262_144) {
		const engine = windowEngine({
			features: [GUARANTEED, ATOMIC],
			replies: [ok({ choices: [] }, headers)],
		});
		const seen: OpencotiResponseFacts[] = [];
		const fetchImpl = createOpencotiFetch({
			fetch: engine.fetch,
			baseUrl: "http://x/v1",
			request: { sessionId: "conv", numCtx },
			onFacts: (facts) => seen.push(facts),
		});
		await fetchImpl("http://x/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		return seen;
	}

	it("puts the ask beside the grant", async () => {
		const seen = await admit({ "x-context-window": "163840" });
		expect(seen.at(-1)).toMatchObject({
			contextWindow: 163_840,
			askedWindow: 262_144,
		});
		expect(getPolykvWindowObservation("conv")).toEqual({
			granted: 163_840,
			asked: 262_144,
		});
	});

	// Absent is unknown, not unchanged: the observation says so, while the
	// booking the resume rule rests on is kept.
	it("reads a missing header as unknown and keeps the booking", async () => {
		await admit({ "x-context-window": "163840" });
		await admit({});
		expect(getPolykvWindowObservation("conv")?.granted).toBeUndefined();
		expect(getPolykvGrantedWindow("conv")).toBe(163_840);
	});
});

/**
 * `X-Context-Window` is the grant, and its absence is not a grant.
 *
 * The server sends it on every admitted response **when it is in guaranteed
 * mode**. Absent therefore means "not guaranteed" -- an overcommit request, or
 * a server not enforcing -- and reading that as "unchanged" is a silent lie
 * about the one number the conversation is sized against.
 */
describe("reading the granted window", () => {
	function window(headers: Record<string, string>) {
		const seen: OpencotiResponseFacts[] = [];
		const fetchImpl = createOpencotiFetch({
			fetch: (async () =>
				ok({ choices: [] }, headers)) as unknown as typeof fetch,
			onFacts: (f) => seen.push(f),
		});
		return {
			seen,
			run: () =>
				fetchImpl("http://x/v1/chat/completions", {
					method: "POST",
					body: "{}",
				}),
		};
	}

	it("reports the window the server granted", async () => {
		const probe = window({ "x-context-window": "163840" });
		await probe.run();
		expect(probe.seen.at(-1)?.contextWindow).toBe(163_840);
	});

	it("says nothing rather than guessing when the header is absent", async () => {
		const probe = window({});
		await probe.run();
		expect(probe.seen.at(-1)?.contextWindow).toBeUndefined();
	});
});

/**
 * The resume rule, and why it needs no signal from the task layer.
 *
 * A resumed conversation must get the window it was opened with. It may never
 * negotiate down: its history no longer fits a smaller one, so a silent shrink
 * truncates it mid-thread.
 *
 * The awkward part is knowing that a request *is* a resume. The server cannot
 * tell -- after the idle TTL it has forgotten the session, and a resume is an
 * ordinary new admission to it. The client can, but only if it remembers what
 * it was granted.
 *
 * So it remembers. Once `X-Context-Window` has reported a grant for a session,
 * every later admission for that session asks for exactly that window and
 * floors at it, which is "the window I had, or refuse" with no caller
 * involvement. On a continuation the server ignores both fields anyway, so the
 * only turn where this changes anything is the one after the hold lapsed --
 * which is precisely the resume.
 */
describe("remembering the window a session was granted", () => {
	beforeEach(resetPolykvSessions);

	it("asks for exactly the granted window once one is known", () => {
		recordPolykvGrantedWindow("conv-1", 163_840);
		const options = readOpencotiRequestOptions({
			config: {
				providerId: "opencoti",
				options: {
					polykvSessionId: "conv-1",
					polykv: {
						enabled: true,
						dynamicContextSize: true,
						contextFloor: 32_768,
					},
				},
			},
			model: { id: "m", contextWindow: 262_144 },
		} as never);
		// Not the configured 262,144, and not floored at 32,768: the window
		// this conversation already has.
		expect(options.numCtx).toBe(163_840);
		expect(options.numCtxMin).toBe(163_840);
		expect(options.resume).toBe(true);
	});

	it("carries the profile's wait bound for the one below-floor wait", () => {
		const options = readOpencotiRequestOptions({
			config: {
				providerId: "opencoti",
				options: {
					polykvSessionId: "fresh",
					polykv: {
						enabled: true,
						dynamicContextSize: true,
						maxRetryAfterMs: 4_000,
					},
				},
			},
			model: { id: "m", contextWindow: 262_144 },
		} as never);
		expect(options.maxRetryAfterMs).toBe(4_000);
		expect(options.resume).toBeUndefined();
	});

	it("negotiates down to the floor on a session with no grant yet", () => {
		const options = readOpencotiRequestOptions({
			config: {
				providerId: "opencoti",
				options: {
					polykvSessionId: "fresh",
					polykv: {
						enabled: true,
						dynamicContextSize: true,
						contextFloor: 32_768,
					},
				},
			},
			model: { id: "m", contextWindow: 262_144 },
		} as never);
		expect(options.numCtx).toBe(262_144);
		expect(options.numCtxMin).toBe(32_768);
	});

	// Off by default: booking a guaranteed window changes what a busy server
	// does with the request, from "serve it best-effort" to "refuse it at
	// admission". That is a decision the user makes, not one taken for them.
	it("books nothing at all when dynamic sizing is off", () => {
		const options = readOpencotiRequestOptions({
			config: {
				providerId: "opencoti",
				options: {
					polykvSessionId: "fresh",
					polykv: { enabled: true },
				},
			},
			model: { id: "m", contextWindow: 262_144 },
		} as never);
		expect(options.numCtx).toBeUndefined();
		expect(options.numCtxMin).toBeUndefined();
	});

	// A floor is a promise that a smaller window is still usable. Without one
	// there is nothing to negotiate down to, so the ask is all-or-nothing.
	it("asks all-or-nothing when sizing is on but no floor was set", () => {
		const options = readOpencotiRequestOptions({
			config: {
				providerId: "opencoti",
				options: {
					polykvSessionId: "fresh",
					polykv: { enabled: true, dynamicContextSize: true },
				},
			},
			model: { id: "m", contextWindow: 262_144 },
		} as never);
		expect(options.numCtx).toBe(262_144);
		expect(options.numCtxMin).toBeUndefined();
	});

	it("forgets the grant when the session is closed", () => {
		recordPolykvGrantedWindow("conv-1", 163_840);
		clearPolykvGrantedWindow("conv-1");
		expect(getPolykvGrantedWindow("conv-1")).toBeUndefined();
	});
});
