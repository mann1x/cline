import { describe, expect, it, vi } from "vitest";
import {
	type AdmissionCapacity,
	admissionFromCapacity,
	createAgentAdmissionController,
} from "./agent-admission";

function capacityOf(
	overrides: Partial<AdmissionCapacity> = {},
): AdmissionCapacity {
	return {
		canAdmit: true,
		headroomSessions: 4,
		reason: "ok",
		...overrides,
	};
}

/** A controller whose waits resolve instantly, so a test does not sleep. */
function controllerOf(
	capacity: () => Promise<AdmissionCapacity | undefined>,
	options: Partial<Parameters<typeof createAgentAdmissionController>[0]> = {},
) {
	return createAgentAdmissionController({
		capacity,
		sleep: async () => {},
		...options,
	});
}

describe("the PolyKV admission controller", () => {
	// c7 folds the settle and bias EWMAs on EVERY `GET /capacity`, so a client
	// that polls it corrupts the learner it is asking. One read bounds the
	// round; the agents it admits draw from that one answer.
	it("reads capacity once for a whole round", async () => {
		const capacity = vi.fn(async () => capacityOf({ headroomSessions: 3 }));
		const controller = controllerOf(capacity);

		await controller.acquire();
		await controller.acquire();
		await controller.acquire();

		expect(capacity).toHaveBeenCalledTimes(1);
	});

	// FS-H1's contract: `headroom_sessions` caps the round. The fourth agent is
	// HELD, not failed -- it runs when one of the three finishes.
	it("admits the headroom and holds the remainder", async () => {
		const capacity = vi.fn(async () => capacityOf({ headroomSessions: 2 }));
		const controller = controllerOf(capacity);

		await controller.acquire();
		await controller.acquire();

		const third = vi.fn();
		const held = controller.acquire().then(third);
		await Promise.resolve();
		expect(third).not.toHaveBeenCalled();

		controller.release();
		await held;
		expect(third).toHaveBeenCalled();
	});

	// A hard reject holds the whole round rather than failing it: the engine is
	// describing this moment, and the agents have not started, so there is
	// nothing to fail.
	it("holds everything on a hard reject, and starts once it clears", async () => {
		const capacity = vi
			.fn()
			.mockResolvedValueOnce(
				capacityOf({
					canAdmit: false,
					headroomSessions: 0,
					reason: "kv headroom exhausted",
				}),
			)
			.mockResolvedValue(capacityOf({ headroomSessions: 1 }));
		const controller = controllerOf(capacity);

		const admitted = vi.fn();
		const pending = controller.acquire().then(admitted);
		await Promise.resolve();
		expect(admitted).not.toHaveBeenCalled();

		await pending;
		expect(capacity).toHaveBeenCalledTimes(2);
	});

	// `-1` is the engine saying it has no measurement yet, not "no room".
	// Clamping it to zero told an empty server it was full (T9).
	it("does not read an uncomputable headroom as none", async () => {
		const capacity = vi.fn(async () => capacityOf({ headroomSessions: -1 }));
		const controller = controllerOf(capacity);

		await controller.acquire();
		await controller.acquire();
		await controller.acquire();

		expect(capacity).toHaveBeenCalledTimes(1);
	});

	// A server that cannot answer is not a server that said no. c7's gate
	// admits with a warning when its own capacity check fails, and holding
	// every agent on an unreachable control plane would be worse than the
	// 429 this exists to avoid.
	it("admits when capacity cannot be read at all", async () => {
		const capacity = vi.fn(async () => undefined);
		const controller = controllerOf(capacity);

		await expect(controller.acquire()).resolves.toBeDefined();
		await controller.acquire();
		expect(capacity).toHaveBeenCalledTimes(1);
	});

	it("admits when the capacity read throws", async () => {
		const controller = controllerOf(async () => {
			throw new Error("ECONNREFUSED");
		});
		await expect(controller.acquire()).resolves.toBeDefined();
	});

	// The engine keeps `elastic_reason` distinct from `kv headroom exhausted`
	// so a caller can tell "raise --max-parallel" from "this context does not
	// fit". Collapsing them into one word throws that away.
	it("carries the engine's own reason back verbatim", async () => {
		const controller = controllerOf(async () =>
			capacityOf({ reason: "saturated, hold" }),
		);
		expect((await controller.acquire()).reason).toBe("saturated, hold");
	});

	// A round that is full re-asks rather than drawing from a stale answer:
	// the agents that emptied it have changed the very thing being measured.
	it("re-reads capacity for the next round", async () => {
		const capacity = vi.fn(async () => capacityOf({ headroomSessions: 1 }));
		const controller = controllerOf(capacity);

		await controller.acquire();
		const second = controller.acquire();
		await Promise.resolve();
		controller.release();
		await second;

		expect(capacity).toHaveBeenCalledTimes(2);
	});

	it("stops waiting when the run is cancelled", async () => {
		const abort = new AbortController();
		const controller = controllerOf(async () =>
			capacityOf({ canAdmit: false, headroomSessions: 0, reason: "saturated" }),
		);

		const pending = controller.acquire(abort.signal);
		abort.abort();
		await expect(pending).rejects.toThrow(/cancel/i);
	});
});

describe("reading a capacity payload into an admission answer", () => {
	it("takes the three terms it acts on", () => {
		expect(
			admissionFromCapacity({
				can_admit: true,
				headroom_sessions: 3,
				reason: "ok",
				compaction_pressure: 0.4,
			}),
		).toEqual({ canAdmit: true, headroomSessions: 3, reason: "ok" });
	});

	// The engine omits `headroom_sessions` rather than guessing when it has no
	// measurement, and `-1` means the same thing. Both have to reach the
	// controller as "unbounded by this signal", never as zero.
	it("reads a missing headroom as uncomputable, not as none", () => {
		expect(admissionFromCapacity({ can_admit: true })?.headroomSessions).toBe(
			-1,
		);
	});

	// `can_admit` absent is the engine not gating, which is the case on a pool
	// with an advisory policy. Reading it as a refusal would hold every agent
	// on a server that never says no.
	it("reads a missing can_admit as yes", () => {
		expect(admissionFromCapacity({})?.canAdmit).toBe(true);
	});

	it("says nothing when there was no answer", () => {
		expect(admissionFromCapacity(undefined)).toBeUndefined();
	});
});
