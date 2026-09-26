import { afterEach, describe, expect, it } from "vitest";
import { __resetAgentRounds, roundsFor } from "./agent-rounds";
import {
	buildConfiguredAgentToolName,
	createConfiguredAgentTools,
} from "./configured-agent-tool";

// `wait: false`, as spawn_agent has it: a configured agent the lead does not
// need to sit and wait for runs beside it, and its report arrives on its own.
describe("a configured agent in the background", () => {
	afterEach(() => __resetAgentRounds());

	it("returns at once with its round when asked not to wait, and its row gets its end", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const connection = {
			providerId: "ollama",
			modelId: "local-model",
			baseUrl: "http://127.0.0.1:11434",
		};
		const [tool] = createConfiguredAgentTools({
			sessionId: "cfg-bg",
			configProvider: {
				getRuntimeConfig: () =>
					({
						...connection,
						slotGates: {
							for: () => ({
								run: async () => {
									await gate;
									return {
										text: "reviewed",
										iterations: 1,
										finishReason: "completed",
										usage: { inputTokens: 0, outputTokens: 0 },
									};
								},
								active: () => 0,
							}),
						},
					}) as never,
				getConnectionConfig: () => connection,
				updateConnectionDefaults: () => {},
			},
			agents: [
				{
					name: "reviewer",
					description: "reviews code",
					systemPrompt: "You review code.",
				},
			],
		});
		const updates: Array<Record<string, unknown>> = [];
		const ack = await (
			tool as { execute: (i: unknown, c: unknown) => Promise<unknown> }
		).execute(
			{ prompt: "go", wait: false },
			{
				agentId: "lead",
				sessionId: "cfg-bg",
				toolCallId: "call-1",
				emitUpdate: (update: Record<string, unknown>) => updates.push(update),
			},
		);
		expect(ack).toMatchObject({
			background: true,
			round: "r1",
			agents: [{ id: "r1-1", name: "reviewer" }],
		});
		const rounds = roundsFor("cfg-bg");
		expect(rounds.get("r1")).toMatchObject({
			background: true,
			status: "running",
		});

		release();
		await rounds.waitFor(["r1"]);
		expect(rounds.get("r1")?.agents[0]).toMatchObject({
			state: "done",
			result: "reviewed",
		});
		expect(updates.some((update) => update.finished !== undefined)).toBe(true);
	});

	it("says in its schema that it can run in the background", () => {
		const [tool] = createConfiguredAgentTools({
			configProvider: {
				getRuntimeConfig: () => ({ providerId: "ollama" }) as never,
				getConnectionConfig: () => ({ providerId: "ollama" }) as never,
				updateConnectionDefaults: () => {},
			},
			agents: [{ name: "r", description: "d", systemPrompt: "s" }],
		});
		expect(
			(tool?.inputSchema as { properties?: Record<string, unknown> }).properties
				?.wait,
		).toMatchObject({ type: "boolean" });
	});
});

describe("configured agent tools", () => {
	it("builds stable subagent tool names", () => {
		expect(buildConfiguredAgentToolName("Code Reviewer")).toBe(
			"subagent_code_reviewer",
		);
		expect(buildConfiguredAgentToolName("___")).toBe("subagent_agent");
	});

	it("matches spawn_agent timeout and retry policy", () => {
		const [tool] = createConfiguredAgentTools({
			configProvider: {
				getRuntimeConfig: () => ({
					providerId: "anthropic",
					modelId: "claude-sonnet-4-6",
					apiKey: "key",
				}),
				getConnectionConfig: () => ({
					providerId: "anthropic",
					modelId: "claude-sonnet-4-6",
					apiKey: "key",
				}),
				updateConnectionDefaults: () => {},
			},
			agents: [
				{
					name: "code-reviewer",
					description: "Reviews code",
					systemPrompt: "You are a code reviewer.",
				},
			],
		});

		expect(tool?.name).toBe("subagent_code_reviewer");
		expect(tool?.timeoutMs).toBe(300000);
		expect(tool?.retryable).toBe(false);
	});
});

/**
 * The gate, stubbed so the sub-agent never runs.
 *
 * `run` returns a result of its own instead of invoking the task: the point
 * under test is which endpoint the agent was gated against, and actually
 * running the sub-agent would stand up a session runtime and talk to a
 * provider to learn nothing more.
 */
function recordingGates(): {
	keys: string[];
	slotGates: {
		for: (key: string) => {
			run: <T>(task: () => Promise<T>) => Promise<T>;
			active: () => number;
		};
	};
} {
	const keys: string[] = [];
	return {
		keys,
		slotGates: {
			for: (key: string) => {
				keys.push(key);
				return {
					run: (async () => ({
						text: "gated",
						iterations: 1,
						finishReason: "stop",
						usage: { inputTokens: 0, outputTokens: 0 },
					})) as never,
					active: () => 0,
				};
			},
		},
	};
}

/**
 * A placement that hands out one fixed node and records what was asked of it.
 *
 * `run` answers like the gate above rather than running the sub-agent, for the
 * same reason; `placed` and `released` are the two facts under test.
 */
function recordingPlacement(node: {
	nodeId: string;
	providerId: string;
	modelId: string;
	baseUrl: string;
}): {
	placed: string[];
	released: string[];
	ran: string[];
	nodePlacement: unknown;
} {
	const placed: string[] = [];
	const released: string[] = [];
	const ran: string[] = [];
	const connection = {
		providerId: node.providerId,
		modelId: node.modelId,
		baseUrl: node.baseUrl,
	};
	return {
		placed,
		released,
		ran,
		nodePlacement: {
			place: async () => {
				placed.push(node.nodeId);
				return {
					nodeId: node.nodeId,
					configProvider: {
						getRuntimeConfig: () => connection,
						getConnectionConfig: () => connection,
						updateConnectionDefaults: () => {},
					},
					run: (async () => {
						ran.push(node.nodeId);
						return {
							text: "placed",
							iterations: 1,
							finishReason: "stop",
							usage: { inputTokens: 0, outputTokens: 0 },
						};
					}) as never,
					release: () => {
						released.push(node.nodeId);
					},
				};
			},
			base: undefined,
			occupancy: () => new Map(),
			waiting: 0,
		},
	};
}

function runAgent(input: {
	agent: Parameters<typeof createConfiguredAgentTools>[0]["agents"][number];
	sessionProvider?: string;
	sessionBaseUrl?: string;
	resolveProviderConnection?: (providerId: string) => never;
	nodePlacement?: unknown;
}): { keys: string[]; execute: () => Promise<unknown> } {
	const { keys, slotGates } = recordingGates();
	const connection = {
		providerId: input.sessionProvider ?? "ollama",
		modelId: "local-model",
		baseUrl: input.sessionBaseUrl ?? "http://127.0.0.1:11434",
	};
	const [tool] = createConfiguredAgentTools({
		configProvider: {
			getRuntimeConfig: () =>
				({
					...connection,
					slotGates,
					...(input.nodePlacement
						? { nodePlacement: input.nodePlacement }
						: {}),
				}) as never,
			getConnectionConfig: () => connection,
			updateConnectionDefaults: () => {},
		},
		agents: [input.agent],
		...(input.resolveProviderConnection
			? { resolveProviderConnection: input.resolveProviderConnection }
			: {}),
	});
	return {
		keys,
		execute: () =>
			(
				tool as { execute: (i: unknown, c: unknown) => Promise<unknown> }
			).execute({ prompt: "go" }, { agentId: "lead" }),
	};
}

/**
 * Configured agents ran ungated until now, while `spawn_agent` was gated. That
 * is backwards: `spawn_agent` sub-agents all share the session's connection,
 * and configured agents are the only ones that can name another.
 */
describe("holding configured agents to their own endpoint", () => {
	it("gates an agent that inherits the session connection against that endpoint", async () => {
		const { keys, execute } = runAgent({
			agent: {
				name: "reviewer",
				description: "reviews code",
				systemPrompt: "You review code.",
			},
		});

		await execute();

		expect(keys).toEqual(["ollama http://127.0.0.1:11434"]);
	});

	// The tester's case: local agents and cloud agents in one turn. Different
	// keys is what lets them run at once instead of queueing behind each other.
	it("gates an agent naming another provider against that provider instead", async () => {
		const { keys, execute } = runAgent({
			agent: {
				name: "auditor",
				description: "audits code",
				systemPrompt: "You audit code.",
				providerId: "anthropic",
			},
			resolveProviderConnection: (() => ({
				apiKey: "key",
				baseUrl: "https://api.anthropic.com",
			})) as never,
		});

		await execute();

		expect(keys).toEqual(["anthropic https://api.anthropic.com"]);
	});
});

/**
 * Measured on pandorum, 2026-09-22: two agent nodes configured on one
 * opencoti, the model called two configured agents in one turn, and after 136
 * seconds both were aborted with zero assistant turns between them. Their
 * transcripts held one message each -- the task -- so they had been queuing,
 * not failing. `spawn_agent` consulted the nodes; this path never did, and
 * gated both against the session's single endpoint.
 */
describe("placing configured agents on the nodes", () => {
	it("runs an agent that inherits the session connection on a node", async () => {
		const placement = recordingPlacement({
			nodeId: "node-2",
			providerId: "opencoti",
			modelId: "v9-agentic",
			baseUrl: "http://192.168.178.2:8240/v1",
		});
		const { keys, execute } = runAgent({
			agent: {
				name: "reviewer",
				description: "reviews code",
				systemPrompt: "You review code.",
			},
			nodePlacement: placement.nodePlacement,
		});

		await execute();

		expect(placement.placed).toEqual(["node-2"]);
		// The node's own gate decided, so the session's per-endpoint gate was
		// never consulted -- two gates for one agent would book two slots.
		expect(placement.ran).toEqual(["node-2"]);
		expect(keys).toEqual([]);
	});

	// A node is a whole agents configuration, so placement decides the model.
	// An agent that named its own is not asking to be moved.
	it("leaves an agent that names its own provider where it asked to be", async () => {
		const placement = recordingPlacement({
			nodeId: "node-2",
			providerId: "opencoti",
			modelId: "v9-agentic",
			baseUrl: "http://192.168.178.2:8240/v1",
		});
		const { keys, execute } = runAgent({
			agent: {
				name: "auditor",
				description: "audits code",
				systemPrompt: "You audit code.",
				providerId: "anthropic",
			},
			resolveProviderConnection: (() => ({
				apiKey: "key",
				baseUrl: "https://api.anthropic.com",
			})) as never,
			nodePlacement: placement.nodePlacement,
		});

		await execute();

		expect(placement.placed).toEqual([]);
		expect(keys).toEqual(["anthropic https://api.anthropic.com"]);
	});

	// The lease is the whole point of a capacity: a node still booked for an
	// agent that failed is a node that takes one fewer agent for the rest of
	// the session, and the round narrows with every failure.
	it("gives the node back when the agent throws", async () => {
		const placement = recordingPlacement({
			nodeId: "node-2",
			providerId: "opencoti",
			modelId: "v9-agentic",
			baseUrl: "http://192.168.178.2:8240/v1",
		});
		const { execute } = runAgent({
			agent: {
				name: "reviewer",
				description: "reviews code",
				systemPrompt: "You review code.",
			},
			nodePlacement: {
				...(placement.nodePlacement as Record<string, unknown>),
				place: async () => {
					const node = await (
						placement.nodePlacement as {
							place: () => Promise<{ release: () => void }>;
						}
					).place();
					return {
						...node,
						run: async () => {
							throw new Error("the endpoint refused");
						},
					};
				},
			},
		});

		await expect(execute()).rejects.toThrow();
		expect(placement.released).toEqual(["node-2"]);
	});
});

/**
 * A node whose server does not have its model answers instantly, spends
 * nothing, and will answer the same way for every agent after this one.
 *
 * Measured on pandorum 2026-09-22 in a five-agent fan-out: two agents died on
 * `node-mucvow61` with `model 'ornith-27b_tb:iq4_xs-128k' not found`, a third
 * died when the lead retried straight back into it, and two healthy nodes sat
 * idle. Nothing on screen said why -- the reports were simply empty.
 */
describe("a node that cannot run the agent it was given", () => {
	/** Nodes handed out in order, each answering however it is told to. */
	function rotation(
		nodes: Array<{
			nodeId: string;
			nodeLabel?: string;
			result: {
				text: string;
				finishReason: string;
				usage: { inputTokens: number; outputTokens: number };
			};
		}>,
	) {
		const placed: string[] = [];
		const down: Array<{ nodeId: string; coolOffMs?: number }> = [];
		let next = 0;
		return {
			placed,
			down,
			nodePlacement: {
				place: async () => {
					const node = nodes[Math.min(next, nodes.length - 1)];
					next += 1;
					placed.push(node.nodeId);
					const connection = {
						providerId: "ollama",
						modelId: "m",
						baseUrl: "http://localhost:11434",
					};
					return {
						nodeId: node.nodeId,
						nodeLabel: node.nodeLabel,
						configProvider: {
							getRuntimeConfig: () => connection,
							getConnectionConfig: () => connection,
							updateConnectionDefaults: () => {},
						},
						run: (async () => ({ iterations: 1, ...node.result })) as never,
						release: () => {},
						markUnreachable: (coolOffMs?: number) =>
							down.push({ nodeId: node.nodeId, coolOffMs }),
					};
				},
				base: undefined,
				occupancy: () => new Map(),
				waiting: 0,
			},
		};
	}

	const missing = {
		text: "model 'ornith-27b_tb:iq4_xs-128k' not found",
		finishReason: "error",
		usage: { inputTokens: 0, outputTokens: 0 },
	};
	const worked = {
		text: "reviewed",
		finishReason: "stop",
		usage: { inputTokens: 900, outputTokens: 120 },
	};

	it("puts the agent back in the queue and answers from the next node", async () => {
		const placement = rotation([
			{ nodeId: "node-mucvow61", nodeLabel: "Node3", result: missing },
			{ nodeId: "primary", nodeLabel: "Node1", result: worked },
		]);
		const { execute } = runAgent({
			agent: {
				name: "reviewer",
				description: "reviews code",
				systemPrompt: "You review code.",
			},
			nodePlacement: placement.nodePlacement,
		});

		const output = (await execute()) as {
			text: string;
			nodeId?: string;
			nodeLabel?: string;
		};

		expect(placement.placed).toEqual(["node-mucvow61", "primary"]);
		expect(output.text).toBe("reviewed");
		// And it reports where it actually ran, not where it was first sent.
		expect(output.nodeId).toBe("primary");
		expect(output.nodeLabel).toBe("Node1");
	});

	// The node is why, so the node leaves the rotation -- and for longer than a
	// dead box does, because a missing model does not come back on its own.
	it("takes the node out of the rotation for a long cool-off", async () => {
		const placement = rotation([
			{ nodeId: "node-mucvow61", result: missing },
			{ nodeId: "primary", result: worked },
		]);
		const { execute } = runAgent({
			agent: {
				name: "reviewer",
				description: "reviews code",
				systemPrompt: "You review code.",
			},
			nodePlacement: placement.nodePlacement,
		});

		await execute();

		expect(placement.down).toEqual([
			{ nodeId: "node-mucvow61", coolOffMs: 600_000 },
		]);
	});

	// Bounded: a request that fails the same way everywhere must be reported,
	// not walked around the whole rotation taking every node down with it.
	it("stops after three nodes and reports the failure", async () => {
		const placement = rotation([
			{ nodeId: "a", result: missing },
			{ nodeId: "b", result: missing },
			{ nodeId: "c", result: missing },
			{ nodeId: "d", result: missing },
		]);
		const { execute } = runAgent({
			agent: {
				name: "reviewer",
				description: "reviews code",
				systemPrompt: "You review code.",
			},
			nodePlacement: placement.nodePlacement,
		});

		const output = (await execute()) as { text: string };
		expect(placement.placed).toEqual(["a", "b", "c"]);
		expect(output.text).toContain("not found");
	});

	// The guard that makes any of this safe: a failure that spent tokens may
	// have edited a file, and re-running it elsewhere would do it twice.
	it("never re-places a failure that spent something", async () => {
		const placement = rotation([
			{
				nodeId: "node-mucvow61",
				result: {
					text: "model 'x' not found",
					finishReason: "error",
					usage: { inputTokens: 4000, outputTokens: 12 },
				},
			},
			{ nodeId: "primary", result: worked },
		]);
		const { execute } = runAgent({
			agent: {
				name: "reviewer",
				description: "reviews code",
				systemPrompt: "You review code.",
			},
			nodePlacement: placement.nodePlacement,
		});

		await execute();
		expect(placement.placed).toEqual(["node-mucvow61"]);
		expect(placement.down).toEqual([]);
	});
});
