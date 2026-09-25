import { describe, expect, it, vi } from "vitest";

const listeners = new Map<
	string,
	(state: { waiting: boolean; reason?: string }) => void
>();
const noticeListeners = new Map<
	string,
	(notice: { severity: string; text: string }) => void
>();
const phaseListeners = new Map<string, (phase: unknown) => void>();
vi.mock("@cline/llms", () => ({
	describeOpencotiStreamPhase: (phase: {
		kind: string;
		processed?: number;
		total?: number;
	}) =>
		phase.kind === "prefill"
			? `Prefilling ${phase.processed} / ${phase.total}`
			: `phase ${phase.kind}`,
	onPolykvStreamPhase: (id: string, listener: (phase: unknown) => void) => {
		phaseListeners.set(id, listener);
		return () => phaseListeners.delete(id);
	},
	onPolykvNotice: (
		id: string,
		listener: (notice: { severity: string; text: string }) => void,
	) => {
		noticeListeners.set(id, listener);
		return () => noticeListeners.delete(id);
	},
	onPolykvRoomWait: (
		id: string,
		listener: (state: { waiting: boolean; reason?: string }) => void,
	) => {
		listeners.set(id, listener);
		return () => listeners.delete(id);
	},
}));

import { watchPolykvRoom } from "./subagent-progress";

describe("watchPolykvRoom", () => {
	it("turns a wait for room into queued, and its end into running", () => {
		const emitUpdate = vi.fn();
		const stop = watchPolykvRoom("s1", emitUpdate);

		listeners.get("s1")?.({
			waiting: true,
			reason: "Waiting for room on the server.",
		});
		listeners.get("s1")?.({ waiting: false });

		expect(emitUpdate.mock.calls).toEqual([
			[
				{
					queued: true,
					latestOutput: "Waiting for room on the server.",
					latestOutputKind: "text",
					activity: { text: "Waiting for room on the server." },
				},
			],
			[{ queued: false }],
		]);
		stop();
		expect(listeners.has("s1")).toBe(false);
	});

	it("puts the engine's warnings on the row's activity, and stops with it", () => {
		const emitUpdate = vi.fn();
		const stop = watchPolykvRoom("s3", emitUpdate);

		noticeListeners.get("s3")?.({
			severity: "warn",
			text: "Pool 5 shared only 4 of its 5,627 tokens",
		});

		expect(emitUpdate).toHaveBeenCalledWith({
			activity: {
				text: "Pool 5 shared only 4 of its 5,627 tokens",
				severity: "warn",
			},
		});
		stop();
		expect(noticeListeners.has("s3")).toBe(false);
	});

	// A priority-0 agent that lost its sub-pool was prefilled in full. The row
	// scrolls away; the log keeps it, at warn.
	it("logs the engine's warnings at warn, and only those", () => {
		const log = vi.fn();
		const stop = watchPolykvRoom("s3", vi.fn(), { log });

		noticeListeners.get("s3")?.({ severity: "info", text: "fine" });
		noticeListeners.get("s3")?.({
			severity: "warn",
			text: "No X-Context-Window on this turn",
		});
		stop();

		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith(
			"[PolyKV] s3: No X-Context-Window on this turn",
			{ severity: "warn" },
		);
	});

	it("watches nothing without a session or a row to update", () => {
		watchPolykvRoom(undefined, vi.fn())();
		watchPolykvRoom("s2", undefined)();
		expect(listeners.has("s2")).toBe(false);
	});

	// patch 0388's heartbeat names the phase of a silent stream. It goes on
	// the row's current line, in place, and never on the activity log.
	it("shows the server phase of a silent stream in place, then gives the line back", () => {
		const emitUpdate = vi.fn();
		const stop = watchPolykvRoom("s9", emitUpdate);
		phaseListeners.get("s9")?.({ kind: "queued" });
		phaseListeners.get("s9")?.({
			kind: "prefill",
			processed: 20_481,
			total: 41_533,
		});
		phaseListeners.get("s9")?.(undefined);
		phaseListeners.get("s9")?.(undefined);
		expect(emitUpdate.mock.calls).toEqual([
			[{ latestOutput: "phase queued", latestOutputKind: "text" }],
			[{ latestOutput: "Prefilling 20481 / 41533", latestOutputKind: "text" }],
			[{ latestOutput: "" }],
		]);
		for (const [update] of emitUpdate.mock.calls) {
			expect(update).not.toHaveProperty("activity");
		}
		stop();
		expect(phaseListeners.has("s9")).toBe(false);
	});
});
