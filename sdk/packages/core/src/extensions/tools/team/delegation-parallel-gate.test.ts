import { describe, expect, it } from "vitest";
import {
	agentNodesAllowParallelDelegation,
	delegationCanRunInParallel,
	slotsAllowParallelDelegation,
} from "./agent-slot-gate";

// Measured on a live run: two agent nodes configured on one opencoti, each
// serving one request, and `spawn_agent` plus the team tools were withheld
// anyway. The host log said why —
//
//   [Agents] 2 nodes: primary(p1, 1), node-mucuczcm(p1, 1)
//   [Agents] Concurrency: 1 - ... this profile caps delegation at 1
//   [Agents] spawn_agent and the team tools are withheld: this endpoint
//            serves 1 request at a time
//
// — and the model, left with no way to delegate, reached for `create_agent`,
// which writes an agent definition file and runs nothing. Two nodes serving
// one request each serve two at once; the question was being asked of one
// endpoint.

describe("whether delegated agents can run beside one another", () => {
	it("still answers from the endpoint when there are no nodes", () => {
		expect(delegationCanRunInParallel({ maxConcurrentAgents: 1 })).toBe(false);
		expect(delegationCanRunInParallel({ maxConcurrentAgents: 2 })).toBe(true);
		// 0 and undefined both mean "no client-side cap".
		expect(delegationCanRunInParallel({ maxConcurrentAgents: 0 })).toBe(true);
		expect(delegationCanRunInParallel({ maxConcurrentAgents: undefined })).toBe(
			true,
		);
	});

	// The reported case.
	it("offers delegation when two one-slot nodes are configured", () => {
		expect(
			delegationCanRunInParallel({
				maxConcurrentAgents: 1,
				nodes: [{ capacity: 1 }, { capacity: 1 }],
			}),
		).toBe(true);
	});

	it("withholds it when the only node is as narrow as the endpoint", () => {
		expect(
			delegationCanRunInParallel({
				maxConcurrentAgents: 1,
				nodes: [{ capacity: 1 }],
			}),
		).toBe(false);
	});

	// A node turned off contributes nothing, so two nodes are not automatically
	// two slots.
	it("does not count a node that is off", () => {
		expect(
			delegationCanRunInParallel({
				maxConcurrentAgents: 1,
				nodes: [{ capacity: 1 }, { capacity: 0 }],
			}),
		).toBe(false);
	});

	// An endpoint that decides its own admission settles it alone.
	it("counts an uncapped node on its own", () => {
		expect(
			agentNodesAllowParallelDelegation([
				{ capacity: Number.POSITIVE_INFINITY },
			]),
		).toBe(true);
	});

	it("adds capacities up rather than counting nodes", () => {
		expect(agentNodesAllowParallelDelegation([{ capacity: 4 }])).toBe(true);
		expect(
			agentNodesAllowParallelDelegation([{ capacity: 0 }, { capacity: 0 }]),
		).toBe(false);
		expect(agentNodesAllowParallelDelegation([])).toBe(false);
		expect(agentNodesAllowParallelDelegation(undefined)).toBe(false);
	});

	// The single-endpoint primitive is unchanged and still means what it did.
	it("leaves the endpoint question alone", () => {
		expect(slotsAllowParallelDelegation(1)).toBe(false);
		expect(slotsAllowParallelDelegation(2)).toBe(true);
	});
});
