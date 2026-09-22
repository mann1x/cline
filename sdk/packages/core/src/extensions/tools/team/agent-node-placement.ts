/**
 * The runtime side of Agent Nodes: which node an agent runs on, and its
 * connection while it does.
 *
 * {@link placeAgent} decides *where*, {@link createAgentPlacementQueue} makes
 * "everything is full" a wait rather than a refusal, and this puts a
 * connection behind the answer. A node is a complete agents configuration, so
 * placement has to happen **before** the agent is built: the node decides which
 * model it is.
 *
 * Two bounds apply to one agent and they are not the same question:
 *
 * - **the node's capacity**, which the user configured, held by the queue;
 * - **the node's slot gate**, which is the endpoint's own answer -- PolyKV
 *   admission on an opencoti node, a parallel-session count on an ollama one.
 *
 * So an agent takes a node, then runs inside that node's gate, and gives the
 * node back however the run ended.
 */
import type { AgentNode } from "./agent-placement";
import {
	createAgentPlacementQueue,
	type PlacementLease,
} from "./agent-placement-queue";
import type {
	DelegatedAgentConfigProvider,
	DelegatedAgentConnectionConfig,
} from "./delegated-agent";
import { createDelegatedAgentConfigProvider } from "./delegated-agent";

/** What a host says about one node. */
export interface AgentNodeRuntimeConfig {
	id: string;
	/** 1 highest. `0` is the lead's own PolyKV session; see the plan's §9g. */
	priority: number;
	/**
	 * Agents this node may run at once.
	 *
	 * Resolved by the host, where the unit differs by provider: a
	 * parallel-sessions setting for ollama, llama.cpp and the cloud providers,
	 * and for opencoti the sub-pools inside its one session.
	 */
	capacity: number;
	/**
	 * What the settings panel calls this node -- `Node1`, `Node2`, `Node3`.
	 *
	 * The id is a storage key (`node-mucuczcm`), generated when the node is
	 * added and shown nowhere in the UI, so a chat row that printed it named
	 * something the user had no way to look up. Reported exactly that way:
	 * "on node-mucuczcm" -- what is this? I expect to see Node1 or Node2.
	 *
	 * Carried rather than derived here because the numbering belongs to the
	 * stored list, including the nodes this one skips: a node that names no
	 * provider is dropped before it reaches the placement engine, and
	 * renumbering around the gap would call Node3 "Node2" on the one screen
	 * where the user is trying to tell them apart.
	 */
	label?: string;
	/** The node's own connection, in the shape the Agents tab already stores. */
	connection: Partial<DelegatedAgentConnectionConfig>;
}

/** Somewhere to run one agent, held until it is given back. */
export interface PlacedAgentNode {
	nodeId: string;
	/** What the settings panel calls it; see {@link AgentNodeRuntimeConfig.label}. */
	nodeLabel?: string;
	configProvider: DelegatedAgentConfigProvider;
	/**
	 * Runs `fn` on this node. The lease IS the gate.
	 *
	 * A placed agent is deliberately NOT also held behind the shared
	 * per-endpoint gate. Two nodes that resolve to one base URL are two lanes
	 * on that server, not one: they are two of its slots, and how many
	 * requests it will take at once is the server's own answer -- `--parallel`
	 * on a llama.cpp family engine, `OLLAMA_NUM_PARALLEL` on ollama, more than
	 * either under PolyKV admission with elastic slots. A node's capacity is
	 * the user saying how much of that to use, and the sum across nodes is
	 * what they asked for.
	 *
	 * It used to apply both, which made the node capacities decorative: the
	 * endpoint gate is one object per provider+baseUrl, so three nodes on one
	 * opencoti ran strictly one agent at a time however they were configured.
	 * Measured on pandorum 2026-09-22 -- three agents, 80s/108s/148s, each
	 * starting only as the one before it finished.
	 *
	 * The server refusing is the backstop, and it is the right one: it knows
	 * its own admission, and we do not.
	 */
	run<T>(fn: () => Promise<T>): Promise<T>;
	/** Idempotent: the first call frees the slot. */
	release(): void;
	/**
	 * This node could not be reached at all; leave it out of the rotation for
	 * a cool-off. See {@link AgentPlacementQueue.markUnreachable}.
	 */
	markUnreachable(): void;
}

export interface AgentNodePlacement {
	/** The node for the next agent, waiting for one when all are full. */
	place(signal?: AbortSignal): Promise<PlacedAgentNode>;
	/** The session's own delegated connection, for callers that skip placement. */
	base: DelegatedAgentConfigProvider;
	occupancy(): ReadonlyMap<string, number>;
	readonly waiting: number;
}

/**
 * `undefined` when no node is configured, which is every session that predates
 * this: the caller then takes the single delegated connection it always took.
 */
export function createAgentNodePlacement(input: {
	nodes: readonly AgentNodeRuntimeConfig[];
	base: DelegatedAgentConfigProvider;
}): AgentNodePlacement | undefined {
	if (input.nodes.length === 0) {
		return undefined;
	}
	const queue = createAgentPlacementQueue(
		input.nodes.map(
			(node): AgentNode => ({
				id: node.id,
				priority: node.priority,
				capacity: node.capacity,
			}),
		),
	);

	// One config provider per node, built once. Each pins the fields its node
	// names, exactly as the single Agents tab's connection does: a host pushing
	// the session's refreshed model or key must not move agents back onto it.
	const providers = new Map<string, DelegatedAgentConfigProvider>();
	for (const node of input.nodes) {
		const overrides = node.connection;
		providers.set(
			node.id,
			createDelegatedAgentConfigProvider(
				{ ...input.base.getRuntimeConfig(), ...overrides },
				Object.keys(overrides) as (keyof DelegatedAgentConnectionConfig)[],
			),
		);
	}

	const labels = new Map(
		input.nodes.flatMap((node) =>
			node.label ? [[node.id, node.label] as const] : [],
		),
	);
	const placed = (lease: PlacementLease): PlacedAgentNode => {
		const configProvider = providers.get(lease.nodeId) ?? input.base;
		const label = labels.get(lease.nodeId);
		return {
			nodeId: lease.nodeId,
			...(label ? { nodeLabel: label } : {}),
			configProvider,
			// The lease is the gate -- see `PlacedAgentNode.run`.
			run: async <T>(fn: () => Promise<T>) => await fn(),
			release: () => lease.release(),
			markUnreachable: () => queue.markUnreachable(lease.nodeId),
		};
	};

	return {
		place: async (signal) => placed(await queue.acquire(signal)),
		base: input.base,
		occupancy: () => queue.occupancy(),
		get waiting() {
			return queue.waiting;
		},
	};
}
