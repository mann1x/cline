import { describe, expect, it, vi } from "vitest";

const listeners = new Map<
	string,
	(state: { waiting: boolean; reason?: string }) => void
>();
vi.mock("@cline/llms", () => ({
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
				},
			],
			[{ queued: false }],
		]);
		stop();
		expect(listeners.has("s1")).toBe(false);
	});

	it("watches nothing without a session or a row to update", () => {
		watchPolykvRoom(undefined, vi.fn())();
		watchPolykvRoom("s2", undefined)();
		expect(listeners.has("s2")).toBe(false);
	});
});
