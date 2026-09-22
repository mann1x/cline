/**
 * Where the next delegated agent runs.
 *
 * A **node** is a complete agents provider configuration — its own endpoint,
 * model, context window, sampler and budget — so a set of nodes is
 * heterogeneous by design: one on Anthropic, one on opencoti, one on a LAN
 * ollama, one on llama.cpp. What this module decides is only which of them
 * takes the next agent.
 *
 * Two rules, and the second is the one that is easy to get wrong.
 *
 * **Priority is a rank, 1 highest**, and a lower tier is used only when no node
 * in a higher one has room. Within a tier, round-robin.
 *
 * **A tier is full when its nodes have no free slot right now** — live
 * occupancy, never a count of what has been spawned. The difference shows up
 * the moment a higher-tier agent finishes: the next spawn must go back up to
 * the slot it freed. A counter that remembered "we have moved on to tier 2"
 * would leave that capacity idle for the rest of the run, which is the opposite
 * of overflowing only when necessary.
 *
 * Priority `0` is reserved for the lead conversation's own PolyKV session,
 * whose agents are sub-pools of the window it has already booked. It is a tier
 * like any other here; that it comes first is just what its number means.
 */

export interface AgentNode {
	/** Stable identity, used as the occupancy key. */
	id: string;
	/** 1 is highest. `0` is the lead session's own sub-pools. */
	priority: number;
	/**
	 * How many agents may run on this node at once.
	 *
	 * The unit differs by provider and is resolved before it gets here: a
	 * parallel-sessions setting for ollama, llama.cpp and the cloud providers;
	 * for opencoti, the sub-pools available inside its ONE session, because
	 * agents there share the conversation's allocation rather than booking one
	 * each.
	 *
	 * `0` means the node is off and is never placed on. `Infinity` means the
	 * endpoint decides its own admission and this layer must not be the bound —
	 * which is what an elastic or PolyKV opencoti resolves to when the
	 * profile's parallel-sessions box is left empty. The two are opposite
	 * readings of "no number", so they are spelled differently on purpose.
	 */
	capacity: number;
}

export type Placement =
	| { kind: "node"; nodeId: string }
	/**
	 * Nothing has room. The agent waits rather than failing: a swarm larger
	 * than total capacity should complete slowly, not partly fail.
	 */
	| { kind: "queued" };

export interface PlacementState {
	/**
	 * Where the round-robin left off, per tier.
	 *
	 * Per tier rather than global: advancing through tier 2 must not skip a
	 * node in tier 1 the next time tier 1 has room.
	 */
	readonly cursors: Readonly<Record<number, number>>;
}

export function emptyPlacementState(): PlacementState {
	return { cursors: {} };
}

/**
 * Pick a node for one agent, given what is running right now.
 *
 * Pure: `occupancy` is the caller's live view and `state` carries only the
 * round-robin cursors, so the same inputs always give the same answer and the
 * decision can be tested without a server.
 */
export function placeAgent(input: {
	nodes: readonly AgentNode[];
	/** Node id to agents currently running on it. Missing means none. */
	occupancy: ReadonlyMap<string, number>;
	state: PlacementState;
}): { placement: Placement; state: PlacementState } {
	const byPriority = new Map<number, AgentNode[]>();
	for (const node of input.nodes) {
		// A node with no capacity is not a node with room. Reading 0 as
		// "unbounded" would send every agent to the one node turned off.
		//
		// `Infinity` *is* unbounded, and is how an endpoint that decides its own
		// admission says so — an elastic or PolyKV opencoti with the profile's
		// parallel-sessions box left empty, which is the setting that panel
		// recommends. Refusing it as "not finite" made every such node
		// unplaceable, so configuring nodes at all turned delegation off.
		if (Number.isNaN(node.capacity) || node.capacity <= 0) {
			continue;
		}
		const tier = byPriority.get(node.priority);
		if (tier) {
			tier.push(node);
		} else {
			byPriority.set(node.priority, [node]);
		}
	}

	// Rank, not configuration order.
	for (const priority of [...byPriority.keys()].sort((a, b) => a - b)) {
		const tier = byPriority.get(priority) ?? [];
		const start = input.state.cursors[priority] ?? -1;
		for (let step = 1; step <= tier.length; step += 1) {
			const index = (start + step) % tier.length;
			const node = tier[index];
			if ((input.occupancy.get(node.id) ?? 0) < node.capacity) {
				return {
					placement: { kind: "node", nodeId: node.id },
					// The cursor lands on whoever actually took the agent, so a
					// full node skipped on the way does not get the next one
					// either.
					state: {
						cursors: { ...input.state.cursors, [priority]: index },
					},
				};
			}
		}
	}

	// Nothing anywhere. The cursors are untouched: no tier was advanced,
	// because no tier was used.
	return { placement: { kind: "queued" }, state: input.state };
}
