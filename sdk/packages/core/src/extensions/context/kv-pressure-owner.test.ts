import type * as LlmsProviders from "@cline/llms";
import {
	getPolykvGrantedWindow,
	recordOpencotiWindowCeiling,
	recordOpencotiWindowFloor,
	recordPolykvGrantedWindow,
	resetOpencotiPressure,
	resetOpencotiWindowCeilings,
	resetOpencotiWindowFloors,
	resetPolykvAvailability,
	resetPolykvSessions,
} from "@cline/llms";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	beginKvPressureTurn,
	resetKvPressureState,
	shrinkForKvPressure,
} from "./kv-pressure";
import { clearPolykvAllocationCache } from "./polykv-session";

/**
 * Where a pooled agent's usage lands is its owner's booking, and only the
 * owner resizes -- and only an owner this process opened: the lead's own
 * session lent to priority-0 agents is the lead's to resize.
 */
const charged = vi.hoisted(() => ({
	owner: undefined as string | undefined,
	bounds: undefined as { floor: number; ceiling: number } | undefined,
}));

vi.mock("@cline/llms", async (importOriginal) => {
	const actual = await importOriginal<typeof LlmsProviders>();
	return {
		...actual,
		polykvWorkerChargedTo: () => charged.owner,
		polykvOwnerWindowBounds: (owner: string) =>
			owner === charged.owner ? charged.bounds : undefined,
	};
});

const WORKER = "lead~agent-w";
const OWNER = "lead~polykv-owner-1";
const LEAD = "lead";

function engine(
	rows: Array<{ id: string; window: number; used: number }>,
	pressure: Record<string, unknown> = {
		window_s: 60,
		refused_60s: 2,
		last_refusal_age_s: 1,
	},
) {
	const resizes: Array<{ path: string; body: Record<string, unknown> }> = [];
	const fetchImpl = (async (input: unknown, init?: RequestInit) => {
		const url = new URL(String(input));
		const json = (value: unknown) =>
			new Response(JSON.stringify(value), {
				headers: { "content-type": "application/json" },
			});
		if (url.pathname === "/props") {
			return json({
				features: ["kv_status_v1", "kv_pressure_v1", "kv_resize_v1"],
			});
		}
		if (url.pathname === "/kv") {
			return json({
				allocations: rows.map((row) => ({
					session_id: row.id,
					window: row.window,
					used: row.used,
				})),
				pressure,
			});
		}
		if (url.pathname.endsWith("/resize")) {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			resizes.push({ path: url.pathname, body });
			return json({ ok: true, window: 262_144, window_new: body.num_ctx });
		}
		return new Response("{}", { status: 404 });
	}) as unknown as typeof fetch;
	return { fetch: fetchImpl, resizes };
}

const workerConfig = (fetchImpl: typeof fetch) => ({
	providerId: "opencoti",
	baseUrl: "http://engine/v1",
	fetch: fetchImpl,
	polykvWorker: { group: LEAD, layers: 2 },
});

beforeEach(() => {
	resetPolykvSessions();
	resetPolykvAvailability();
	resetOpencotiPressure();
	resetOpencotiWindowFloors();
	resetOpencotiWindowCeilings();
	resetKvPressureState();
	clearPolykvAllocationCache();
	charged.owner = undefined;
	charged.bounds = undefined;
});

describe("a pooled agent under pressure", () => {
	it("shrinks its owner, not itself, never below the owner's floor", async () => {
		charged.owner = OWNER;
		charged.bounds = { floor: 32_768, ceiling: 262_144 };
		// Its own floor is irrelevant: the booking is the owner's.
		recordOpencotiWindowFloor(WORKER, 200_000);
		const stub = engine([
			{ id: OWNER, window: 262_144, used: 8_000 },
			{ id: WORKER, window: 262_144, used: 8_000 },
		]);
		const turn = await beginKvPressureTurn({
			sessionId: WORKER,
			providerConfig: workerConfig(stub.fetch),
		});
		expect(turn?.subject).toMatchObject({
			kind: "owner",
			engineId: OWNER,
			floor: 32_768,
			ceiling: 262_144,
		});
		await shrinkForKvPressure(turn, {
			usageTokens: 8_000,
			outputRoomTokens: 8_192,
			afterCompaction: false,
		});
		expect(stub.resizes).toEqual([
			{
				path: "/sessions/resize",
				body: { session_id: OWNER, num_ctx: 32_768 },
			},
		]);
		// The agent's own grant follows: its window is the owner's.
		expect(getPolykvGrantedWindow(WORKER)).toBe(32_768);
	});

	it("leaves the lead's lent session to the lead", async () => {
		charged.owner = LEAD;
		charged.bounds = undefined;
		recordPolykvGrantedWindow(WORKER, 262_144, { asked: 262_144 });
		recordOpencotiWindowFloor(WORKER, 1_000);
		const stub = engine([{ id: LEAD, window: 262_144, used: 8_000 }]);
		const turn = await beginKvPressureTurn({
			sessionId: WORKER,
			providerConfig: workerConfig(stub.fetch),
		});
		expect(turn).toBeUndefined();
		expect(stub.resizes).toEqual([]);
	});

	it("resizes its own booking when its turns go out unpooled", async () => {
		charged.owner = undefined;
		recordOpencotiWindowFloor(WORKER, 50_000);
		const stub = engine([{ id: WORKER, window: 262_144, used: 8_000 }]);
		const turn = await beginKvPressureTurn({
			sessionId: WORKER,
			providerConfig: workerConfig(stub.fetch),
		});
		expect(turn?.subject).toMatchObject({
			kind: "own",
			engineId: WORKER,
			floor: 50_000,
		});
		await shrinkForKvPressure(turn, {
			usageTokens: 8_000,
			outputRoomTokens: 8_192,
			afterCompaction: false,
		});
		expect(stub.resizes[0]?.body).toEqual({
			session_id: WORKER,
			num_ctx: Math.ceil(50_000 / 256) * 256,
		});
	});

	it("grows back to the node window after leaving the pool", async () => {
		charged.owner = undefined;
		// Its first grant was its owner's, with no ask of its own; the fetch
		// recorded the node window when it went out on its own.
		recordPolykvGrantedWindow(WORKER, 98_304);
		recordOpencotiWindowCeiling(WORKER, 131_072);
		recordOpencotiWindowFloor(WORKER, 50_000);
		const stub = engine([{ id: WORKER, window: 98_304, used: 90_000 }], {
			window_s: 60,
			refused_60s: 0,
			last_refusal_age_s: 600,
		});
		const turn = await beginKvPressureTurn({
			sessionId: WORKER,
			providerConfig: workerConfig(stub.fetch),
		});
		expect(turn?.subject).toMatchObject({ kind: "own", ceiling: 131_072 });
		expect(stub.resizes).toEqual([
			{
				path: "/sessions/resize",
				body: { session_id: WORKER, num_ctx: 131_072 },
			},
		]);
		expect(getPolykvGrantedWindow(WORKER)).toBe(131_072);
	});
});
