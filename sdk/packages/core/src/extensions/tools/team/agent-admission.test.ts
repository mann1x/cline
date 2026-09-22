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

/**
 * The non-blocking probe a supervisor loop needs.
 *
 * `acquire()` **holds** when there is no room, which is right for one agent
 * waiting its turn and wrong for a tick: a supervisor that re-checks every few
 * seconds must get an answer, not a wait, or the first refusal stalls the loop
 * that was supposed to keep asking.
 *
 * The part that takes care is how often it may read. On c7 every
 * `GET /capacity` folds the engine's settle and bias EWMAs, so a 5-second tick
 * that reached the wire would fold the learner twelve times a minute for the
 * life of the swarm — corrupting the measurement it is reading. The rule is
 * therefore not "read on a timer" but **read only when the answer could have
 * changed**, and the only thing that changes it is an agent finishing.
 */
describe("probing without holding", () => {
	it("hands out the round it already has without asking again", async () => {
		const capacity = vi.fn(async () => capacityOf({ headroomSessions: 3 }));
		const controller = controllerOf(capacity);

		expect(await controller.tryAcquire()).toBeDefined();
		expect(await controller.tryAcquire()).toBeDefined();
		expect(await controller.tryAcquire()).toBeDefined();

		expect(capacity).toHaveBeenCalledTimes(1);
	});

	// The difference from `acquire()`, in one line: it comes back.
	it("answers rather than waiting when the round is spent", async () => {
		const capacity = vi.fn(async () => capacityOf({ headroomSessions: 1 }));
		const controller = controllerOf(capacity);

		expect(await controller.tryAcquire()).toBeDefined();
		expect(await controller.tryAcquire()).toBeUndefined();
	});

	// The constraint that shapes the whole design. A tick that finds no room
	// must not ask the engine again on the next tick: nothing has happened in
	// between that could change the answer, and asking is not free.
	it("does not re-read while nothing has finished", async () => {
		const capacity = vi.fn(async () => capacityOf({ headroomSessions: 1 }));
		const controller = controllerOf(capacity);

		await controller.tryAcquire();
		for (let tick = 0; tick < 12; tick += 1) {
			expect(await controller.tryAcquire()).toBeUndefined();
		}

		// One read for the round, and not one per tick.
		expect(capacity).toHaveBeenCalledTimes(1);
	});

	// And the other half: an agent finishing IS the thing that changes it, so
	// the next tick may ask. This is what makes the loop pick up slots that
	// freed while it was waiting.
	it("re-reads once an agent has finished", async () => {
		const capacity = vi.fn(async () => capacityOf({ headroomSessions: 1 }));
		const controller = controllerOf(capacity);

		await controller.tryAcquire();
		expect(await controller.tryAcquire()).toBeUndefined();

		controller.release();

		expect(await controller.tryAcquire()).toBeDefined();
		expect(capacity).toHaveBeenCalledTimes(2);
	});

	// One release means one re-read, not a licence to poll from then on.
	it("spends the re-read it was given", async () => {
		const capacity = vi.fn(async () => capacityOf({ canAdmit: false }));
		const controller = controllerOf(capacity);

		await controller.tryAcquire();
		controller.release();
		await controller.tryAcquire();
		await controller.tryAcquire();
		await controller.tryAcquire();

		// The first call read; the release bought exactly one more.
		expect(capacity).toHaveBeenCalledTimes(2);
	});

	// A held round refuses here rather than waiting it out, because the
	// supervisor's job is to come back later, not to block on this answer.
	it("refuses rather than holding when the engine says no", async () => {
		const controller = controllerOf(async () =>
			capacityOf({ canAdmit: false }),
		);

		expect(await controller.tryAcquire()).toBeUndefined();
	});

	// A control plane that cannot be reached has not said no — the same
	// reading `acquire()` takes, for the same reason.
	it("admits when capacity cannot be read at all", async () => {
		const controller = controllerOf(async () => undefined);

		expect(await controller.tryAcquire()).toBeDefined();
	});

	// The two paths share one round, so a probe must not hand out a slot an
	// awaited acquire is already holding.
	it("draws from the same round as acquire", async () => {
		const capacity = vi.fn(async () => capacityOf({ headroomSessions: 2 }));
		const controller = controllerOf(capacity);

		await controller.acquire();
		expect(await controller.tryAcquire()).toBeDefined();
		expect(await controller.tryAcquire()).toBeUndefined();
		expect(capacity).toHaveBeenCalledTimes(1);
	});
});
