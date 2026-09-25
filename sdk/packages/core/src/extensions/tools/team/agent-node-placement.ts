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
import { probeServerHealth, serverRoot } from "@cline/llms";
import {
	type AgentNode,
	capLeadTier,
	LEAD_PRIORITY,
	LEAD_SUBPOOL_CAPACITY,
} from "./agent-placement";
import {
	type AcquireOptions,
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
	/** See `CoreSessionConfig.agentNodes[].windowShare`. */
	windowShare?: number;
	/**
	 * This node is the lead conversation's own opencoti session: priority 0,
	 * "Use PolyKV agents as Priority 0" (PLANS §9g). Its agents are built as
	 * sub-pools of the lead's window, its priority is 0 and its capacity at
	 * most {@link LEAD_SUBPOOL_CAPACITY}, whatever else the entry says.
	 */
	polykvLead?: boolean;
}

/**
 * The node's connection with its window share on the provider config.
 *
 * Merged, never replacing: a node that names no provider config runs on the
 * session's, polykv section and fetch included, and the share must ride on
 * that rather than stand in for it.
 */
function withAgentWindowShare(
	connection: Partial<DelegatedAgentConnectionConfig>,
	inherited: DelegatedAgentConnectionConfig["providerConfig"] | undefined,
	windowShare: number | undefined,
): Partial<DelegatedAgentConnectionConfig> {
	if (typeof windowShare !== "number" || !Number.isFinite(windowShare)) {
		return connection;
	}
	const providerConfig = connection.providerConfig ?? inherited;
	return {
		...connection,
		providerConfig: {
			...((providerConfig ?? {}) as Record<string, unknown>),
			agentWindow: { sharePercent: windowShare },
		} as DelegatedAgentConnectionConfig["providerConfig"],
	};
}

/** The id and label the priority-0 node goes by. */
export const POLYKV_LEAD_NODE_ID = "polykv-lead";
export const POLYKV_LEAD_NODE_LABEL = "Model (PolyKV)";

/** What {@link sessionAgentNodes} reads of a session's config. */
export interface SessionAgentNodesInput {
	providerId: string;
	modelId: string;
	agentNodes?: readonly AgentNodeRuntimeConfig[];
	/**
	 * The host's word that the setting is on AND this session's endpoint
	 * confirmed `pools_enabled`. The provider is checked again here.
	 */
	polykvAgentsPriorityZero?: boolean;
	/** The lead's own connection, from which the priority-0 node is built. */
	lead: Partial<DelegatedAgentConnectionConfig>;
	/**
	 * The session's own agent concurrency (`maxConcurrentAgents`), for the
	 * overflow node made when the host lists none. `0` or absent is "the
	 * endpoint decides", which a node spells `Infinity`.
	 */
	overflowCapacity?: number;
}

/** The overflow tier made when priority 0 is on and the host lists no node. */
export const PRIMARY_OVERFLOW_NODE_ID = "primary";

/**
 * The nodes delegated agents are placed across, priority 0 included.
 *
 * With "Use PolyKV agents as Priority 0" off -- the default -- this is the
 * host's list untouched. On, and only on an opencoti lead, the lead's own
 * session is prepended as priority 0 with its cap of eight; the host's list is
 * the overflow, and a host that has no second node sends Node1 there on its
 * own, so an agent always has somewhere to go when the lead's window is full.
 *
 * One function for every reader -- the placement, the delegation gate, the
 * swarm offer -- so none of them sees a different set of nodes than the one
 * agents are actually placed on.
 */
export function sessionAgentNodes(
	input: SessionAgentNodesInput,
): AgentNodeRuntimeConfig[] {
	const listed = (input.agentNodes ?? []).filter((node) => !node.polykvLead);
	if (
		input.polykvAgentsPriorityZero !== true ||
		input.providerId.trim().toLowerCase() !== "opencoti"
	) {
		return [...listed];
	}
	// Priority 0 always has somewhere to overflow to. A host with one node
	// sends no list (one node is the delegated connection itself), so that
	// connection becomes tier 1 here -- `{}` is "the session's delegated
	// connection unchanged". Without it a full lead window would leave an
	// agent nowhere to go but the queue, refused until it gave up.
	const overflow: AgentNodeRuntimeConfig[] =
		listed.length > 0
			? listed
			: [
					{
						id: PRIMARY_OVERFLOW_NODE_ID,
						priority: LEAD_PRIORITY + 1,
						capacity:
							typeof input.overflowCapacity === "number" &&
							input.overflowCapacity > 0
								? input.overflowCapacity
								: Number.POSITIVE_INFINITY,
						label: "Node1",
						connection: {},
					},
				];
	return [
		{
			id: POLYKV_LEAD_NODE_ID,
			priority: LEAD_PRIORITY,
			capacity: LEAD_SUBPOOL_CAPACITY,
			label: POLYKV_LEAD_NODE_LABEL,
			// Every field the lead has, even the undefined ones: a node
			// inherits what it does not name from the Agents tab's connection,
			// and an agent in the lead's window must run the lead's model, with
			// the lead's thinking and caps, not Node1's.
			connection: {
				thinking: undefined,
				reasoningEffort: undefined,
				thinkingBudgetTokens: undefined,
				maxTokensPerTurn: undefined,
				temperature: undefined,
				...input.lead,
				providerId: input.providerId,
				modelId: input.modelId,
			},
			polykvLead: true,
		},
		...overflow,
	];
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
	/** The engine took the agent; see {@link PlacementLease.admitted}. */
	admitted(): void;
	/**
	 * The engine refused the agent before admitting it. Frees the slot and
	 * holds the node; see {@link PlacementLease.refused}.
	 */
	refused(holdMs?: number): void;
	/**
	 * This node could not be reached at all; leave it out of the rotation for
	 * a cool-off. See {@link AgentPlacementQueue.markUnreachable}.
	 *
	 * `coolOffMs` overrides the default, for a condition that heals on a
	 * different scale -- a model the server does not have, which no amount of
	 * waiting fixes on its own.
	 */
	markUnreachable(coolOffMs?: number): void;
}

export interface AgentNodePlacement {
	/** The node for the next agent, waiting for one when all are full. */
	place(
		signal?: AbortSignal,
		options?: AcquireOptions,
	): Promise<PlacedAgentNode>;
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
			(node): AgentNode =>
				capLeadTier({
					id: node.id,
					// The lead node is priority 0 by what it is, and nothing
					// else is: a listed node claiming 0 would jump the lead.
					priority: node.polykvLead
						? LEAD_PRIORITY
						: Math.max(node.priority, LEAD_PRIORITY + 1),
					capacity: node.capacity,
				}),
		),
		{
			// A node out for not answering goes back the moment its server
			// does: asked on its own `/health`, every few seconds.
			probe: async (nodeId) => {
				const connection = (
					providers.get(nodeId) ?? input.base
				).getConnectionConfig();
				const root = serverRoot(connection.baseUrl);
				return root
					? await probeServerHealth(root, {
							...(connection.headers ? { headers: connection.headers } : {}),
						})
					: false;
			},
		},
	);

	// One config provider per node, built once. Each pins the fields its node
	// names, exactly as the single Agents tab's connection does: a host pushing
	// the session's refreshed model or key must not move agents back onto it.
	const providers = new Map<string, DelegatedAgentConfigProvider>();
	for (const node of input.nodes) {
		const base = input.base.getRuntimeConfig();
		const overrides = withAgentWindowShare(
			node.connection,
			base.providerConfig,
			node.windowShare,
		);
		providers.set(
			node.id,
			createDelegatedAgentConfigProvider(
				{
					...base,
					...overrides,
					// The lead's session is the owner its agents' pools live in.
					// A session with no id has no window to lend, and the node
					// then runs its agents as ordinary swarm workers.
					...(node.polykvLead && base.sessionId
						? { polykvLeadOwner: base.sessionId }
						: {}),
				},
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
			admitted: () => lease.admitted(),
			refused: (holdMs) => lease.refused(holdMs),
			markUnreachable: (coolOffMs) =>
				queue.markUnreachable(lease.nodeId, coolOffMs),
		};
	};

	return {
		place: async (signal, options) =>
			placed(await queue.acquire(signal, options)),
		base: input.base,
		occupancy: () => queue.occupancy(),
		get waiting() {
			return queue.waiting;
		},
	};
}
