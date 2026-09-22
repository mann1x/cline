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
	/** The node's own connection, in the shape the Agents tab already stores. */
	connection: Partial<DelegatedAgentConnectionConfig>;
}

/** Somewhere to run one agent, held until it is given back. */
export interface PlacedAgentNode {
	nodeId: string;
	configProvider: DelegatedAgentConfigProvider;
	/** Runs `fn` inside this node's own slot gate, when it has one. */
	run<T>(fn: () => Promise<T>): Promise<T>;
	/** Idempotent: the first call frees the slot. */
	release(): void;
}

export interface AgentNodeSlotGate {
	run<T>(fn: () => Promise<T>): Promise<T>;
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
	/** The endpoint's own gate for a node, when the session has a registry. */
	slotGateFor?: (node: AgentNodeRuntimeConfig) => AgentNodeSlotGate | undefined;
}): AgentNodePlacement | undefined {
	if (input.nodes.length === 0) {
		return undefined;
	}
	const byId = new Map(input.nodes.map((node) => [node.id, node]));
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

	const placed = (lease: PlacementLease): PlacedAgentNode => {
		const node = byId.get(lease.nodeId);
		const configProvider = providers.get(lease.nodeId) ?? input.base;
		const gate = node ? input.slotGateFor?.(node) : undefined;
		return {
			nodeId: lease.nodeId,
			configProvider,
			run: async <T>(fn: () => Promise<T>) =>
				gate ? await gate.run(fn) : await fn(),
			release: () => lease.release(),
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
