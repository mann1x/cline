import type { AgentResult } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	type AgentNodeRuntimeConfig,
	createAgentNodePlacement,
	POLYKV_LEAD_NODE_ID,
	PRIMARY_OVERFLOW_NODE_ID,
	sessionAgentNodes,
} from "./agent-node-placement";
import {
	capLeadTier,
	emptyPlacementState,
	LEAD_SUBPOOL_CAPACITY,
	placeAgent,
} from "./agent-placement";
import { createAgentPlacementQueue } from "./agent-placement-queue";
import {
	buildDelegatedAgentConfig,
	createDelegatedAgentConfigProvider,
	withPolykvLeadOwner,
} from "./delegated-agent";
import { runPlacedAgent } from "./placed-run";

/**
 * "Use PolyKV agents as Priority 0" (PLANS §9g), ruled 2026-09-25: default
 * off, cap 8. On, agents run first as sub-pools of the lead's own opencoti
 * session and overflow into the Agent Nodes once those eight are taken.
 */

/** What each built agent's compaction pipeline was built for. */
const summarizerTargets: Array<Record<string, unknown>> = [];

function baseProvider() {
	return createDelegatedAgentConfigProvider({
		providerId: "opencoti",
		modelId: "node1-model",
		sessionId: "lead-session",
		cwd: "/w",
		apiKey: "",
		thinking: true,
		createPrepareTurn: (target?: {
			providerConfig: Record<string, unknown>;
		}) => {
			if (target) {
				summarizerTargets.push(target.providerConfig);
			}
			return undefined;
		},
	} as never);
}

function node(
	id: string,
	priority: number,
	capacity: number,
): AgentNodeRuntimeConfig {
	return {
		id,
		priority,
		capacity,
		connection: { providerId: "ollama", modelId: id },
	};
}

const lead = {
	providerId: "opencoti",
	modelId: "lead-model",
	lead: { baseUrl: "http://lead:8240/v1", thinking: false },
};

describe("priority 0's capacity", () => {
	it("is at most eight sub-pools, whatever it was given", () => {
		expect(LEAD_SUBPOOL_CAPACITY).toBe(8);
		expect(capLeadTier({ id: "l", priority: 0, capacity: 20 }).capacity).toBe(
			8,
		);
		// "The endpoint decides" cannot apply to sub-pools of one window.
		expect(
			capLeadTier({ id: "l", priority: 0, capacity: Infinity }).capacity,
		).toBe(8);
		expect(capLeadTier({ id: "l", priority: 0, capacity: 3 }).capacity).toBe(3);
	});

	it("leaves 0 as off, and every other tier as configured", () => {
		expect(capLeadTier({ id: "l", priority: 0, capacity: 0 }).capacity).toBe(0);
		// 88dc254eb: Infinity on a node is the endpoint deciding, and stays so.
		expect(
			capLeadTier({ id: "n", priority: 1, capacity: Infinity }).capacity,
		).toBe(Infinity);
		expect(capLeadTier({ id: "n", priority: 1, capacity: 20 }).capacity).toBe(
			20,
		);
	});

	it("takes eight agents, then overflows to tier 1, and comes back up", async () => {
		const queue = createAgentPlacementQueue([
			{ id: "lead", priority: 0, capacity: Infinity },
			{ id: "n1", priority: 1, capacity: 4 },
		]);
		const leases = [];
		for (let index = 0; index < 10; index++) {
			leases.push(await queue.acquire());
		}
		expect(leases.map((lease) => lease.nodeId)).toEqual([
			...Array(8).fill("lead"),
			"n1",
			"n1",
		]);
		leases[0]?.release();
		expect((await queue.acquire()).nodeId).toBe("lead");
	});

	it("is ranked above every node by placeAgent", () => {
		const result = placeAgent({
			nodes: [
				{ id: "n1", priority: 1, capacity: 5 },
				{ id: "lead", priority: 0, capacity: 8 },
			],
			occupancy: new Map(),
			state: emptyPlacementState(),
		});
		expect(result.placement).toEqual({ kind: "node", nodeId: "lead" });
	});
});

describe("the session's nodes with priority 0", () => {
	it("are the host's list untouched when the setting is off", () => {
		const nodes = [node("n1", 1, 2)];
		expect(sessionAgentNodes({ ...lead, agentNodes: nodes })).toEqual(nodes);
		expect(
			sessionAgentNodes({
				...lead,
				agentNodes: nodes,
				polykvAgentsPriorityZero: false,
			}),
		).toEqual(nodes);
	});

	it("never put priority 0 on a lead that is not opencoti", () => {
		const nodes = sessionAgentNodes({
			...lead,
			providerId: "ollama",
			agentNodes: [node("n1", 1, 2)],
			polykvAgentsPriorityZero: true,
		});
		expect(nodes.map((entry) => entry.id)).toEqual(["n1"]);
	});

	it("put the lead's own connection first, at priority 0 and capacity 8", () => {
		const nodes = sessionAgentNodes({
			...lead,
			agentNodes: [node("n1", 1, 2)],
			polykvAgentsPriorityZero: true,
		});
		expect(nodes.map((entry) => entry.id)).toEqual([POLYKV_LEAD_NODE_ID, "n1"]);
		const first = nodes[0];
		expect(first).toMatchObject({
			priority: 0,
			capacity: 8,
			polykvLead: true,
			connection: {
				providerId: "opencoti",
				modelId: "lead-model",
				baseUrl: "http://lead:8240/v1",
				thinking: false,
			},
		});
		// Named even when the lead has none, so Node1's are not inherited.
		expect(Object.keys(first?.connection ?? {})).toContain("temperature");
	});

	// One node is sent as no list at all. Priority 0 must still have somewhere
	// to overflow to, or a full lead window leaves an agent only the queue.
	it("overflow to the delegated connection when the host lists no node", () => {
		const uncapped = sessionAgentNodes({
			...lead,
			polykvAgentsPriorityZero: true,
		});
		expect(uncapped.map((entry) => [entry.id, entry.priority])).toEqual([
			[POLYKV_LEAD_NODE_ID, 0],
			[PRIMARY_OVERFLOW_NODE_ID, 1],
		]);
		expect(uncapped[1]?.connection).toEqual({});
		// `maxConcurrentAgents: 0` is the endpoint deciding: Infinity on a node.
		expect(uncapped[1]?.capacity).toBe(Infinity);
		const capped = sessionAgentNodes({
			...lead,
			polykvAgentsPriorityZero: true,
			overflowCapacity: 3,
		});
		expect(capped[1]?.capacity).toBe(3);
	});

	it("drop a lead node a host tried to list itself", () => {
		const nodes = sessionAgentNodes({
			...lead,
			agentNodes: [{ ...node("fake", 0, 99), polykvLead: true }],
		});
		expect(nodes).toEqual([]);
	});
});

describe("an agent placed on priority 0", () => {
	it("is built as a sub-pool of the lead's session; a node's agent is not", async () => {
		const placement = createAgentNodePlacement({
			nodes: sessionAgentNodes({
				...lead,
				agentNodes: [node("n1", 1, 1)],
				polykvAgentsPriorityZero: true,
			}),
			base: baseProvider(),
		});
		if (!placement) {
			throw new Error("expected a placement");
		}
		const onLead = await placement.place();
		expect(onLead.nodeId).toBe(POLYKV_LEAD_NODE_ID);
		expect(onLead.nodeLabel).toBe("Model (PolyKV)");
		const leadConfig = onLead.configProvider.getRuntimeConfig();
		expect(leadConfig.polykvLeadOwner).toBe("lead-session");
		// The lead's model and thinking, not Node1's.
		expect(leadConfig.modelId).toBe("lead-model");
		expect(leadConfig.thinking).toBe(false);

		const built = buildDelegatedAgentConfig({
			kind: "subagent",
			prompt: "p",
			tools: [],
			configProvider: onLead.configProvider,
			engineSessionId: "lead-session~agent-1",
			polykvWorker: { group: "lead-session", layers: 2 },
		});
		expect(built.polykvWorker).toEqual({
			group: "lead-session",
			layers: 2,
			owner: "lead-session",
		});
		// The summarizer attaches to the same tree, in the same window.
		expect(summarizerTargets.at(-1)?.polykvWorker).toEqual({
			group: "lead-session",
			layers: 2,
			owner: "lead-session",
			attachOnly: true,
		});

		const onNode = (await placement.place()).configProvider;
		// The lead tier still has room, so pull n1's provider the long way:
		// fill the lead's eight first.
		expect(onNode.getRuntimeConfig().polykvLeadOwner).toBe("lead-session");
		for (let index = 0; index < 6; index++) {
			await placement.place();
		}
		const overflow = await placement.place();
		expect(overflow.nodeId).toBe("n1");
		expect(
			overflow.configProvider.getRuntimeConfig().polykvLeadOwner,
		).toBeUndefined();
		expect(
			buildDelegatedAgentConfig({
				kind: "subagent",
				prompt: "p",
				tools: [],
				configProvider: overflow.configProvider,
				polykvWorker: { group: "lead-session", layers: 2 },
			}).polykvWorker,
		).toEqual({ group: "lead-session", layers: 2 });
	});

	it("leaves an unpooled agent unpooled", () => {
		expect(withPolykvLeadOwner(undefined, "lead")).toBeUndefined();
	});

	// The hazard (991ce2466: 49 of 51 lost to one full lead window). A refusal
	// on priority 0 before the agent started is a placement, not a failure:
	// the agent goes to the next tier and runs there.
	it("overflows to a node when the lead's window refuses it before it starts", async () => {
		const placement = createAgentNodePlacement({
			nodes: sessionAgentNodes({
				...lead,
				agentNodes: [node("n1", 1, 2)],
				polykvAgentsPriorityZero: true,
			}),
			base: baseProvider(),
		});
		if (!placement) {
			throw new Error("expected a placement");
		}
		const tried: string[] = [];
		const outcome = await runPlacedAgent({
			placement,
			label: "a",
			run: async (placed, admitted) => {
				tried.push(placed.nodeId);
				if (placed.nodeId === POLYKV_LEAD_NODE_ID) {
					return {
						text: "admission rejected: session allocation full (worker of 'lead-session': 100 of 65536 cells free, the conversation keeps 16384) — priority 0 is full; overflowing to the Agent Nodes",
						finishReason: "error",
						iterations: 0,
						usage: { inputTokens: 0, outputTokens: 0 },
					} as unknown as AgentResult;
				}
				admitted();
				return {
					text: "done",
					finishReason: "completed",
					iterations: 1,
					usage: { inputTokens: 1, outputTokens: 1 },
				} as unknown as AgentResult;
			},
		});
		expect(tried).toEqual([POLYKV_LEAD_NODE_ID, "n1"]);
		expect(outcome.result.text).toBe("done");
		expect(outcome.placed.nodeId).toBe("n1");
	});
});
