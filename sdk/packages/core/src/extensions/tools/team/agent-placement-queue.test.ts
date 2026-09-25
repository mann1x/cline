import { describe, expect, it } from "vitest";
import type { AgentNode } from "./agent-placement";
import {
	createAgentPlacementQueue,
	NoAgentCapacityError,
} from "./agent-placement-queue";

const node = (id: string, priority: number, capacity: number): AgentNode => ({
	id,
	priority,
	capacity,
});

/** Lets every already-resolved promise callback run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** An acquire, with whether and where it has landed readable at any time. */
function track(
	queue: ReturnType<typeof createAgentPlacementQueue>,
	signal?: AbortSignal,
) {
	const tracked: {
		nodeId?: string;
		error?: unknown;
		release?: () => void;
	} = {};
	queue.acquire(signal).then(
		(lease) => {
			tracked.nodeId = lease.nodeId;
			tracked.release = lease.release;
		},
		(error) => {
			tracked.error = error;
		},
	);
	return tracked;
}

describe("the agent placement queue", () => {
	it("places at once while any node has room", async () => {
		const queue = createAgentPlacementQueue([node("n1", 1, 2)]);

		const lease = await queue.acquire();

		expect(lease.nodeId).toBe("n1");
		expect(queue.occupancy().get("n1")).toBe(1);
	});

	// §9h: full means wait, not refuse. A swarm larger than total capacity
	// completes more slowly; it does not partly fail.
	it("holds an agent while every tier is full and starts it on the first release", async () => {
		const queue = createAgentPlacementQueue([node("n1", 1, 1)]);
		const first = await queue.acquire();

		const second = track(queue);
		await settle();
		expect(second.nodeId).toBeUndefined();
		expect(queue.waiting).toBe(1);

		first.release();
		await settle();
		expect(second.nodeId).toBe("n1");
		expect(queue.waiting).toBe(0);
	});

	it("drains in spawn order", async () => {
		const queue = createAgentPlacementQueue([node("n1", 1, 1)]);
		const first = await queue.acquire();
		const b = track(queue);
		const c = track(queue);
		const d = track(queue);

		first.release();
		await settle();
		expect([b.nodeId, c.nodeId, d.nodeId]).toEqual([
			"n1",
			undefined,
			undefined,
		]);

		b.release?.();
		await settle();
		expect([c.nodeId, d.nodeId]).toEqual(["n1", undefined]);
	});

	// A slot that frees in the same tick a newcomer arrives belongs to the
	// agent that has been waiting for it.
	it("does not let a newcomer take a slot from a waiter", async () => {
		const queue = createAgentPlacementQueue([node("n1", 1, 1)]);
		const first = await queue.acquire();
		const waiter = track(queue);

		first.release();
		const newcomer = track(queue);
		await settle();

		expect(waiter.nodeId).toBe("n1");
		expect(newcomer.nodeId).toBeUndefined();
		expect(queue.waiting).toBe(1);
	});

	// The live-occupancy rule applied at dequeue: agent 3 has been waiting
	// while tier 2 filled too, and the tier-1 slot that frees is where it goes.
	it("gives a freed tier-1 slot to the head of the queue", async () => {
		const queue = createAgentPlacementQueue([
			node("n1", 1, 1),
			node("n2", 2, 1),
		]);
		const a1 = await queue.acquire();
		const a2 = await queue.acquire();
		expect([a1.nodeId, a2.nodeId]).toEqual(["n1", "n2"]);

		const a3 = track(queue);
		a1.release();
		await settle();

		expect(a3.nodeId).toBe("n1");
	});

	// And the same rule for a newcomer when nobody is waiting: tier 1 first.
	it("sends a new agent back up once a tier-1 slot frees", async () => {
		const queue = createAgentPlacementQueue([
			node("n1", 1, 1),
			node("n2", 2, 2),
		]);
		const a1 = await queue.acquire();
		await queue.acquire();
		a1.release();

		expect((await queue.acquire()).nodeId).toBe("n1");
	});

	// A release that ran twice -- a finally and an error handler both
	// reaching it -- must not hand out a slot nobody freed.
	it("frees a slot once however many times its lease is released", async () => {
		const queue = createAgentPlacementQueue([node("n1", 1, 2)]);
		const a = await queue.acquire();
		await queue.acquire();

		a.release();
		a.release();

		expect(queue.occupancy().get("n1")).toBe(1);
	});

	// A cancelled spawn that stayed in the queue would be handed the next slot
	// and never release it.
	it("drops a waiter that is aborted, and gives its turn to the next one", async () => {
		const queue = createAgentPlacementQueue([node("n1", 1, 1)]);
		const first = await queue.acquire();
		const controller = new AbortController();
		const cancelled = track(queue, controller.signal);
		const next = track(queue);

		controller.abort();
		await settle();
		expect(cancelled.error).toBeDefined();
		expect(queue.waiting).toBe(1);

		first.release();
		await settle();
		expect(next.nodeId).toBe("n1");
		expect(cancelled.nodeId).toBeUndefined();
	});

	it("refuses an acquire whose signal is already aborted", async () => {
		const queue = createAgentPlacementQueue([node("n1", 1, 1)]);
		const controller = new AbortController();
		controller.abort();

		await expect(queue.acquire(controller.signal)).rejects.toBeDefined();
		expect(queue.occupancy().get("n1") ?? 0).toBe(0);
	});

	// "Full" is a state that ends; "no node can ever take an agent" is not.
	// Waiting on the second would hang the spawn for the life of the session.
	it("refuses rather than waits forever when no node has any capacity", async () => {
		const queue = createAgentPlacementQueue([
			node("n1", 1, 0),
			node("n2", 2, 0),
		]);

		await expect(queue.acquire()).rejects.toBeInstanceOf(NoAgentCapacityError);
	});

	// The round-robin cursor survives the queue: dequeued agents still rotate.
	it("keeps round-robin within a tier across queued placements", async () => {
		const queue = createAgentPlacementQueue([
			node("n1", 1, 1),
			node("n2", 1, 1),
		]);
		const a = await queue.acquire();
		const b = await queue.acquire();
		expect([a.nodeId, b.nodeId]).toEqual(["n1", "n2"]);

		a.release();
		b.release();
		const c = await queue.acquire();
		const d = await queue.acquire();
		expect(new Set([c.nodeId, d.nodeId])).toEqual(new Set(["n1", "n2"]));
	});
});

/**
 * `Infinity` is how a node on an endpoint that decides its own admission says
 * "no bound from here" -- an elastic or PolyKV opencoti with the profile's
 * parallel-sessions box left empty, which is what the panel recommends.
 */
describe("a session whose nodes are all uncapped", () => {
	// `Number.isFinite(Infinity)` is false, so the capacity check read the
	// recommended configuration as no capacity at all and rejected every
	// spawn outright.
	it("places agents rather than refusing them all", async () => {
		const queue = createAgentPlacementQueue([
			node("n1", 1, Number.POSITIVE_INFINITY),
			node("n2", 1, Number.POSITIVE_INFINITY),
		]);

		await expect(queue.acquire()).resolves.toMatchObject({ nodeId: "n1" });
		await expect(queue.acquire()).resolves.toMatchObject({ nodeId: "n2" });
	});

	// The distinction the error exists to make is still made: every node at 0
	// is a configuration, not a state that ends.
	it("still refuses when every node is switched off", async () => {
		const queue = createAgentPlacementQueue([node("n1", 1, 0)]);

		await expect(queue.acquire()).rejects.toBeInstanceOf(NoAgentCapacityError);
	});
});

describe("taking an unreachable node out of the rotation", () => {
	it("stops placing on it, and puts it back when the cool-off ends", async () => {
		let now = 1_000;
		const queue = createAgentPlacementQueue(
			[node("dead", 1, 4), node("live", 1, 4)],
			{ now: () => now, schedule: () => {} },
		);

		const first = await queue.acquire();
		expect(first.nodeId).toBe("dead");
		queue.markUnreachable("dead");
		first.release();

		// Every spawn for the next 30 seconds goes to the node that answers,
		// however many there are -- this is the connect timeout per lap that
		// the cool-off exists to stop paying.
		const during = [
			await queue.acquire(),
			await queue.acquire(),
			await queue.acquire(),
		];
		expect(during.map((lease) => lease.nodeId)).toEqual([
			"live",
			"live",
			"live",
		]);

		now += 30_001;

		// And then it is an ordinary member of the rotation again. Asserted as
		// "within a lap" rather than "the very next one": the cursor is a
		// position in the tier, and a node rejoining shifts the positions
		// after it, so which of the two comes first is round-robin's business.
		const after = [await queue.acquire(), await queue.acquire()];
		expect(after.map((lease) => lease.nodeId).sort()).toEqual(["dead", "live"]);
	});

	// A node id nothing knows about would otherwise install a cool-off that
	// nothing could ever clear.
	it("ignores a node it does not have", async () => {
		const queue = createAgentPlacementQueue([node("n1", 1, 1)], {
			schedule: () => {},
		});

		queue.markUnreachable("not-a-node");

		await expect(queue.acquire()).resolves.toMatchObject({ nodeId: "n1" });
	});

	// A node that is down but has room is skipped while a live node is full,
	// so an agent can be queued against capacity that exists and is merely out
	// of favour. When the cool-off lapses, no release happens to notice it --
	// so the cool-off has to announce its own end, or the waiter sits until
	// some unrelated agent finishes.
	it("wakes a waiter when the cool-off it was queued behind ends", async () => {
		let now = 1_000;
		let scheduled: (() => void) | undefined;
		const queue = createAgentPlacementQueue(
			[node("dead", 1, 1), node("live", 1, 1)],
			{
				now: () => now,
				schedule: (fn) => {
					scheduled = fn;
				},
			},
		);

		queue.markUnreachable("dead");
		// The only node in play, and it is taken.
		const onLive = await queue.acquire();
		expect(onLive.nodeId).toBe("live");

		const waiter = track(queue);
		await settle();
		expect(waiter.nodeId).toBeUndefined();

		now += 30_001;
		scheduled?.();
		await settle();

		expect(waiter.nodeId).toBe("dead");
	});
});

/**
 * The sx4bp run (pandorum, 2026-09-23): two uncapped opencoti nodes and an
 * ollama node of capacity 1. The opencoti nodes took all 75 agents at t=0, so
 * the ollama node finished its one in 66 s and got nothing more for the rest
 * of the run -- the other 70 were queued on nodes, inside the engine, instead
 * of here where a free node could take them.
 */
describe("an uncapped node, paced by admission", () => {
	const lease = (queue: ReturnType<typeof createAgentPlacementQueue>) =>
		queue.acquire();

	it("takes one agent, and the next only once the engine admits it", async () => {
		const queue = createAgentPlacementQueue([
			node("oc", 1, Number.POSITIVE_INFINITY),
		]);
		const first = await lease(queue);
		const second = track(queue);
		await settle();
		expect(second.nodeId).toBeUndefined();

		first.admitted();
		await settle();
		expect(second.nodeId).toBe("oc");
		expect(queue.occupancy().get("oc")).toBe(2);
	});

	it("leaves the queue to a capped node that frees while it waits on admission", async () => {
		const queue = createAgentPlacementQueue([
			node("oc", 1, Number.POSITIVE_INFINITY),
			node("ollama", 1, 1),
		]);
		const a = await lease(queue);
		const b = await lease(queue);
		expect([a.nodeId, b.nodeId].sort()).toEqual(["oc", "ollama"]);
		const onOllama = a.nodeId === "ollama" ? a : b;
		const third = track(queue);
		await settle();
		expect(third.nodeId).toBeUndefined();

		// The ollama agent finishes while opencoti's is still unadmitted: the
		// head of the queue goes to the node that has room.
		onOllama.release();
		await settle();
		expect(third.nodeId).toBe("ollama");
	});

	it("holds a node that refused, and reopens it when one of its agents finishes", async () => {
		const queue = createAgentPlacementQueue(
			[node("oc", 1, Number.POSITIVE_INFINITY)],
			{ schedule: () => {} },
		);
		const running = await lease(queue);
		running.admitted();
		const refused = await lease(queue);
		const next = track(queue);
		await settle();

		refused.refused();
		await settle();
		// Held: a refusal describes the engine now, so no one else is sent in
		// behind it.
		expect(next.nodeId).toBeUndefined();

		running.release();
		await settle();
		expect(next.nodeId).toBe("oc");
	});

	it("reopens a refused node when the hold ends, with nothing of ours to finish", async () => {
		let clock = 0;
		const timers: Array<() => void> = [];
		const queue = createAgentPlacementQueue(
			[node("oc", 1, Number.POSITIVE_INFINITY)],
			{ now: () => clock, schedule: (fn) => timers.push(fn) },
		);
		const refused = await lease(queue);
		refused.refused(5_000);
		const next = track(queue);
		await settle();
		expect(next.nodeId).toBeUndefined();

		clock = 5_000;
		for (const fire of timers) fire();
		await settle();
		expect(next.nodeId).toBe("oc");
	});

	it("sends the next agent to another node while a capped node that refused is held", async () => {
		let clock = 0;
		const queue = createAgentPlacementQueue(
			[node("oc", 1, 8), node("ollama", 2, 1)],
			{ now: () => clock, schedule: () => {} },
		);
		const onOc = await queue.acquire();
		expect(onOc.nodeId).toBe("oc");
		onOc.refused(5_000);
		// Room by its count of 8, none by the engine's word: the agent that
		// comes back goes to the node that has not said no.
		const back = await queue.acquire(undefined, { front: true });
		expect(back.nodeId).toBe("ollama");

		clock = 5_000;
		const later = await queue.acquire();
		expect(later.nodeId).toBe("oc");
	});
});

describe("an agent coming back from a failed spawn", () => {
	it("goes to the head of the queue, ahead of agents asked for after it", async () => {
		const queue = createAgentPlacementQueue([node("n1", 1, 1)]);
		const held = await queue.acquire();
		const later = track(queue);
		const order: string[] = [];
		queue
			.acquire(undefined, { front: true })
			.then(() => order.push("returned"));
		await settle();

		held.release();
		await settle();
		expect(order).toEqual(["returned"]);
		expect(later.nodeId).toBeUndefined();
	});
});

/**
 * 1tmrl: the server behind Node1 restarted and was listening again ten
 * seconds later; the node sat out the rest of the 30 s cool-off anyway.
 */
describe("a node in its cool-off", () => {
	function manualClock() {
		let now = 1_000;
		const timers: Array<{ at: number; fn: () => void }> = [];
		return {
			now: () => now,
			schedule: (fn: () => void, ms: number) => {
				timers.push({ at: now + ms, fn });
			},
			/** Move the clock and run what fell due, in order. */
			advance: async (ms: number) => {
				const until = now + ms;
				for (;;) {
					timers.sort((a, b) => a.at - b.at);
					const next = timers[0];
					if (!next || next.at > until) {
						break;
					}
					timers.shift();
					now = next.at;
					next.fn();
					await settle();
				}
				now = until;
			},
		};
	}

	it("is asked every 5 s and put back as soon as its /health answers", async () => {
		const clock = manualClock();
		const probes: number[] = [];
		let up = false;
		const queue = createAgentPlacementQueue([node("oc", 1, 1)], {
			now: clock.now,
			schedule: clock.schedule,
			probe: async () => {
				probes.push(clock.now());
				return up;
			},
		});

		queue.markUnreachable("oc");

		await clock.advance(10_000);
		expect(probes).toEqual([6_000, 11_000]);
		up = true;
		await clock.advance(5_000);
		expect(probes).toEqual([6_000, 11_000, 16_000]);
		// Back: no more probes, well inside the 30 s.
		await clock.advance(30_000);
		expect(probes).toHaveLength(3);
	});

	it("comes back through the probe before the cool-off, where a live node would otherwise win", async () => {
		const clock = manualClock();
		let up = false;
		const queue = createAgentPlacementQueue(
			[node("oc", 1, 4), node("other", 1, 4)],
			{
				now: clock.now,
				schedule: clock.schedule,
				probe: async (id) => id === "oc" && up,
			},
		);

		queue.markUnreachable("oc");
		const during = [await queue.acquire(), await queue.acquire()];
		expect(during.map((lease) => lease.nodeId)).toEqual(["other", "other"]);

		up = true;
		await clock.advance(5_000);
		const after = [await queue.acquire(), await queue.acquire()];
		expect(after.map((lease) => lease.nodeId)).toContain("oc");
	});

	it("keeps 30 s as the upper bound when the node never answers", async () => {
		const clock = manualClock();
		const probes: number[] = [];
		const queue = createAgentPlacementQueue(
			[node("oc", 1, 4), node("other", 1, 4)],
			{
				now: clock.now,
				schedule: clock.schedule,
				probe: async () => {
					probes.push(clock.now());
					return false;
				},
			},
		);

		queue.markUnreachable("oc");
		await clock.advance(30_001);
		expect(probes.length).toBeGreaterThanOrEqual(5);
		expect(probes.length).toBeLessThanOrEqual(6);
		const after = [await queue.acquire(), await queue.acquire()];
		expect(after.map((lease) => lease.nodeId).sort()).toEqual(["oc", "other"]);
		await clock.advance(60_000);
		expect(probes.length).toBeLessThanOrEqual(6);
	});

	it("is not probed out of a missing-model cool-off: /health says nothing about a model", async () => {
		const clock = manualClock();
		let probes = 0;
		const queue = createAgentPlacementQueue([node("oc", 1, 4)], {
			now: clock.now,
			schedule: clock.schedule,
			probe: async () => {
				probes += 1;
				return true;
			},
		});

		queue.markUnreachable("oc", 600_000);
		await clock.advance(60_000);
		expect(probes).toBe(0);
	});
});
