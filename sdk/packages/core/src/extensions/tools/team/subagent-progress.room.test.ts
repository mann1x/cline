import { describe, expect, it, vi } from "vitest";

const listeners = new Map<
	string,
	(state: { waiting: boolean; reason?: string }) => void
>();
const noticeListeners = new Map<
	string,
	(notice: { severity: string; text: string }) => void
>();
vi.mock("@cline/llms", () => ({
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

	it("watches nothing without a session or a row to update", () => {
		watchPolykvRoom(undefined, vi.fn())();
		watchPolykvRoom("s2", undefined)();
		expect(listeners.has("s2")).toBe(false);
	});
});
