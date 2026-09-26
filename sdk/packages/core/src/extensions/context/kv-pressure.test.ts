import type * as LlmsProviders from "@cline/llms";
import {
	getPolykvGrantedWindow,
	recordOpencotiWindowFloor,
	recordPolykvGrantedWindow,
	resetOpencotiPressure,
	resetOpencotiWindowFloors,
	resetPolykvAvailability,
	resetPolykvSessions,
} from "@cline/llms";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createContextCompactionPrepareTurn } from "./compaction";
import { KV_SHRINK_FILL, resetKvPressureState } from "./kv-pressure";
import { clearPolykvAllocationCache } from "./polykv-session";

/**
 * Global pressure on opencoti (`kv_pressure_v1` + `kv_resize_v1`): a running
 * agent compacts and gives cells back while the server refuses others, never
 * below its floor, and takes them back when the refusals stop. Everything is
 * driven through the compaction pipeline's turn boundary against a stub
 * engine that records every call.
 */

const BOTH = ["kv_status_v1", "kv_pressure_v1", "kv_resize_v1"];
const ACTIVE = {
	window_s: 60,
	refused_60s: 4,
	refused_min_needed_min_60s: 65_536,
	last_refusal_age_s: 3,
	refusals_total: 20,
};
const CLEARED = {
	window_s: 60,
	refused_60s: 0,
	last_refusal_age_s: 600,
	refusals_total: 20,
};
const SESSION = "lead~agent-k";

interface Call {
	method: string;
	path: string;
	body?: Record<string, unknown>;
}

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function engine(options: {
	features?: string[];
	row: { window: number; used: number } & Record<string, unknown>;
	pressure?: Record<string, unknown>;
	/** Top-level `/kv` fields: `cells_free`, `cells_total`. */
	top?: Record<string, unknown>;
	/** One answer per resize, in order; the last repeats. */
	resize?: Array<(body: Record<string, unknown>) => Response>;
}) {
	const calls: Call[] = [];
	let resizes = 0;
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: undefined;
		calls.push({
			method: init?.method ?? "GET",
			path: url.pathname,
			...(body ? { body } : {}),
		});
		if (url.pathname === "/props") {
			return json({ features: options.features ?? BOTH });
		}
		if (url.pathname === "/kv") {
			return json({
				allocations: [
					{
						...options.row,
						session_id: SESSION,
						window: options.row.window,
						used: options.row.used,
						pressure: options.row.used / options.row.window,
					},
				],
				...(options.pressure ? { pressure: options.pressure } : {}),
				...(options.top ?? {}),
			});
		}
		if (url.pathname.endsWith("/resize")) {
			const answers = options.resize ?? [];
			const answer =
				answers[Math.min(resizes, answers.length - 1)] ??
				((sent: Record<string, unknown>) =>
					json({
						ok: true,
						window: options.row.window,
						window_new: sent.num_ctx,
						cells_delta: (sent.num_ctx as number) - options.row.window,
					}));
			resizes += 1;
			return answer(body ?? {});
		}
		return json({}, 404);
	}) as unknown as typeof fetch;
	return {
		calls,
		fetch: fetchImpl,
		resizes: () => calls.filter((call) => call.path.endsWith("/resize")),
	};
}

async function boundary(
	fetchImpl: typeof fetch,
	options: {
		messageChars?: number;
		contextWindow?: number;
		compact?: () => Promise<{ messages: LlmsProviders.Message[] }>;
		mode?: "auto" | "manual";
		overflowRecovery?: boolean;
	} = {},
) {
	const diagnostics: Array<Record<string, unknown>> = [];
	const lines: Array<{ message: string; severity?: string }> = [];
	const logger = {
		debug: (message: string, metadata?: Record<string, unknown>) => {
			if (message === "Context compaction diagnostics" && metadata) {
				diagnostics.push(metadata);
			}
		},
		log: (message: string, metadata?: Record<string, unknown>) => {
			lines.push({
				message,
				...(typeof metadata?.severity === "string"
					? { severity: metadata.severity }
					: {}),
			});
		},
	};
	const prepareTurn = createContextCompactionPrepareTurn(
		{
			providerId: "opencoti",
			modelId: "m",
			sessionId: SESSION,
			providerConfig: {
				providerId: "opencoti",
				modelId: "m",
				baseUrl: "http://engine/v1",
				fetch: fetchImpl,
				// No pool tree: a window is booked, and resized, without one.
				polykv: { enabled: false },
				engineSessionId: SESSION,
			} as unknown as LlmsProviders.ProviderConfig,
			compaction: {
				enabled: true,
				strategy: "basic",
				...(options.compact ? { compact: options.compact } : {}),
			} as never,
			logger: logger as never,
		},
		options.mode ? { mode: options.mode } : {},
	);
	const messages: LlmsProviders.Message[] = [
		{ role: "user", content: "x".repeat(options.messageChars ?? 40) },
	];
	const result = await prepareTurn?.({
		agentId: "agent-1",
		conversationId: SESSION,
		parentAgentId: null,
		iteration: 1,
		abortSignal: new AbortController().signal,
		...(options.overflowRecovery ? { overflowRecovery: true } : {}),
		systemPrompt: "You are helpful.",
		tools: [],
		messages,
		apiMessages: messages,
		model: {
			id: "m",
			provider: "opencoti",
			info: {
				id: "m",
				contextWindow: options.contextWindow ?? 262_144,
				maxTokens: 8_192,
			},
		},
	} as never);
	return { found: diagnostics[0], lines, result };
}

beforeEach(() => {
	resetPolykvSessions();
	resetPolykvAvailability();
	resetOpencotiPressure();
	resetOpencotiWindowFloors();
	resetKvPressureState();
	clearPolykvAllocationCache();
	recordPolykvGrantedWindow(SESSION, 262_144, { asked: 262_144 });
	recordOpencotiWindowFloor(SESSION, 60_000);
});

afterEach(() => {
	resetPolykvSessions();
});

const noWarnings = (lines: Array<{ severity?: string }>) =>
	expect(lines.filter((line) => line.severity === "warn")).toEqual([]);

describe("compaction on global pressure", () => {
	it("requests compaction at the turn boundary for an agent above its floor", async () => {
		const stub = engine({
			row: { window: 262_144, used: 150_000 },
			pressure: ACTIVE,
		});
		const { found } = await boundary(stub.fetch, { messageChars: 600_000 });
		expect(found?.kvPressureState).toBe("active");
		expect(found?.kvPressureCompaction).toBe(true);
		expect(found?.shouldCompact).toBe(true);
		// Not the ratio trigger: the context is far below it.
		expect(found?.triggerInputTokens as number).toBeLessThan(
			found?.requestTriggerTokens as number,
		);
	});

	it("shrinks after the compaction it asked for, to the compacted size", async () => {
		recordOpencotiWindowFloor(SESSION, 1_000);
		const stub = engine({
			row: { window: 262_144, used: 150_000 },
			pressure: ACTIVE,
		});
		let compacted = 0;
		const { found, lines } = await boundary(stub.fetch, {
			messageChars: 600_000,
			compact: async () => {
				compacted += 1;
				return {
					messages: [{ role: "user", content: "summary ".repeat(2_000) }],
				};
			},
		});
		expect(found?.kvPressureCompaction).toBe(true);
		expect(compacted).toBe(1);
		const resizes = stub.resizes();
		expect(resizes).toHaveLength(1);
		const target = resizes[0]?.body?.num_ctx as number;
		// Sized from what the compaction left, not from the 150,000 the engine
		// still counts until the next request.
		expect(target).toBeLessThan(150_000);
		expect(target).toBeGreaterThanOrEqual(1_000);
		expect(getPolykvGrantedWindow(SESSION)).toBe(target);
		noWarnings(lines.filter((line) => line.message.includes("[PolyKV]")));
	});

	it.each([
		["a manual compaction", { mode: "manual" as const }],
		["an overflow recovery", { overflowRecovery: true }],
	])("shrinks after %s too, never below the floor", async (_name, mode) => {
		const stub = engine({
			row: { window: 262_144, used: 150_000 },
			pressure: ACTIVE,
		});
		let compacted = 0;
		const { lines } = await boundary(stub.fetch, {
			...mode,
			messageChars: 600_000,
			compact: async () => {
				compacted += 1;
				return {
					messages: [{ role: "user", content: "summary ".repeat(200) }],
				};
			},
		});
		expect(compacted).toBe(1);
		const resizes = stub.resizes();
		expect(resizes).toHaveLength(1);
		const target = resizes[0]?.body?.num_ctx as number;
		// The same floor as after an automatic one.
		expect(target).toBe(Math.ceil(60_000 / 256) * 256);
		expect(getPolykvGrantedWindow(SESSION)).toBe(target);
		noWarnings(lines.filter((line) => line.message.includes("[PolyKV]")));
	});

	it.each([
		["a manual compaction", { mode: "manual" as const }],
		["an overflow recovery", { overflowRecovery: true }],
	])("does not resize after %s when nobody is being refused", async (_name, mode) => {
		const stub = engine({
			row: { window: 98_304, used: 90_000 },
			pressure: CLEARED,
		});
		recordPolykvGrantedWindow(SESSION, 98_304);
		await boundary(stub.fetch, {
			...mode,
			messageChars: 600_000,
			compact: async () => ({
				messages: [{ role: "user", content: "summary ".repeat(200) }],
			}),
		});
		// Growing is the automatic boundary's; these compactions only shrink.
		expect(stub.resizes()).toEqual([]);
	});

	it("does not compact an agent at its floor", async () => {
		recordOpencotiWindowFloor(SESSION, 262_144);
		const stub = engine({
			row: { window: 262_144, used: 150_000 },
			pressure: ACTIVE,
		});
		const { found } = await boundary(stub.fetch, { messageChars: 600_000 });
		expect(found?.kvPressureCompaction).toBe(false);
		expect(found?.shouldCompact).toBe(false);
		expect(stub.resizes()).toEqual([]);
	});

	it("does not compact when nobody is being refused", async () => {
		const stub = engine({
			row: { window: 262_144, used: 150_000 },
			pressure: CLEARED,
		});
		const { found } = await boundary(stub.fetch, { messageChars: 600_000 });
		expect(found?.kvPressureCompaction).toBe(false);
		expect(found?.shouldCompact).toBe(false);
	});

	it("sends no resize at all to a server without the features", async () => {
		for (const features of [
			["kv_status_v1"],
			["kv_status_v1", "kv_pressure_v1"],
			["kv_status_v1", "kv_resize_v1"],
		]) {
			resetPolykvAvailability();
			clearPolykvAllocationCache();
			const big = engine({
				features,
				row: { window: 262_144, used: 150_000 },
				pressure: ACTIVE,
			});
			const { found } = await boundary(big.fetch, { messageChars: 600_000 });
			expect(found?.kvPressureCompaction).toBe(false);
			const small = engine({
				features,
				row: { window: 262_144, used: 5_000 },
				pressure: ACTIVE,
			});
			resetPolykvAvailability();
			clearPolykvAllocationCache();
			await boundary(small.fetch);
			const cleared = engine({
				features,
				row: { window: 98_304, used: 90_000 },
				pressure: CLEARED,
			});
			resetPolykvAvailability();
			clearPolykvAllocationCache();
			await boundary(cleared.fetch);
			expect([
				...big.resizes(),
				...small.resizes(),
				...cleared.resizes(),
			]).toEqual([]);
		}
	});
});

/**
 * Refusals that asked the base pool for nothing: workers refused because
 * their OWNER was full, verbatim from 8244 (b108, 2026-09-25), with 786k base
 * cells free. Not global pressure -- the owner grows instead.
 */
const SESSION_FULL = {
	window_s: 60,
	refused_60s: 4,
	refused_peak_max_60s: 32_521,
	refused_needed_max_60s: 0,
	refused_min_needed_min_60s: 32_521,
	last_refusal_age_s: 3,
	refusals_total: 4,
};

describe("session-full refusals are not global pressure", () => {
	it("neither compacts nor shrinks a running agent over them", async () => {
		const stub = engine({
			row: { window: 262_144, used: 150_000 },
			pressure: SESSION_FULL,
		});
		const { found } = await boundary(stub.fetch, { messageChars: 600_000 });
		expect(found?.kvPressureState).not.toBe("active");
		expect(found?.kvPressureCompaction).toBe(false);
		expect(found?.shouldCompact).toBe(false);
		expect(stub.resizes()).toEqual([]);
	});

	it("does not shrink a small context over them either", async () => {
		const stub = engine({
			row: { window: 262_144, used: 5_000 },
			pressure: SESSION_FULL,
		});
		await boundary(stub.fetch);
		expect(stub.resizes()).toEqual([]);
		expect(getPolykvGrantedWindow(SESSION)).toBe(262_144);
	});

	it("still compacts when a refusal asked the base pool for cells", async () => {
		const stub = engine({
			row: { window: 262_144, used: 150_000 },
			pressure: { ...SESSION_FULL, refused_needed_max_60s: 65_536 },
		});
		const { found } = await boundary(stub.fetch, { messageChars: 600_000 });
		expect(found?.kvPressureState).toBe("active");
		expect(found?.kvPressureCompaction).toBe(true);
	});
});

/**
 * A resize the booking cannot take now -- a request in flight on it -- is
 * queued for its idle moment where the server offers it
 * (`kv_resize_deferred_v1`, opencoti b110, mail #306).
 */
describe("a resize queued for the idle moment", () => {
	const DEFERRED = [...BOTH, "kv_resize_deferred_v1"];
	const SHRUNK = Math.ceil(60_000 / 256) * 256;
	const queued = (sent: Record<string, unknown>) =>
		json(
			{
				ok: true,
				deferred: true,
				status: 202,
				window: 262_144,
				resize_pending: sent.num_ctx,
				active: 2,
				pending: 0,
			},
			202,
		);

	it("is asked for deferred, and a queued shrink is not read as applied", async () => {
		const stub = engine({
			features: DEFERRED,
			row: { window: 262_144, used: 5_000 },
			pressure: ACTIVE,
			resize: [queued],
		});
		const { lines } = await boundary(stub.fetch);
		expect(stub.resizes().map((call) => call.body)).toEqual([
			{ session_id: SESSION, num_ctx: SHRUNK, deferred: true },
		]);
		// Not applied yet: the next turn is still sized against the old window.
		expect(getPolykvGrantedWindow(SESSION)).toBe(262_144);
		expect(lines.some((line) => /queued/.test(line.message))).toBe(true);
		noWarnings(lines);
	});

	it("is not sent again while the row says it is pending", async () => {
		const stub = engine({
			features: DEFERRED,
			row: { window: 262_144, used: 5_000, resize_pending: SHRUNK },
			pressure: ACTIVE,
			resize: [queued],
		});
		await boundary(stub.fetch);
		expect(stub.resizes()).toEqual([]);
	});

	it("is cancelled -- the current window asked for -- once the pressure clears", async () => {
		const stub = engine({
			features: DEFERRED,
			row: { window: 262_144, used: 5_000, resize_pending: SHRUNK },
			pressure: CLEARED,
		});
		await boundary(stub.fetch);
		expect(stub.resizes().map((call) => call.body)).toEqual([
			{ session_id: SESSION, num_ctx: 262_144, deferred: true },
		]);
	});

	it("is never asked for on a server without the feature", async () => {
		const stub = engine({
			row: { window: 262_144, used: 5_000 },
			pressure: ACTIVE,
		});
		await boundary(stub.fetch);
		expect(stub.resizes()).toHaveLength(1);
		expect(stub.resizes()[0]?.body).not.toHaveProperty("deferred");
	});
});

describe("shrinking under pressure", () => {
	it("gives cells back at once when the context is already small", async () => {
		const stub = engine({
			row: { window: 262_144, used: 5_000 },
			pressure: ACTIVE,
		});
		const { found, lines } = await boundary(stub.fetch);
		expect(found?.shouldCompact).toBe(false);
		const resizes = stub.resizes();
		expect(resizes).toHaveLength(1);
		// `~` in the id: the body form of the route.
		expect(resizes[0]).toMatchObject({
			method: "POST",
			path: "/sessions/resize",
			body: { session_id: SESSION },
		});
		const target = resizes[0]?.body?.num_ctx as number;
		// The floor is what the small context is shrunk to, aligned.
		expect(target).toBe(Math.ceil(60_000 / 256) * 256);
		expect(target).toBeGreaterThanOrEqual(60_000);
		// The next turn is sized against the new window.
		expect(getPolykvGrantedWindow(SESSION)).toBe(target);
		expect(
			lines.some((line) =>
				line.message.includes(
					`window 262,144 → ${target.toLocaleString("en-US")}`,
				),
			),
		).toBe(true);
		noWarnings(lines);
	});

	it("never shrinks below the floor", async () => {
		recordOpencotiWindowFloor(SESSION, 200_000);
		const stub = engine({
			row: { window: 262_144, used: 5_000 },
			pressure: ACTIVE,
		});
		await boundary(stub.fetch);
		const target = stub.resizes()[0]?.body?.num_ctx as number;
		expect(target).toBeGreaterThanOrEqual(200_000);
		expect(target).toBeLessThan(262_144);
	});

	it("leaves room to grow above what the context holds", async () => {
		recordOpencotiWindowFloor(SESSION, 1_000);
		const stub = engine({
			row: { window: 262_144, used: 60_000 },
			pressure: ACTIVE,
		});
		await boundary(stub.fetch);
		const target = stub.resizes()[0]?.body?.num_ctx as number;
		expect(target).toBeGreaterThanOrEqual(60_000 / KV_SHRINK_FILL);
		expect(target % 256).toBe(0);
	});

	it("does not shrink a session that declared no floor", async () => {
		resetOpencotiWindowFloors();
		const stub = engine({
			row: { window: 262_144, used: 5_000 },
			pressure: ACTIVE,
		});
		await boundary(stub.fetch);
		expect(stub.resizes()).toEqual([]);
	});

	it("does not shrink when nobody is being refused", async () => {
		const stub = engine({
			row: { window: 262_144, used: 5_000 },
			pressure: CLEARED,
		});
		await boundary(stub.fetch);
		expect(stub.resizes()).toEqual([]);
	});

	const refusal =
		(status: number, kind: string, extra: Record<string, unknown> = {}) =>
		() =>
			json(
				{
					error: {
						code: status,
						message: kind,
						type: "invalid_request_error",
						error_kind: kind,
						session_id: SESSION,
						...extra,
					},
				},
				status,
			);

	it.each([
		[409, "session_busy"],
		[404, "session_not_found"],
		[409, "session_closing"],
		[400, "invalid_num_ctx"],
		[500, "server_error"],
	])("takes a %i %s without failing the turn, and asks again next boundary", async (status, kind) => {
		const stub = engine({
			row: { window: 262_144, used: 5_000 },
			pressure: ACTIVE,
			resize: [refusal(status, kind)],
		});
		const first = await boundary(stub.fetch);
		expect(first.result).toBeUndefined();
		expect(stub.resizes()).toHaveLength(1);
		expect(getPolykvGrantedWindow(SESSION)).toBe(262_144);
		noWarnings(first.lines);
		clearPolykvAllocationCache();
		await boundary(stub.fetch);
		expect(stub.resizes()).toHaveLength(2);
	});

	it("retries once at the engine's own `used` on used_exceeds_window", async () => {
		recordOpencotiWindowFloor(SESSION, 1_000);
		const stub = engine({
			row: { window: 262_144, used: 5_000 },
			pressure: ACTIVE,
			resize: [
				refusal(409, "used_exceeds_window", { used: 70_000, window: 262_144 }),
				(sent) => json({ ok: true, window: 262_144, window_new: sent.num_ctx }),
			],
		});
		const { lines } = await boundary(stub.fetch);
		const resizes = stub.resizes();
		expect(resizes).toHaveLength(2);
		const second = resizes[1]?.body?.num_ctx as number;
		expect(second).toBeGreaterThan(resizes[0]?.body?.num_ctx as number);
		expect(second).toBeGreaterThanOrEqual(70_000 / KV_SHRINK_FILL);
		expect(getPolykvGrantedWindow(SESSION)).toBe(second);
		noWarnings(lines);
	});

	it("leaves a per-request session alone: no smaller num_ctx on its next request", async () => {
		// opencoti mail #301 (7): a request that states num_ctx under a session
		// id creates a HELD booking -- per_request happens only when num_ctx is
		// unstated. Sending a smaller one would turn a booking released after
		// every request into one held until close or TTL.
		const stub = engine({
			row: { window: 262_144, used: 5_000 },
			pressure: ACTIVE,
			resize: [refusal(409, "per_request_session")],
		});
		const { lines } = await boundary(stub.fetch);
		expect(stub.resizes()).toHaveLength(1);
		// The grant -- what the next request would state as num_ctx -- is
		// untouched.
		expect(getPolykvGrantedWindow(SESSION)).toBe(262_144);
		noWarnings(lines);
		clearPolykvAllocationCache();
		await boundary(stub.fetch);
		// Not asked again: it has nothing held to resize.
		expect(stub.resizes()).toHaveLength(1);
	});
});

describe("growing back", () => {
	beforeEach(() => {
		recordPolykvGrantedWindow(SESSION, 98_304);
	});

	it("grows toward the window first asked for once the refusals stop", async () => {
		const stub = engine({
			row: { window: 98_304, used: 90_000 },
			pressure: CLEARED,
		});
		const { found, lines } = await boundary(stub.fetch);
		expect(stub.resizes()).toEqual([
			{
				method: "POST",
				path: "/sessions/resize",
				body: { session_id: SESSION, num_ctx: 262_144 },
			},
		]);
		expect(getPolykvGrantedWindow(SESSION)).toBe(262_144);
		// This turn is already sized against the grown window.
		expect(found?.grantedContextWindow).toBeUndefined();
		noWarnings(lines);
	});

	it("takes largest_admissible when the grow is refused for room", async () => {
		const stub = engine({
			row: { window: 98_304, used: 90_000 },
			pressure: CLEARED,
			resize: [
				() =>
					json(
						{
							error: {
								code: 429,
								message: "context allocation exhausted",
								largest_admissible: 150_000,
								pressure: CLEARED,
							},
						},
						429,
					),
				(sent) => json({ ok: true, window: 98_304, window_new: sent.num_ctx }),
			],
		});
		const { lines } = await boundary(stub.fetch);
		const resizes = stub.resizes();
		expect(resizes.map((call) => call.body?.num_ctx)).toEqual([
			262_144,
			Math.floor(150_000 / 256) * 256,
		]);
		expect(getPolykvGrantedWindow(SESSION)).toBe(
			Math.floor(150_000 / 256) * 256,
		);
		noWarnings(lines);
	});

	it("does not grow a window with room left", async () => {
		const stub = engine({
			row: { window: 98_304, used: 30_000 },
			pressure: CLEARED,
		});
		await boundary(stub.fetch);
		expect(stub.resizes()).toEqual([]);
	});

	it("does not grow while the server is refusing", async () => {
		const stub = engine({
			row: { window: 98_304, used: 90_000 },
			pressure: ACTIVE,
		});
		await boundary(stub.fetch);
		expect(
			stub.resizes().filter((call) => (call.body?.num_ctx as number) > 98_304),
		).toEqual([]);
	});
});

describe("cells idle slots hold (kv_observable_v1)", () => {
	// b115, patch 0399 (mail #316): released workers' cells stay resident and
	// are charged to no booking. b108 booked `used 9750` while ~81k were held.
	const OBSERVABLE = [...BOTH, "kv_resize_deferred_v1", "kv_observable_v1"];
	const SHRUNK = Math.ceil(60_000 / 256) * 256;
	const queued = (sent: Record<string, unknown>) =>
		json(
			{
				ok: true,
				deferred: true,
				status: 202,
				window: 262_144,
				resize_pending: sent.num_ctx,
			},
			202,
		);

	it("sizes a shrink against used plus the idle cells", async () => {
		recordOpencotiWindowFloor(SESSION, 1_000);
		const stub = engine({
			features: OBSERVABLE,
			row: { window: 262_144, used: 5_000 },
			pressure: { ...ACTIVE, idle_resident: 40_000 },
			// Far more room than ghosts: sized with them, not pressed by them.
			top: { cells_free: 1_000_000, cells_total: 1_048_576 },
			resize: [queued],
		});
		const { lines } = await boundary(stub.fetch);
		const target = stub.resizes()[0]?.body?.num_ctx as number;
		expect(target).toBeGreaterThanOrEqual(45_000 / KV_SHRINK_FILL);
		expect(target).toBeLessThan(262_144);
		noWarnings(lines);
	});

	it("reads idle cells that are a quarter of the free room as pressure", async () => {
		const stub = engine({
			features: OBSERVABLE,
			row: { window: 262_144, used: 5_000 },
			// Nobody refused: the idle cells alone are the pressure.
			pressure: { ...CLEARED, idle_resident: 81_000 },
			top: { cells_free: 200_000, cells_total: 1_048_576 },
		});
		const { found, lines } = await boundary(stub.fetch);
		expect(found?.kvPressureState).toBe("active");
		const target = stub.resizes()[0]?.body?.num_ctx as number;
		expect(target).toBeGreaterThanOrEqual(86_000 / KV_SHRINK_FILL);
		expect(target).toBeLessThan(262_144);
		expect(
			lines.some((line) =>
				/81,000 cells held by idle slots/.test(line.message),
			),
		).toBe(true);
		noWarnings(lines);
	});

	it("does not read one idle slot's short cache as pressure", async () => {
		const stub = engine({
			features: OBSERVABLE,
			row: { window: 262_144, used: 5_000 },
			// A quarter of the free room, and still only one short request.
			pressure: { ...CLEARED, idle_resident: 4_000 },
			top: { cells_free: 10_000, cells_total: 1_048_576 },
		});
		const { found } = await boundary(stub.fetch);
		expect(found?.kvPressureState).toBe("clear");
		expect(stub.resizes()).toEqual([]);
	});

	it("does not grow a filling booking into idle cells", async () => {
		recordPolykvGrantedWindow(SESSION, 98_304, { asked: 262_144 });
		const stub = engine({
			features: OBSERVABLE,
			row: { window: 98_304, used: 90_000 },
			pressure: { ...CLEARED, idle_resident: 81_000 },
			top: { cells_free: 200_000, cells_total: 1_048_576 },
		});
		await boundary(stub.fetch);
		expect(
			stub.resizes().filter((call) => (call.body?.num_ctx as number) > 98_304),
		).toEqual([]);
	});

	it("compacts under idle-cell pressure when that frees a real share of the window", async () => {
		const stub = engine({
			features: OBSERVABLE,
			row: { window: 262_144, used: 150_000 },
			pressure: { ...CLEARED, idle_resident: 200_000 },
			top: { cells_free: 400_000, cells_total: 1_048_576 },
		});
		const { found } = await boundary(stub.fetch, { messageChars: 600_000 });
		expect(found?.kvPressureCompaction).toBe(true);
		expect(found?.shouldCompact).toBe(true);
	});

	it("re-decides a queued shrink the engine refused at idle from the current /kv", async () => {
		recordOpencotiWindowFloor(SESSION, 1_000);
		const stub = engine({
			features: OBSERVABLE,
			row: {
				window: 262_144,
				used: 5_000,
				resize_pending: SHRUNK,
				resize_pending_reason: "used_exceeds_window",
				resize_pending_refused_at: 1_790_000_100,
				resize_pending_refused_s: 1.5,
			},
			pressure: { ...ACTIVE, idle_resident: 40_000 },
			top: { cells_free: 1_000_000, cells_total: 1_048_576 },
			resize: [queued],
		});
		await boundary(stub.fetch);
		const sent = stub.resizes().map((call) => call.body?.num_ctx as number);
		// Not the refused target again: a new one, standing on what is held.
		expect(sent).toHaveLength(1);
		expect(sent[0]).not.toBe(SHRUNK);
		expect(sent[0]).toBeGreaterThanOrEqual(45_000 / KV_SHRINK_FILL);
	});

	it("cancels a refused queued shrink when no shrink is worth making now", async () => {
		const stub = engine({
			features: OBSERVABLE,
			row: {
				window: 262_144,
				used: 150_000,
				resize_pending: 200_000,
				resize_pending_reason: "used_exceeds_window",
				resize_pending_refused_at: 1_790_000_100,
				resize_pending_refused_s: 1.5,
			},
			pressure: { ...ACTIVE, idle_resident: 0 },
			top: { cells_free: 1_000_000, cells_total: 1_048_576 },
		});
		const { lines } = await boundary(stub.fetch);
		expect(stub.resizes().map((call) => call.body?.num_ctx)).toEqual([262_144]);
		expect(
			lines.some((line) =>
				/refused at the booking's idle moment/.test(line.message),
			),
		).toBe(true);
		noWarnings(lines);
	});
});

describe("the SWA half (opencoti mail #322)", () => {
	const OBSERVABLE = [...BOTH, "kv_resize_deferred_v1", "kv_observable_v1"];
	// b116: "swa 66044 used of 66048 cells" while the base held 163k of 1M.
	const fullSwa = {
		cells_total: 66_048,
		cells_used: 60_000,
		cells_reserved: 0,
		cells_free: 6_048,
		window: 1_024,
	};

	it("does not grow a filling booking while the SWA half is full, however empty the base", async () => {
		recordPolykvGrantedWindow(SESSION, 98_304, { asked: 262_144 });
		const stub = engine({
			features: OBSERVABLE,
			row: { window: 98_304, used: 90_000 },
			pressure: { ...CLEARED, idle_resident: 0 },
			top: { cells_free: 880_000, cells_total: 1_048_576, swa: fullSwa },
		});
		const { lines } = await boundary(stub.fetch);
		expect(stub.resizes()).toEqual([]);
		expect(lines.some((line) => /SWA half is full/.test(line.message))).toBe(
			true,
		);
		noWarnings(lines);
	});

	it("neither compacts nor shrinks over it: that frees no SWA cell", async () => {
		const stub = engine({
			features: OBSERVABLE,
			row: { window: 262_144, used: 150_000 },
			pressure: { ...CLEARED, idle_resident: 0 },
			top: { cells_free: 880_000, cells_total: 1_048_576, swa: fullSwa },
		});
		const { found } = await boundary(stub.fetch, { messageChars: 600_000 });
		expect(found?.kvPressureCompaction).toBe(false);
		expect(stub.resizes()).toEqual([]);
	});

	it("grows as before below the threshold", async () => {
		recordPolykvGrantedWindow(SESSION, 98_304, { asked: 262_144 });
		const stub = engine({
			features: OBSERVABLE,
			row: { window: 98_304, used: 90_000 },
			pressure: { ...CLEARED, idle_resident: 0 },
			top: {
				cells_free: 880_000,
				cells_total: 1_048_576,
				swa: { ...fullSwa, cells_used: 40_000, cells_free: 26_048 },
			},
		});
		await boundary(stub.fetch);
		expect(stub.resizes().map((call) => call.body?.num_ctx)).toEqual([262_144]);
	});
});
