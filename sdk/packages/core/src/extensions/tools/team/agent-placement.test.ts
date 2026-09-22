import { describe, expect, it } from "vitest";
import {
	type AgentNode,
	emptyPlacementState,
	type PlacementState,
	placeAgent,
} from "./agent-placement";

/**
 * Spawn `count` agents in sequence, holding on to whatever each one took.
 *
 * Occupancy is recomputed from what is actually held rather than counted up,
 * because that is the ruling: a tier is full when its nodes have no free slot
 * *right now*, not when some number of agents have been spawned into it.
 */
function spawn(
	nodes: readonly AgentNode[],
	count: number,
	options: { release?: Record<number, string> } = {},
) {
	const held = new Map<string, number>();
	const queued: number[] = [];
	const order: string[] = [];
	let state: PlacementState = emptyPlacementState();

	for (let index = 1; index <= count; index += 1) {
		// A slot freed before this spawn, which is what makes the choice live.
		const freed = options.release?.[index];
		if (freed) {
			held.set(freed, Math.max(0, (held.get(freed) ?? 0) - 1));
		}
		const result = placeAgent({ nodes, occupancy: held, state });
		state = result.state;
		if (result.placement.kind === "queued") {
			queued.push(index);
			order.push("queued");
			continue;
		}
		const nodeId = result.placement.nodeId;
		held.set(nodeId, (held.get(nodeId) ?? 0) + 1);
		order.push(nodeId);
	}
	return { order, queued, held };
}

const tier = (id: string, priority: number, capacity: number): AgentNode => ({
	id,
	priority,
	capacity,
});

describe("placing an agent across priority tiers", () => {
	// The user's first worked example, verbatim: N1 and N2 at priority 1 with
	// five slots each take agents 1-10, round-robin.
	it("fills a tier round-robin before touching the next one", () => {
		const nodes = [
			tier("N1", 1, 5),
			tier("N2", 1, 5),
			tier("N3", 2, 5),
			tier("N4", 2, 5),
		];

		const { order } = spawn(nodes, 10);

		expect(order).toEqual([
			"N1",
			"N2",
			"N1",
			"N2",
			"N1",
			"N2",
			"N1",
			"N2",
			"N1",
			"N2",
		]);
	});

	// The second half of the same example: 11-20 spread over the next tier.
	it("overflows to the next tier only once the first has no room", () => {
		const nodes = [
			tier("N1", 1, 5),
			tier("N2", 1, 5),
			tier("N3", 2, 5),
			tier("N4", 2, 5),
		];

		const { order } = spawn(nodes, 20);

		expect(order.slice(10)).toEqual([
			"N3",
			"N4",
			"N3",
			"N4",
			"N3",
			"N4",
			"N3",
			"N4",
			"N3",
			"N4",
		]);
	});

	// The user's variation: move N4 down a tier and the overflow stops being
	// shared — 11-15 all go to N3, and only then does N4 see anything.
	it("keeps a third tier untouched while the second still has room", () => {
		const nodes = [
			tier("N1", 1, 5),
			tier("N2", 1, 5),
			tier("N3", 2, 5),
			tier("N4", 3, 5),
		];

		const { order } = spawn(nodes, 20);

		expect(order.slice(10, 15)).toEqual(["N3", "N3", "N3", "N3", "N3"]);
		expect(order.slice(15)).toEqual(["N4", "N4", "N4", "N4", "N4"]);
	});

	/**
	 * The ruling that a spawn counter cannot express.
	 *
	 * Tier 1 is full at spawn 11, so 11 goes to tier 2. Before spawn 12 a
	 * tier-1 agent finishes — and 12 must go back up to it. A counter that
	 * remembered "we have moved on to tier 2" would leave that slot idle for
	 * the rest of the run, which is the opposite of "overflow only if
	 * necessary".
	 */
	it("takes a freed higher-tier slot back from the tier below", () => {
		const nodes = [tier("N1", 1, 5), tier("N2", 1, 5), tier("N3", 2, 5)];

		const { order } = spawn(nodes, 12, { release: { 12: "N1" } });

		expect(order[10]).toBe("N3");
		expect(order[11]).toBe("N1");
	});

	// Priority 0 is the PolyKV lead session: sub-pools of the conversation's
	// own window, used before any configured node.
	it("prefers priority 0 over every configured node", () => {
		const nodes = [tier("lead", 0, 2), tier("N1", 1, 5)];

		const { order } = spawn(nodes, 3);

		expect(order).toEqual(["lead", "lead", "N1"]);
	});

	// A node at capacity is skipped inside its own tier rather than blocking
	// it, and the cursor lands on whoever actually took the agent.
	it("skips a full node without leaving its tier", () => {
		const nodes = [tier("N1", 1, 1), tier("N2", 1, 5)];

		const { order } = spawn(nodes, 4);

		expect(order).toEqual(["N1", "N2", "N2", "N2"]);
	});

	// Everything full means wait, not fail. A swarm larger than total capacity
	// still completes, just more slowly — refusing would make a swarm of 30
	// against 20 slots partly fail for no reason.
	it("queues when no tier has room at all", () => {
		const nodes = [tier("N1", 1, 2)];

		const { order, queued } = spawn(nodes, 4);

		expect(order).toEqual(["N1", "N1", "queued", "queued"]);
		expect(queued).toEqual([3, 4]);
	});

	it("queues when there are no nodes to place on", () => {
		const { placement } = placeAgent({
			nodes: [],
			occupancy: new Map(),
			state: emptyPlacementState(),
		});

		expect(placement.kind).toBe("queued");
	});

	// A node configured with no capacity is not a node with room; it is a node
	// that can never take anything, and treating 0 as "unbounded" would send
	// every agent to the one node the user turned off.
	it("never places on a node with no capacity", () => {
		const nodes = [tier("off", 1, 0), tier("N1", 2, 1)];

		const { order } = spawn(nodes, 2);

		expect(order).toEqual(["N1", "queued"]);
	});

	// Tiers are ordered by their number, not by the order the nodes happen to
	// be configured in.
	it("reads priority as a rank, not as configuration order", () => {
		const nodes = [tier("slow", 9, 5), tier("fast", 1, 5)];

		const { order } = spawn(nodes, 2);

		expect(order).toEqual(["fast", "fast"]);
	});
});

describe("the round-robin cursor", () => {
	// Each tier keeps its own cursor: advancing in tier 2 must not skip a node
	// in tier 1 the next time tier 1 has room.
	it("is kept per tier, not shared across them", () => {
		const nodes = [tier("N1", 1, 1), tier("N2", 1, 1), tier("N3", 2, 5)];

		// Fills N1, N2, then two into tier 2 — and N1 frees before spawn 5.
		const { order } = spawn(nodes, 5, { release: { 5: "N1" } });

		expect(order.slice(0, 2)).toEqual(["N1", "N2"]);
		expect(order.slice(2, 4)).toEqual(["N3", "N3"]);
		// Back to tier 1, and to the node that actually has the room.
		expect(order[4]).toBe("N1");
	});

	it("starts anywhere and still covers every node in the tier", () => {
		const nodes = [tier("N1", 1, 3), tier("N2", 1, 3), tier("N3", 1, 3)];

		const { held } = spawn(nodes, 9);

		expect(held.get("N1")).toBe(3);
		expect(held.get("N2")).toBe(3);
		expect(held.get("N3")).toBe(3);
	});
});
