import type { AgentConfig } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDelegatedAgentConfigProvider } from "./delegated-agent";

type AgentExtension = NonNullable<AgentConfig["extensions"]>[number];

const runMock = vi.fn();
const runWithHeadMock = vi.fn();
const getAgentIdMock = vi.fn(() => "sub-agent-1");
const getConversationIdMock = vi.fn(() => "conv-sub-1");
const agentConstructorSpy = vi.fn();

vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => {
	return {
		SessionRuntime: class MockSessionRuntime {
			constructor(config: unknown) {
				agentConstructorSpy(config);
			}

			getAgentId(): string {
				return getAgentIdMock();
			}

			getConversationId(): string {
				return getConversationIdMock();
			}

			subscribeEvents(): () => void {
				return () => {};
			}

			async run(input: string): Promise<unknown> {
				return runMock(input);
			}

			async runWithHead(head: string[], task: string): Promise<unknown> {
				return runWithHeadMock(head, task);
			}
		},
	};
});

describe("createSpawnAgentTool", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// A profile with agent nodes decides WHERE each sub-agent runs, and the
	// node decides which model it is -- so the node has to be taken before the
	// agent is built, and given back however the run ended.
	it("builds the sub-agent on the node it was placed on, and frees it after", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { createAgentNodePlacement } = await import(
			"./agent-node-placement.js"
		);
		runMock.mockResolvedValue({
			text: "done",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const placement = createAgentNodePlacement({
			nodes: [
				{
					id: "n1",
					priority: 1,
					capacity: 1,
					connection: { providerId: "opencoti", modelId: "worker-model" },
				},
			],
			base: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "lead-model",
			}),
		});
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "lead-model",
				nodePlacement: placement,
			} as never),
		});

		await tool.execute({ systemPrompt: "p", task: "t" }, {
			agentId: "parent",
			conversationId: "c",
			iteration: 1,
		} as never);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({ modelId: "worker-model" }),
		);
		// Released: the node is free for the next agent rather than held by one
		// that has already finished.
		expect(placement?.occupancy().get("n1") ?? 0).toBe(0);
	});

	it("creates a sub-agent, forwards callbacks, and returns normalized output", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "sub-agent result",
			iterations: 2,
			finishReason: "completed",
			usage: { inputTokens: 11, outputTokens: 7 },
		});

		const onSubAgentStart = vi.fn();
		const onSubAgentEnd = vi.fn();
		const createSubAgentTools = vi.fn().mockResolvedValue([]);
		const extensions = [
			{
				name: "sample-ext",
				manifest: { capabilities: ["hooks"] },
				hooks: { onEvent: vi.fn() },
			} as AgentExtension,
		];

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
				extensions,
			}),
			defaultMaxIterations: 4,
			createSubAgentTools,
			onSubAgentStart,
			onSubAgentEnd,
		});

		const output = await tool.execute(
			{
				systemPrompt: "You are focused",
				task: "Do delegated work",
			},
			{
				agentId: "parent-1",
				conversationId: "conv-parent",
				iteration: 3,
			},
		);

		expect(createSubAgentTools).toHaveBeenCalledTimes(1);
		expect(runMock).toHaveBeenCalledWith("Do delegated work");
		expect(onSubAgentStart).toHaveBeenCalledTimes(1);
		expect(onSubAgentEnd).toHaveBeenCalledTimes(1);
		expect(output).toEqual({
			text: "sub-agent result",
			iterations: 2,
			finishReason: "completed",
			usage: {
				inputTokens: 11,
				outputTokens: 7,
			},
		});
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				parentAgentId: "parent-1",
				maxIterations: 4,
				extensions,
			}),
		);
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.not.objectContaining({
				prepareTurn: expect.anything(),
			}),
		);
	});

	it("passes extension hooks through delegated config", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "sub-agent result",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const extensions = [
			{
				name: "before-start-ext",
				manifest: {
					capabilities: ["hooks"],
				},
				hooks: { beforeModel: vi.fn() },
			} as AgentExtension,
		];

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
				extensions,
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "You are focused",
				task: "Do delegated work",
			},
			{
				agentId: "parent-1",
				conversationId: "conv-parent",
				iteration: 3,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				extensions,
			}),
		);
	});

	it("propagates sub-agent errors and still reports onSubAgentEnd", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockRejectedValue(new Error("sub-agent failed"));
		const onSubAgentEnd = vi.fn();

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
			onSubAgentEnd,
		});

		await expect(
			tool.execute(
				{
					systemPrompt: "System",
					task: "Fail task",
				},
				{
					agentId: "parent-2",
					conversationId: "conv-parent",
					iteration: 1,
				},
			),
		).rejects.toThrow("sub-agent failed");

		expect(onSubAgentEnd).toHaveBeenCalledTimes(1);
		expect(onSubAgentEnd).toHaveBeenCalledWith(
			expect.objectContaining({
				parentAgentId: "parent-2",
				error: expect.any(Error),
			}),
		);
	});

	it("leaves maxIterations unset when neither input nor default is provided", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "sub-agent result",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "System",
				task: "Do task",
			},
			{
				agentId: "parent-3",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				maxIterations: undefined,
			}),
		);
	});

	it("appends workspace metadata for cline sub-agents when missing", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const workspaceMetadata = `# Workspace Configuration
{
  "workspaces": {
    "/repo/demo": {
      "hint": "demo"
    }
  }
}`;

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "cline",
				modelId: "anthropic/claude-sonnet-4.6",
				cwd: "/repo/demo",
				workspaceMetadata,
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "You are a specialist teammate.",
				task: "Investigate module boundaries",
			},
			{
				agentId: "parent-4",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPrompt: expect.stringContaining(workspaceMetadata),
			}),
		);
	});

	it("does not duplicate workspace metadata for cline sub-agents", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const inputSystemPrompt = `You are a specialist teammate.

# Workspace Configuration
{
  "workspaces": {
    "/repo/demo": {
      "hint": "demo"
    }
  }
}`;

		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "cline",
				modelId: "anthropic/claude-sonnet-4.6",
				cwd: "/repo/demo",
				workspaceMetadata: "# Workspace Configuration\n{}",
			}),
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: inputSystemPrompt,
				task: "Investigate module boundaries",
			},
			{
				agentId: "parent-5",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				systemPrompt: inputSystemPrompt,
			}),
		);
	});

	it("resolves connection settings lazily at execution time", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});

		const configProvider = createDelegatedAgentConfigProvider({
			providerId: "cline",
			modelId: "stale-model",
			apiKey: "oauth-access-old",
			temperature: 0.3,
		});
		const updateConnectionDefaults = vi.spyOn(
			configProvider,
			"updateConnectionDefaults",
		);
		configProvider.updateConnectionDefaults({
			apiKey: "oauth-access-new",
			modelId: "updated-model",
		});

		const tool = createSpawnAgentTool({
			configProvider,
			subAgentTools: [],
		});

		await tool.execute(
			{
				systemPrompt: "System",
				task: "Do task",
			},
			{
				agentId: "parent-6",
				conversationId: "conv-parent",
				iteration: 1,
			},
		);

		expect(updateConnectionDefaults).toHaveBeenCalledTimes(1);
		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				apiKey: "oauth-access-new",
				modelId: "updated-model",
				temperature: 0.3,
			}),
		);
	});

	// Each agent is its own engine session. Inheriting the lead's put 51 agents
	// into one 262,144-cell allocation and stopped 49 of them when it filled.
	it("runs every sub-agent in an engine session of its own", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "opencoti",
				modelId: "m",
				sessionId: "lead-session",
			} as never),
		});
		const context = {
			agentId: "parent",
			conversationId: "c",
			iteration: 1,
			sessionId: "lead-session",
		} as never;
		await tool.execute({ instructions: "role", task: "one" }, context);
		await tool.execute({ instructions: "role", task: "two" }, context);

		const ids = agentConstructorSpy.mock.calls.map(
			([config]) => (config as { engineSessionId?: string }).engineSessionId,
		);
		expect(ids[0]).toMatch(/^lead-session~agent-/);
		expect(ids[1]).toMatch(/^lead-session~agent-/);
		expect(ids[0]).not.toBe(ids[1]);
		// Telemetry still groups with the lead.
		expect(
			(agentConstructorSpy.mock.calls[0]?.[0] as { sessionId?: string })
				.sessionId,
		).toBe("lead-session");
		// No base URL, so no pool tree: nothing to attach to.
		expect(
			(agentConstructorSpy.mock.calls[0]?.[0] as { polykvWorker?: unknown })
				.polykvWorker,
		).toBeUndefined();
	});

	// On a PolyKV node the request is laid out for the pool tree: a fixed
	// system prompt, then knowledge, role and task as their own turns.
	it("lays a PolyKV agent out as shared layers under its lead's swarm", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runWithHeadMock.mockResolvedValue({
			text: "ok",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "opencoti",
				modelId: "m",
				baseUrl: "http://127.0.0.1:9/v1",
				sessionId: "lead-session",
			} as never),
		});
		await tool.execute(
			{
				knowledge: { text: "shared notes" },
				instructions: "You are a js-brace-fixer.",
				task: "check lines 1-10",
			},
			{
				agentId: "parent",
				conversationId: "c",
				iteration: 1,
				sessionId: "lead-session",
			} as never,
		);

		const config = agentConstructorSpy.mock.calls[0]?.[0] as {
			systemPrompt?: string;
			polykvWorker?: { group: string; layers: number };
		};
		expect(config.polykvWorker).toEqual({ group: "lead-session", layers: 2 });
		expect(config.systemPrompt).not.toContain("js-brace-fixer");
		const [head, task] = runWithHeadMock.mock.calls[0] ?? [];
		expect(head).toHaveLength(2);
		expect(head[0]).toContain("shared notes");
		expect(head[1]).toContain("js-brace-fixer");
		expect(task).toContain("check lines 1-10");
		expect(runMock).not.toHaveBeenCalled();
	});

	// sx4bp (pandorum, 2026-09-23): asked for 75 reports, the lead wrote 75
	// calls, each repeating the same knowledge and instructions. A list states
	// them once, and every agent still reports on its own row.
	it("runs every entry of `agents` as its own agent, each on its own row", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockImplementation(async (task: string) => ({
			text: `report for ${task}`,
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 3, outputTokens: 2 },
		}));
		const updates: unknown[] = [];
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
		});

		const output = (await tool.execute(
			{
				instructions: "You review code.",
				agents: [
					{ name: "one", task: "lines 1-50" },
					{ name: "two", task: "lines 51-100" },
				],
			},
			{
				agentId: "parent-1",
				conversationId: "conv-parent",
				iteration: 1,
				toolCallId: "call-7",
				sessionId: "lead",
				emitUpdate: (update: unknown) => updates.push(update),
			} as never,
		)) as { results: Array<{ name: string; text?: string }>; usage: unknown };

		expect(output.results.map((entry) => [entry.name, entry.text])).toEqual([
			["one", "report for lines 1-50"],
			["two", "report for lines 51-100"],
		]);
		expect(output.usage).toEqual({ inputTokens: 6, outputTokens: 4 });
		// Every update names its member, and each member has a stop of its own.
		const cancelIds = updates
			.filter((update) => (update as { cancelId?: string }).cancelId)
			.map((update) => update as { cancelId: string; member: number });
		expect(cancelIds.map((entry) => entry.member).sort()).toEqual([0, 1]);
		expect(new Set(cancelIds.map((entry) => entry.cancelId)).size).toBe(2);
	});

	it("runs an entry naming a configured agent through that agent's own tool", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const configuredExecute = vi.fn(async () => ({
			text: "configured report",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		}));
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			configuredAgents: () =>
				new Map([
					[
						"js_syntactic",
						{
							name: "subagent_js_syntactic",
							execute: configuredExecute,
						} as never,
					],
				]),
		});

		const output = (await tool.execute(
			{
				knowledge: { files: ["game.html"] },
				agents: [
					{ name: "a", task: "check braces", type: "subagent_js-syntactic" },
					{ name: "b", task: "x", type: "nonexistent" },
				],
			},
			{
				agentId: "p",
				conversationId: "c",
				iteration: 1,
				toolCallId: "t",
			} as never,
		)) as { results: Array<{ name: string; text?: string; error?: string }> };

		expect(output.results[0]?.text).toBe("configured report");
		const prompt = (configuredExecute.mock.calls[0] as unknown[])[0] as {
			prompt: string;
		};
		expect(prompt.prompt).toContain("game.html");
		expect(prompt.prompt).toContain("check braces");
		// One bad entry is its own failure, not the batch's.
		expect(output.results[1]?.error).toContain(
			'No configured agent named "nonexistent"',
		);
		expect(output.results[1]?.error).toContain("js_syntactic");
	});

	it("routes `merge` to the swarm, and offers it only when there is one", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const swarmExecute = vi.fn(async () => ({ digest: "merged", workers: 2 }));
		const provider = createDelegatedAgentConfigProvider({
			providerId: "anthropic",
			modelId: "mock-model",
		});
		const plain = createSpawnAgentTool({ configProvider: provider });
		const swarming = createSpawnAgentTool({
			configProvider: provider,
			swarm: { name: "spawn_swarm", execute: swarmExecute } as never,
		});
		const properties = (tool: { inputSchema: unknown }) =>
			Object.keys(
				(tool.inputSchema as { properties: Record<string, unknown> })
					.properties,
			);
		expect(properties(plain)).not.toContain("merge");
		expect(properties(swarming)).toEqual(
			expect.arrayContaining(["agents", "merge", "count"]),
		);

		const output = await swarming.execute(
			{
				instructions: "Find the bug.",
				merge: true,
				agents: [{ name: "a", task: "search src" }, { task: "search tests" }],
			},
			{ agentId: "p", conversationId: "c", iteration: 1 } as never,
		);

		expect(output).toEqual({ digest: "merged", workers: 2 });
		expect(swarmExecute).toHaveBeenCalledWith(
			{
				systemPrompt: "Find the bug.",
				tasks: [{ name: "a", task: "search src" }, { task: "search tests" }],
			},
			expect.anything(),
		);
		expect(runMock).not.toHaveBeenCalled();
	});
});
