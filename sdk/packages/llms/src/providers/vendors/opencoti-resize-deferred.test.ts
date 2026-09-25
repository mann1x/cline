import { beforeEach, describe, expect, it } from "vitest";
import {
	opencotiPendingResize,
	readOpencotiKv,
	resetOpencotiPendingResizes,
	resizeOpencotiSession,
} from "./opencoti-kv-pressure";
import { parseOpencotiAllocations, resetPolykvAvailability } from "./polykv";

/**
 * A resize a busy session cannot take now is queued for its idle moment
 * (`kv_resize_deferred_v1`, opencoti b110, mail #306): `{num_ctx, deferred:
 * true}` answers 202 and the `/kv` row carries `resize_pending`.
 */

function json(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	resetPolykvAvailability();
	resetOpencotiPendingResizes();
});

describe("a deferred resize", () => {
	it("is asked for with deferred:true, and a 202 reads as queued, not applied", async () => {
		const sent: Array<Record<string, unknown>> = [];
		const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
			sent.push(JSON.parse(String(init?.body)));
			return json(
				{
					session_id: "g~polykv-owner-1",
					found: true,
					ok: true,
					deferred: true,
					status: 202,
					window: 65_536,
					cells: 65_536,
					used: 44_000,
					resize_pending: 67_328,
					active: 3,
					pending: 0,
				},
				202,
			);
		}) as unknown as typeof fetch;
		const result = await resizeOpencotiSession({
			baseUrl: "http://engine/v1",
			sessionId: "g~polykv-owner-1",
			numCtx: 67_328,
			deferred: true,
			fetch: fetchImpl,
		});
		expect(sent).toEqual([
			{ session_id: "g~polykv-owner-1", num_ctx: 67_328, deferred: true },
		]);
		expect(result).toMatchObject({
			ok: false,
			status: 202,
			kind: "deferred",
			pending: 67_328,
		});
		expect(opencotiPendingResize("http://engine/v1", "g~polykv-owner-1")).toBe(
			67_328,
		);
	});

	it("that asked for the current window cancels what was pending", async () => {
		const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			return body.num_ctx === 65_536
				? json({
						ok: true,
						deferred: false,
						window: 65_536,
						window_new: 65_536,
						cells_delta: 0,
						resize_pending: null,
					})
				: json({ ok: true, deferred: true, resize_pending: 67_328 }, 202);
		}) as unknown as typeof fetch;
		const base = {
			baseUrl: "http://engine/v1",
			sessionId: "g~polykv-owner-1",
			deferred: true,
			fetch: fetchImpl,
		};
		await resizeOpencotiSession({ ...base, numCtx: 67_328 });
		expect(opencotiPendingResize(base.baseUrl, base.sessionId)).toBe(67_328);
		await resizeOpencotiSession({ ...base, numCtx: 65_536 });
		expect(opencotiPendingResize(base.baseUrl, base.sessionId)).toBeUndefined();
	});
});

describe("what is pending, off GET /kv", () => {
	it("is read off each allocation row", () => {
		const rows = parseOpencotiAllocations({
			allocations: [
				{
					session_id: "g~polykv-owner-1",
					window: 65_536,
					used: 60_000,
					resize_pending: 49_152,
					resize_pending_s: 3.5,
					resize_pending_reason: "used_exceeds_window",
				},
				{
					session_id: "g~polykv-owner-2",
					window: 65_536,
					used: 1_000,
					resize_pending: null,
					resize_pending_reason: null,
				},
			],
		});
		expect(rows[0]).toMatchObject({
			resizePending: 49_152,
			resizePendingReason: "used_exceeds_window",
		});
		expect(rows[1]?.resizePending).toBeUndefined();
		expect(rows[1]?.resizePendingReason).toBeUndefined();
	});

	it("is what the client knows is queued: a row without one forgets it", async () => {
		let pending: number | null = 49_152;
		const fetchImpl = (async (input: unknown) => {
			const url = new URL(String(input));
			if (url.pathname === "/props") {
				return json({
					features: ["kv_status_v1", "kv_resize_v1", "kv_resize_deferred_v1"],
				});
			}
			return json({
				allocations: [
					{
						session_id: "g~polykv-owner-1",
						window: 65_536,
						used: 1_000,
						resize_pending: pending,
					},
				],
			});
		}) as unknown as typeof fetch;
		await readOpencotiKv("http://engine/v1", fetchImpl);
		expect(opencotiPendingResize("http://engine/v1", "g~polykv-owner-1")).toBe(
			49_152,
		);
		pending = null;
		await readOpencotiKv("http://engine/v1", fetchImpl);
		expect(
			opencotiPendingResize("http://engine/v1", "g~polykv-owner-1"),
		).toBeUndefined();
	});
});
