import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpencotiFetch } from "./opencoti";
import {
	getOpencotiWindowFloor,
	latestOpencotiPressure,
	noteOpencotiPressure,
	OPENCOTI_PRESSURE_CLEAR_MAX_AGE_MS,
	opencotiPressureState,
	opencotiResizeRequest,
	parseOpencotiRefusalPressure,
	readOpencotiKv,
	resetOpencotiPressure,
	resetOpencotiWindowFloors,
	resizeOpencotiSession,
} from "./opencoti-kv-pressure";
import { resetPolykvAvailability, resetPolykvSessions } from "./polykv";
import {
	polykvOwnerWindowBounds,
	releaseAllPolykvSwarms,
} from "./polykv-swarm";

/** The block as b108 writes it (mail #296). */
const WIRE_PRESSURE = {
	window_s: 60,
	refused_60s: 3,
	refused_peak_max_60s: 40_000,
	refused_needed_max_60s: 131_072,
	refused_min_needed_min_60s: 65_536,
	last_refusal_at: 1_790_000_000,
	last_refusal_age_s: 4,
	refusals_total: 377,
};

const PARSED_PRESSURE = {
	windowS: 60,
	refused60s: 3,
	refusedPeakMax60s: 40_000,
	refusedNeededMax60s: 131_072,
	refusedMinNeededMin60s: 65_536,
	lastRefusalAt: 1_790_000_000,
	lastRefusalAgeS: 4,
	refusalsTotal: 377,
};

interface Call {
	method: string;
	path: string;
	body?: Record<string, unknown>;
	headers: Record<string, string>;
}

function json(
	value: unknown,
	status = 200,
	headers: Record<string, string> = {},
) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/** A stub opencoti: `/props` features, `/kv`, a scripted resize, chats. */
function engine(options: {
	features: string[];
	kv?: Record<string, unknown>;
	resize?: () => Response;
	chat?: (body: Record<string, unknown>) => Response;
}) {
	const calls: Call[] = [];
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: undefined;
		calls.push({
			method: init?.method ?? "GET",
			path: url.pathname,
			...(body ? { body } : {}),
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		if (url.pathname === "/props") {
			return json({ features: options.features });
		}
		if (url.pathname === "/kv") {
			return json(options.kv ?? { allocations: [] });
		}
		if (url.pathname.endsWith("/resize")) {
			return options.resize?.() ?? json({}, 500);
		}
		if (url.pathname === "/v1/chat/completions") {
			return options.chat?.(body ?? {}) ?? json({ choices: [] });
		}
		return json({}, 404);
	}) as unknown as typeof fetch;
	return { calls, fetch: fetchImpl };
}

beforeEach(() => {
	resetPolykvAvailability();
	resetPolykvSessions();
	resetOpencotiPressure();
	resetOpencotiWindowFloors();
});

afterEach(async () => {
	await releaseAllPolykvSwarms();
});

describe("the server's pressure", () => {
	it("is parsed off GET /kv where the server advertises kv_pressure_v1", async () => {
		const stub = engine({
			features: ["kv_status_v1", "kv_pressure_v1"],
			kv: {
				allocations: [
					{ session_id: "s", window: 131_072, used: 20_000, pressure: 0.15 },
				],
				pressure: WIRE_PRESSURE,
			},
		});
		const kv = await readOpencotiKv("http://engine/v1", stub.fetch);
		expect(kv?.pressure).toEqual(PARSED_PRESSURE);
		expect(kv?.allocations[0]).toMatchObject({
			sessionId: "s",
			window: 131_072,
			used: 20_000,
		});
		// And recorded for the server, for every agent on it.
		expect(latestOpencotiPressure("http://engine")?.pressure).toEqual(
			PARSED_PRESSURE,
		);
	});

	it("is not read off a server that does not advertise it", async () => {
		const stub = engine({
			features: ["kv_status_v1"],
			kv: { allocations: [], pressure: WIRE_PRESSURE },
		});
		const kv = await readOpencotiKv("http://engine/v1", stub.fetch);
		expect(kv?.pressure).toBeUndefined();
		expect(latestOpencotiPressure("http://engine")).toBeUndefined();
	});

	it("is parsed off an admission 429's error.pressure", () => {
		const body = JSON.stringify({
			error: {
				code: 429,
				message: "context allocation exhausted",
				type: "rate_limit_error",
				pressure: WIRE_PRESSURE,
			},
		});
		expect(parseOpencotiRefusalPressure(body)).toEqual(PARSED_PRESSURE);
		expect(parseOpencotiRefusalPressure("not json")).toBeUndefined();
		expect(
			parseOpencotiRefusalPressure({ error: { message: "x" } }),
		).toBeUndefined();
	});

	it("is recorded when a chat request is refused with it", async () => {
		const stub = engine({
			features: [],
			chat: () =>
				json(
					{ error: { code: 429, message: "full", pressure: WIRE_PRESSURE } },
					429,
					{ "retry-after": "2" },
				),
		});
		const fetchImpl = createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://engine/v1",
			request: { sessionId: "lead-1" },
		});
		const response = await fetchImpl("http://engine/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		// The refusal still reaches the caller whole.
		expect(response.status).toBe(429);
		expect(
			((await response.json()) as { error: { message: string } }).error,
		).toMatchObject({ message: "full" });
		expect(latestOpencotiPressure("http://engine/v1")?.pressure).toEqual(
			PARSED_PRESSURE,
		);
	});

	it("is active while the last refusal is inside the window, counted from the read", () => {
		const at = 1_000_000;
		const reading = {
			pressure: { windowS: 60, refused60s: 1, lastRefusalAgeS: 50 },
			at,
		};
		expect(opencotiPressureState(reading, at)).toBe("active");
		expect(opencotiPressureState(reading, at + 9_000)).toBe("active");
		// 50 s old at the read, 61 s old now: out of the window. And the read
		// itself is too old to call the server clear.
		expect(opencotiPressureState(reading, at + 11_000)).toBe("clear");
		expect(
			opencotiPressureState(
				reading,
				at + OPENCOTI_PRESSURE_CLEAR_MAX_AGE_MS + 1,
			),
		).toBe("unknown");
		expect(
			opencotiPressureState(
				{ pressure: { windowS: 60, refused60s: 0, lastRefusalAgeS: -1 }, at },
				at,
			),
		).toBe("clear");
		expect(opencotiPressureState(undefined)).toBe("unknown");
	});

	it("keeps the newest reading, whichever route it came by", () => {
		noteOpencotiPressure(
			"http://engine/v1",
			{ windowS: 60, refused60s: 2 },
			2_000,
		);
		noteOpencotiPressure(
			"http://engine",
			{ windowS: 60, refused60s: 9 },
			1_000,
		);
		expect(latestOpencotiPressure("http://engine")?.pressure.refused60s).toBe(
			2,
		);
	});
});

describe("the resize route", () => {
	it("puts an id the path can carry in the path", () => {
		expect(opencotiResizeRequest("01JABCDEF", 98_304)).toEqual({
			path: "/kv/sessions/01JABCDEF/resize",
			body: { num_ctx: 98_304 },
		});
	});

	it("sends ids with '/' or '~' in the body", () => {
		expect(opencotiResizeRequest("lead/agent-1", 98_304)).toEqual({
			path: "/sessions/resize",
			body: { session_id: "lead/agent-1", num_ctx: 98_304 },
		});
		expect(opencotiResizeRequest("lead~teammate-coder-mgx1ab", 65_536)).toEqual(
			{
				path: "/sessions/resize",
				body: { session_id: "lead~teammate-coder-mgx1ab", num_ctx: 65_536 },
			},
		);
	});

	it("POSTs exactly that, and reads the grant back", async () => {
		const stub = engine({
			features: [],
			resize: () =>
				json({
					ok: true,
					window: 262_144,
					window_new: 98_304,
					cells: 262_144,
					cells_new: 98_304,
					cells_delta: -163_840,
					used: 40_000,
					sequences: 1,
				}),
		});
		const result = await resizeOpencotiSession({
			baseUrl: "http://engine/v1",
			sessionId: "lead~agent-x",
			numCtx: 98_304,
			fetch: stub.fetch,
			headers: { authorization: "Bearer k" },
		});
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]).toMatchObject({
			method: "POST",
			path: "/sessions/resize",
			body: { session_id: "lead~agent-x", num_ctx: 98_304 },
		});
		expect(stub.calls[0]?.headers).toMatchObject({
			authorization: "Bearer k",
			"content-type": "application/json",
		});
		expect(result).toEqual({
			ok: true,
			window: 262_144,
			windowNew: 98_304,
			cells: 262_144,
			cellsNew: 98_304,
			cellsDelta: -163_840,
			used: 40_000,
			sequences: 1,
		});
	});

	it.each([
		[404, "session_not_found"],
		[400, "invalid_num_ctx"],
		[400, "above_session_ctx_max"],
		[409, "per_request_session"],
		[409, "session_closing"],
		[409, "session_busy"],
		[409, "used_exceeds_window"],
	])("reads a %i %s refusal as that kind", async (status, kind) => {
		const stub = engine({
			features: [],
			resize: () =>
				json(
					{
						error: {
							code: status,
							message: `refused: ${kind}`,
							type: "invalid_request_error",
							error_kind: kind,
							session_id: "s1",
							found: status !== 404,
							window: 262_144,
							cells: 262_144,
							used: 150_000,
							sequences: 1,
						},
					},
					status,
				),
		});
		const result = await resizeOpencotiSession({
			baseUrl: "http://engine",
			sessionId: "s1",
			numCtx: 65_536,
			fetch: stub.fetch,
		});
		expect(stub.calls[0]).toMatchObject({
			method: "POST",
			path: "/kv/sessions/s1/resize",
			body: { num_ctx: 65_536 },
		});
		expect(result).toMatchObject({
			ok: false,
			status,
			kind,
			used: 150_000,
			window: 262_144,
		});
	});

	it("reads an exhausted grow's largest_admissible and pressure", async () => {
		const stub = engine({
			features: [],
			resize: () =>
				json(
					{
						error: {
							code: 429,
							message: "context allocation exhausted",
							type: "rate_limit_error",
							largest_admissible: 150_000,
							pressure: WIRE_PRESSURE,
						},
					},
					429,
				),
		});
		const result = await resizeOpencotiSession({
			baseUrl: "http://engine",
			sessionId: "s1",
			numCtx: 262_144,
			fetch: stub.fetch,
		});
		expect(result).toMatchObject({
			ok: false,
			status: 429,
			kind: "exhausted",
			largestAdmissible: 150_000,
			pressure: PARSED_PRESSURE,
		});
		expect(latestOpencotiPressure("http://engine")?.pressure).toEqual(
			PARSED_PRESSURE,
		);
	});

	it("answers a transport failure as a refusal, never a throw", async () => {
		const result = await resizeOpencotiSession({
			baseUrl: "http://engine",
			sessionId: "s1",
			numCtx: 65_536,
			fetch: (async () => {
				throw new TypeError("fetch failed");
			}) as unknown as typeof fetch,
		});
		expect(result).toEqual({ ok: false, status: 0, kind: "transport" });
	});
});

describe("the floor a pressure resize keeps", () => {
	const agentBody = {
		model: "m",
		messages: [
			{ role: "system", content: "You are an agent. ".repeat(200) },
			{ role: "user", content: "the task" },
		],
		max_tokens: 8_000,
	};
	const window = { contextWindow: 131_072, sharePercent: 50 };
	const chatWith = (granted: number) => (body: Record<string, unknown>) =>
		json(
			{ choices: [{ message: { content: "ok" } }] },
			200,
			typeof body.num_ctx === "number"
				? { "x-context-window": String(granted) }
				: {},
		);
	const features = ["elastic_guaranteed_alloc_v1", "ctx_min_negotiation_v1"];

	it("is the agent window's share, recorded on a fresh ask and on a resume", async () => {
		const stub = engine({ features, chat: chatWith(131_072) });
		const send = async (
			request: Parameters<typeof createOpencotiFetch>[0]["request"],
		) =>
			createOpencotiFetch({
				fetch: stub.fetch,
				baseUrl: "http://engine/v1",
				request,
			})("http://engine/v1/chat/completions", {
				method: "POST",
				body: JSON.stringify(agentBody),
			});
		await send({ sessionId: "agent-f", numCtx: 131_072, agentWindow: window });
		const chat = stub.calls.find(
			(call) => call.path === "/v1/chat/completions",
		);
		const floor = chat?.body?.num_ctx_min as number;
		expect(floor).toBeGreaterThan(0);
		expect(floor).toBeLessThan(131_072);
		expect(getOpencotiWindowFloor("agent-f")).toBe(floor);

		// A resume sends its grant as num_ctx_min; the floor it declared stays.
		resetOpencotiWindowFloors();
		await send({
			sessionId: "agent-f",
			numCtx: 98_304,
			numCtxMin: 98_304,
			resume: true,
			agentWindow: window,
		});
		expect(getOpencotiWindowFloor("agent-f")).toBe(floor);
	});

	it("is the profile's contextFloor for a session that is not an agent's", async () => {
		const stub = engine({ features, chat: chatWith(131_072) });
		await createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://engine/v1",
			request: {
				sessionId: "lead-f",
				numCtx: 131_072,
				numCtxMin: 131_072,
				resume: true,
				windowFloor: 32_768,
			},
		})("http://engine/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(getOpencotiWindowFloor("lead-f")).toBe(32_768);
	});

	it("is not recorded where no window is booked", async () => {
		const stub = engine({ features: [], chat: chatWith(131_072) });
		await createOpencotiFetch({
			fetch: stub.fetch,
			baseUrl: "http://engine/v1",
			request: { sessionId: "lead-n", numCtx: 131_072, windowFloor: 32_768 },
		})("http://engine/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify({ model: "m", messages: [] }),
		});
		expect(getOpencotiWindowFloor("lead-n")).toBeUndefined();
	});

	it("bounds a swarm owner by the window it asked for and the floor it took", async () => {
		const pools: number[] = [];
		const stub = engine({
			features,
			kv: { session_ctx_max: 262_144 },
			chat: chatWith(131_072),
		});
		const inner = stub.fetch;
		const withPools = (async (input: unknown, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.pathname === "/apply-template") {
				return json({ prompt: "<|system|>x<|end|>" });
			}
			if (url.pathname === "/polykv/pools" && init?.method === "GET") {
				return json({ pools: [] });
			}
			if (url.pathname === "/polykv/pools" || url.pathname.endsWith("/fork")) {
				pools.push(pools.length);
				return json({ pool_id: pools.length - 1, parent: -1, prefix_len: 10 });
			}
			return inner(input as never, init);
		}) as unknown as typeof fetch;
		const body = {
			...agentBody,
			messages: [
				agentBody.messages[0],
				{ role: "user", content: "the shared knowledge" },
				{ role: "user", content: "the role" },
				{ role: "user", content: "the task" },
			],
		};
		await createOpencotiFetch({
			fetch: withPools,
			baseUrl: "http://engine/v1",
			request: {
				worker: { group: "lead-owner", sessionId: "agent-p", layers: 2 },
				agentWindow: window,
			},
		})("http://engine/v1/chat/completions", {
			method: "POST",
			body: JSON.stringify(body),
		});
		const opened = stub.calls.find(
			(call) =>
				call.path === "/v1/chat/completions" && call.body?.max_tokens === 1,
		);
		expect(opened).toBeDefined();
		expect(polykvOwnerWindowBounds(opened?.body?.session_id as string)).toEqual(
			{
				ceiling: opened?.body?.num_ctx,
				floor: opened?.body?.num_ctx_min,
			},
		);
	});
});
