import type { AgentConfig } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SpawnBatchIndexEntry, SpawnBatchReport } from "./batch-report";
import { createDelegatedAgentConfigProvider } from "./delegated-agent";

type AgentExtension = NonNullable<AgentConfig["extensions"]>[number];

const runMock = vi.fn();
const runWithHeadMock = vi.fn();
const getAgentIdMock = vi.fn(() => "sub-agent-1");
const getConversationIdMock = vi.fn(() => "conv-sub-1");
const agentConstructorSpy = vi.fn();
const continueMock = vi.fn();
const setMaxIterationsMock = vi.fn();
const abortMock = vi.fn();

vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => {
	return {
		SessionRuntime: class MockSessionRuntime {
			constructor(config: unknown) {
				agentConstructorSpy(config);
				this.cap = (config as { maxIterations?: number }).maxIterations;
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

			async continue(message?: string): Promise<unknown> {
				return continueMock(message);
			}

			private cap: number | undefined;

			getMaxIterations(): number | undefined {
				return this.cap;
			}

			setMaxIterations(value: number | undefined): void {
				this.cap = value;
				setMaxIterationsMock(value);
			}

			abort(reason?: unknown): void {
				abortMock(reason);
			}
		},
	};
});

// The worker struggle supervisor watched only swarm workers. A spawn_agent
// agent grinds the same way, and gets the same nudge and the same stop -- a
// stop that ends the run with the supervisor's words, for the lead to decide.
describe("a spawned agent's struggle supervisor", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("nudges a grinding agent on a tool result, then stops the run in its own words", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { isWorkerStruggleStop } = await import(
			"../../../runtime/safety/worker-struggle.js"
		);
		let nudged = "";
		runMock.mockImplementation(async () => {
			const config = agentConstructorSpy.mock.calls.at(-1)?.[0] as {
				onEvent?: (event: unknown) => void;
				tools: Array<{
					name: string;
					execute: (i: unknown, c: unknown) => Promise<unknown>;
				}>;
			};
			const spent = (iteration: number) => {
				config.onEvent?.({ type: "iteration_start", iteration });
				config.onEvent?.({
					type: "content_end",
					contentType: "reasoning",
					reasoning:
						"Let me probe once more.\n\nI have used my thinking budget. I must stop analysing now.",
				});
				config.onEvent?.({
					type: "iteration_end",
					iteration,
					hadToolCalls: true,
					toolCallCount: 1,
				});
			};
			for (let iteration = 1; iteration <= 3; iteration += 1) {
				spent(iteration);
			}
			const probe = config.tools.find((entry) => entry.name === "probe");
			nudged = String(await probe?.execute({}, {}));
			for (let iteration = 4; iteration <= 10; iteration += 1) {
				spent(iteration);
			}
			return {
				text: "so far",
				iterations: 10,
				finishReason: "completed",
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		});
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "lead-model",
			}),
			createSubAgentTools: () => [
				{
					name: "probe",
					description: "",
					inputSchema: { type: "object" },
					execute: async () => "probed",
				} as never,
			],
		});
		await tool.execute({ systemPrompt: "p", task: "t" }, {
			agentId: "parent",
			conversationId: "c",
			iteration: 1,
		} as never);
		expect(nudged).toContain("probed");
		expect(nudged).toContain("SUMMARY");
		expect(abortMock).toHaveBeenCalledTimes(1);
		const reason = abortMock.mock.calls[0]?.[0] as Error;
		expect(isWorkerStruggleStop(reason.message)).toBe(true);
	});
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

	// #78: the node decides the model, and the row has to say which one while
	// the agent runs -- not only once the result names it.
	it("reports the placed node's provider and model before the agent finishes", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { createAgentNodePlacement } = await import(
			"./agent-node-placement.js"
		);
		const updates: unknown[] = [];
		let updatesWhileRunning: unknown[] = [];
		runMock.mockImplementation(async () => {
			updatesWhileRunning = [...updates];
			return {
				text: "done",
				iterations: 1,
				finishReason: "completed",
				usage: { inputTokens: 1, outputTokens: 1 },
			};
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
			emitUpdate: (update: unknown) => updates.push(update),
		} as never);

		expect(updatesWhileRunning).toContainEqual({
			providerId: "opencoti",
			modelId: "worker-model",
		});
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
			// What `resume_agent` and the status tool name it by, and its cap.
			agentId: "sub-agent-1",
			maxIterations: 4,
			// Section F: every result says how it ended and what it spent.
			agent: expect.objectContaining({
				state: "done",
				stopReason: "completed",
				iterations: 2,
				maxIterations: 4,
				tokens: { input: 11, output: 7 },
			}),
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
	// pandorum 2026-09-24: agents stuck on streams a server restart dropped.
	// Restart runs the agent again inside the same call; the lead gets the
	// second attempt's report, not "stopped".
	it("runs a restarted agent again and reports the new attempt", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { subagentCancellation } = await import("./subagent-cancellation.js");
		let calls = 0;
		runMock.mockImplementation(async () => {
			calls += 1;
			if (calls === 1) {
				expect(subagentCancellation.restart("lead::call-9")).toBe(true);
				return {
					text: "",
					iterations: 1,
					finishReason: "aborted",
					usage: { inputTokens: 1, outputTokens: 0 },
				};
			}
			return {
				text: "fresh report",
				iterations: 1,
				finishReason: "completed",
				usage: { inputTokens: 3, outputTokens: 2 },
			};
		});
		const updates: unknown[] = [];
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
		});
		const output = (await tool.execute(
			{ instructions: "You review code.", task: "lines 1-50" },
			{
				agentId: "parent-1",
				conversationId: "conv-parent",
				iteration: 1,
				toolCallId: "call-9",
				sessionId: "lead",
				emitUpdate: (update: unknown) => updates.push(update),
			} as never,
		)) as { text?: string; finishReason?: string };

		expect(calls).toBe(2);
		expect(output).toMatchObject({
			text: "fresh report",
			finishReason: "completed",
		});
		expect(updates).toContainEqual(
			expect.objectContaining({
				activity: { text: "Restarted: starting again from its task" },
			}),
		);
	});

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
				wait: true,
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
		)) as SpawnBatchReport;

		expect(output.reports.map((entry) => [entry.name, entry.text])).toEqual([
			["one", "report for lines 1-50"],
			["two", "report for lines 51-100"],
		]);
		const index = output.agents as SpawnBatchIndexEntry[];
		expect(index.map((entry) => [entry.name, entry.status])).toEqual([
			["one", "completed"],
			["two", "completed"],
		]);
		expect(output.usage).toEqual({ inputTokens: 6, outputTokens: 4 });
		// Every update names its member, and each member has a stop of its own.
		const cancelIds = updates
			.filter((update) => (update as { cancelId?: string }).cancelId)
			.map((update) => update as { cancelId: string; member: number });
		expect(cancelIds.map((entry) => entry.member).sort()).toEqual([0, 1]);
		expect(new Set(cancelIds.map((entry) => entry.cancelId)).size).toBe(2);
	});

	// The lead's evaluation of swarm 0926: after compaction it no longer had
	// the tasks it had given. A batch is a round that keeps them.
	it("opens a round that keeps each agent's task, and names every agent by id", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { roundsFor, __resetAgentRounds } = await import("./agent-rounds.js");
		__resetAgentRounds();
		runMock.mockImplementation(async (task: string) => ({
			text: `report for ${task}`,
			iterations: 2,
			finishReason: "completed",
			usage: { inputTokens: 3, outputTokens: 2 },
		}));
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
		});
		const output = (await tool.execute(
			{
				knowledge: { files: ["a.js"] },
				instructions: "You review code.",
				wait: true,
				agents: [
					{ name: "one", task: "lines 1-50" },
					{ name: "two", task: "lines 51-100" },
				],
			},
			{
				agentId: "parent-1",
				iteration: 1,
				toolCallId: "call-8",
				sessionId: "lead-rounds",
			} as never,
		)) as SpawnBatchReport;
		expect(output.round).toBe("r1");
		expect(
			(output.agents as SpawnBatchIndexEntry[]).map((entry) => entry.id),
		).toEqual(["r1-1", "r1-2"]);
		expect(output.reports[0]?.facts).toMatch(/^done \(completed\)/);
		const round = roundsFor("lead-rounds").get("r1");
		expect(round?.shared).toMatchObject({
			knowledge: { files: ["a.js"] },
			instructions: "You review code.",
		});
		expect(round?.agents.map((agent) => [agent.task, agent.state])).toEqual([
			["lines 1-50", "done"],
			["lines 51-100", "done"],
		]);
		expect(round?.delivered).toBe(true);
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
				wait: true,
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
		)) as SpawnBatchReport;

		expect(output.reports[0]?.text).toBe("configured report");
		const prompt = (configuredExecute.mock.calls[0] as unknown[])[0] as {
			prompt: string;
		};
		expect(prompt.prompt).toContain("game.html");
		expect(prompt.prompt).toContain("check braces");
		// One bad entry is its own failure, not the batch's.
		expect(output.agents[1]).toMatchObject({
			name: "b",
			status: "errored",
			failureClass: "task",
		});
		expect((output.agents[1] as SpawnBatchIndexEntry).error).toContain(
			'No configured agent named "nonexistent"',
		);
		expect(output.reports[1]?.text).toContain("js_syntactic");
		expect(output.summary.byType).toMatchObject({
			"subagent_js-syntactic": { total: 1, completed: 1 },
			nonexistent: { total: 1, errored: 1 },
		});
	});

	it("counts the evictions each agent's row reported into the round report", async () => {
		// The turn-fault recovery puts `evicted` on the row for every eviction
		// (an engine bug each time); the round report states them, with or
		// without a host listening to the rows.
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const configuredExecute = vi.fn(
			async (
				_input: unknown,
				context: { emitUpdate?: (u: unknown) => void },
			) => {
				context.emitUpdate?.({ latestOutput: "evicted", evicted: 1 });
				context.emitUpdate?.({ latestOutput: "evicted", evicted: 2 });
				return {
					text: "configured report",
					iterations: 1,
					finishReason: "completed",
					usage: { inputTokens: 1, outputTokens: 1 },
				};
			},
		);
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "mock-model",
			}),
			configuredAgents: () =>
				new Map([
					[
						"coder",
						{ name: "subagent_coder", execute: configuredExecute } as never,
					],
				]),
		});

		const output = (await tool.execute(
			{ agents: [{ name: "a", task: "fix it", type: "coder" }] },
			{
				agentId: "p",
				conversationId: "c",
				iteration: 1,
				toolCallId: "t",
			} as never,
		)) as SpawnBatchReport;

		expect(output.summary.evicted).toBe(2);
		expect(output.agents[0]).toMatchObject({ name: "a", evicted: 2 });
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

	describe("temperature and seed", () => {
		const completed = {
			text: "done",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		};
		const builtSamplers = () =>
			agentConstructorSpy.mock.calls.map((call) => {
				const config = call[0] as AgentConfig & {
					providerConfig?: { sampling?: Record<string, unknown> };
				};
				return {
					temperature: config.temperature,
					sampling: config.providerConfig?.sampling,
				};
			});
		const context = {
			agentId: "p",
			conversationId: "c",
			iteration: 1,
			toolCallId: "t",
		} as never;

		it("builds the agent with the call's sampler and reports it", async () => {
			const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
			runMock.mockResolvedValue(completed);
			const tool = createSpawnAgentTool({
				configProvider: createDelegatedAgentConfigProvider({
					providerId: "anthropic",
					modelId: "m",
				}),
			});
			const output = await tool.execute(
				{ task: "t", temperature: 0.25, seed: 9 },
				context,
			);
			expect(builtSamplers()).toEqual([
				{ temperature: 0.25, sampling: { temperature: 0.25, seed: 9 } },
			]);
			expect(output).toMatchObject({
				sampling: { temperature: 0.25, seed: 9 },
			});
		});

		it("writes nothing when the call names neither", async () => {
			const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
			runMock.mockResolvedValue(completed);
			const tool = createSpawnAgentTool({
				configProvider: createDelegatedAgentConfigProvider({
					providerId: "anthropic",
					modelId: "m",
				}),
			});
			const output = await tool.execute({ task: "t" }, context);
			expect(builtSamplers()).toEqual([
				{ temperature: undefined, sampling: undefined },
			]);
			expect(output).not.toHaveProperty("sampling");
		});

		it("gives an entry with count 3 and seed 7 the seeds 7, 8 and 9", async () => {
			const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
			runMock.mockResolvedValue(completed);
			const tool = createSpawnAgentTool({
				configProvider: createDelegatedAgentConfigProvider({
					providerId: "anthropic",
					modelId: "m",
				}),
			});
			await tool.execute(
				{
					agents: [
						{ name: "w", task: "t", count: 3, seed: 7, temperature: 0.5 },
					],
				},
				context,
			);
			const built = builtSamplers();
			expect(built.map((entry) => entry.sampling?.seed).sort()).toEqual([
				7, 8, 9,
			]);
			expect(built.every((entry) => entry.temperature === 0.5)).toBe(true);
		});

		it("offsets the call's seed by each agent's index, under an entry's own", async () => {
			const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
			runMock.mockImplementation(async (task: string) => ({
				...completed,
				text: task,
			}));
			const tool = createSpawnAgentTool({
				configProvider: createDelegatedAgentConfigProvider({
					providerId: "anthropic",
					modelId: "m",
				}),
			});
			await tool.execute(
				{
					seed: 100,
					temperature: 0.7,
					agents: [
						{ name: "a", task: "a" },
						{ name: "b", task: "b" },
						{ name: "c", task: "c", seed: 5, temperature: 0 },
					],
				},
				context,
			);
			const byTask = new Map(
				runMock.mock.calls.map((call, index) => [
					call[0] as string,
					builtSamplers()[index]?.sampling,
				]),
			);
			expect(byTask.get("a")).toEqual({ temperature: 0.7, seed: 100 });
			expect(byTask.get("b")).toEqual({ temperature: 0.7, seed: 101 });
			expect(byTask.get("c")).toEqual({ temperature: 0, seed: 5 });
		});

		it("draws a random seed and temperature per agent and reports each on its row", async () => {
			const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
			runMock.mockResolvedValue(completed);
			const tool = createSpawnAgentTool({
				configProvider: createDelegatedAgentConfigProvider({
					providerId: "anthropic",
					modelId: "m",
					providerConfig: {
						providerId: "anthropic",
						modelId: "m",
						sampling: { temperature: 0.7 },
					} as never,
				}),
			});
			const updates: Array<Record<string, unknown>> = [];
			const output = (await tool.execute(
				{
					wait: true,
					agents: [
						{
							name: "w",
							task: "t",
							count: 4,
							seed: "random",
							temperature: "random",
						},
					],
				} as never,
				{
					...(context as object),
					emitUpdate: (update: unknown) =>
						updates.push(update as Record<string, unknown>),
				} as never,
			)) as { results?: Array<{ sampling?: Record<string, unknown> }> };
			// One sampling update per agent, on that agent's row.
			const rows = updates.filter((update) => update.sampling);
			expect(rows.map((row) => row.member).sort()).toEqual([0, 1, 2, 3]);
			const seeds = new Set(
				rows.map((row) => (row.sampling as { seed: number }).seed),
			);
			expect(seeds.size).toBe(4);
			for (const row of rows) {
				const sampling = row.sampling as {
					temperature: number;
					temperatureBase: number;
					temperatureRange: number;
					seedRandom: boolean;
				};
				expect(sampling).toMatchObject({
					seedRandom: true,
					temperatureBase: 0.7,
					temperatureRange: 2,
				});
				expect(sampling.temperature).toBeGreaterThanOrEqual(0.686 - 0.0005);
				expect(sampling.temperature).toBeLessThanOrEqual(0.714 + 0.0005);
			}
			// And what was built is what was reported.
			const built = builtSamplers().map((entry) => entry.sampling?.seed);
			expect(new Set(built)).toEqual(seeds);
			// The rows' final reports carry the same values.
			const finished = updates
				.map((update) => update.finished as { sampling?: unknown } | undefined)
				.filter(Boolean);
			expect(finished).toHaveLength(4);
			expect(
				new Set(
					finished.map((entry) => (entry?.sampling as { seed: number }).seed),
				),
			).toEqual(seeds);
			expect(output).toBeDefined();
		});

		it("returns a single agent's realized sampler in its result", async () => {
			const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
			runMock.mockResolvedValue(completed);
			const tool = createSpawnAgentTool({
				configProvider: createDelegatedAgentConfigProvider({
					providerId: "anthropic",
					modelId: "m",
				}),
			});
			const output = await tool.execute(
				{ task: "t", temperature: 1, temperature_range: 10, seed: 4 } as never,
				context,
			);
			const sampling = (output as { sampling?: Record<string, number> })
				.sampling;
			expect(sampling).toMatchObject({
				seed: 4,
				temperatureBase: 1,
				temperatureRange: 10,
			});
			expect(sampling?.temperature).toBeGreaterThanOrEqual(0.9);
			expect(sampling?.temperature).toBeLessThanOrEqual(1.1);
			expect(builtSamplers()[0]?.temperature).toBe(sampling?.temperature);
		});

		it("hands a configured agent's entry its sampler", async () => {
			const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
			const configuredExecute = vi.fn(async () => completed);
			const tool = createSpawnAgentTool({
				configProvider: createDelegatedAgentConfigProvider({
					providerId: "anthropic",
					modelId: "m",
				}),
				configuredAgents: () =>
					new Map([
						["coder", { name: "subagent_coder", execute: configuredExecute }],
					]) as never,
			});
			await tool.execute(
				{ agents: [{ task: "t", type: "coder", count: 2, seed: 3 }] },
				context,
			);
			const seeds = configuredExecute.mock.calls
				.map((call) => ((call as unknown[])[0] as { seed?: number }).seed)
				.sort();
			expect(seeds).toEqual([3, 4]);
		});

		it("keeps the call's sampler on the node the agent was placed on", async () => {
			const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
			const { createAgentNodePlacement } = await import(
				"./agent-node-placement.js"
			);
			runMock.mockResolvedValue(completed);
			const base = createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "lead-model",
				temperature: 0.9,
			});
			const placement = createAgentNodePlacement({
				nodes: [
					{
						id: "n1",
						priority: 1,
						capacity: 1,
						connection: {
							providerId: "opencoti",
							modelId: "worker-model",
							temperature: undefined,
							providerConfig: {
								providerId: "opencoti",
								modelId: "worker-model",
								sampling: { temperature: 0.6, seed: 1, topK: 20 },
							},
						} as never,
					},
				],
				base,
			});
			const tool = createSpawnAgentTool({
				configProvider: createDelegatedAgentConfigProvider({
					providerId: "anthropic",
					modelId: "lead-model",
					temperature: 0.9,
					nodePlacement: placement,
				} as never),
			});
			await tool.execute({ task: "t", temperature: 0.1, seed: 42 }, context);
			expect(agentConstructorSpy).toHaveBeenCalledWith(
				expect.objectContaining({ modelId: "worker-model", temperature: 0.1 }),
			);
			expect(builtSamplers()[0]?.sampling).toEqual({
				temperature: 0.1,
				seed: 42,
				topK: 20,
			});
		});
	});
});

describe("spawn_agent's iteration cap and check", () => {
	const doneResult = (
		text: string,
		iterations: number,
		finishReason = "completed",
	) => ({
		text,
		iterations,
		finishReason,
		usage: { inputTokens: iterations, outputTokens: iterations },
	});

	beforeEach(async () => {
		vi.clearAllMocks();
		const { __resetAwaitingLead } = await import("./agent-iteration-cap.js");
		__resetAwaitingLead();
	});

	it("builds each agent with its own cap, an entry's over the call's", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockResolvedValue(doneResult("ok", 1));
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "m",
			}),
		});
		await tool.execute(
			{
				max_iterations: 12,
				agents: [
					{ name: "a", task: "t" },
					{ name: "b", task: "t", max_iterations: "30" },
				],
			} as never,
			{ agentId: "p", conversationId: "c", iteration: 1 } as never,
		);
		const caps = agentConstructorSpy.mock.calls
			.map((call) => (call[0] as { maxIterations?: number }).maxIterations)
			.sort((x, y) => (x ?? 0) - (y ?? 0));
		expect(caps).toEqual([12, 30]);
	});

	it("refuses a cap that is not a number of turns", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "m",
			}),
		});
		await expect(
			tool.execute(
				{ task: "t", max_iterations: 0 } as never,
				{
					agentId: "p",
					conversationId: "c",
					iteration: 1,
				} as never,
			),
		).rejects.toThrow(/max_iterations/);
		expect(agentConstructorSpy).not.toHaveBeenCalled();
	});

	it("tells the agent its check up front and judges it at completion, in its sandbox", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const launched: string[] = [];
		runMock.mockImplementation(async () => {
			const config = agentConstructorSpy.mock.calls.at(-1)?.[0] as AgentConfig;
			const verdict = await config.completionPolicy?.onCompletionAttempt?.({
				text: "done",
			});
			expect(verdict).toBeUndefined();
			return doneResult("fixed it", 2);
		});
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "m",
				cwd: process.cwd(),
			}),
			commandSandboxFor: (toolCallId) =>
				toolCallId === "call_1"
					? {
							cwd: process.cwd(),
							wrapSpawn: (spec) => {
								launched.push(spec.args.join(" "));
								return spec;
							},
						}
					: undefined,
		});
		const output = (await tool.execute(
			{
				task: "fix the braces",
				check: { command: "echo all-good", expect: "^all-good" },
			} as never,
			{
				agentId: "p",
				conversationId: "c",
				iteration: 1,
				toolCallId: "call_1",
			} as never,
		)) as { oracle?: unknown };
		const task = runMock.mock.calls[0]?.[0] as string;
		expect(task).toContain("fix the braces");
		expect(task).toContain("`echo all-good`");
		expect(task).toContain("run_commands");
		expect(launched).toEqual(["-c echo all-good"]);
		expect(output.oracle).toMatchObject({
			status: "pass",
			exitCode: 0,
			output: "all-good",
		});
	});

	it("reports a check it had no sandbox to run in as not run", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		runMock.mockImplementation(async () => {
			const config = agentConstructorSpy.mock.calls.at(-1)?.[0] as AgentConfig;
			await config.completionPolicy?.onCompletionAttempt?.({ text: "done" });
			return doneResult("done", 1);
		});
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "m",
			}),
		});
		const output = (await tool.execute(
			{ task: "t", check: { command: "echo x", expect: "x" } } as never,
			{ agentId: "p", conversationId: "c", iteration: 1 } as never,
		)) as { oracle?: unknown };
		expect(runMock.mock.calls[0]?.[0]).toContain("will not be run");
		expect(output.oracle).toMatchObject({
			status: "not_run",
			reason: "no command sandbox",
		});
	});

	it("waits at its cap for the lead, and goes on when resumed", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { onLeadNudge } = await import("./agent-trouble.js");
		const { listAwaitingLead, resumeSuspended } = await import(
			"./agent-iteration-cap.js"
		);
		const stopListening = onLeadNudge("lead", () => {});
		runMock.mockResolvedValue(doneResult("halfway", 4, "max_iterations"));
		continueMock.mockResolvedValue(doneResult("finished", 3));
		const updates: unknown[] = [];
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "m",
			}),
		});
		const running = tool.execute(
			{ name: "fixer", task: "t", max_iterations: 4 } as never,
			{
				agentId: "p",
				conversationId: "c",
				iteration: 1,
				sessionId: "lead",
				toolCallId: "call_1",
				emitUpdate: (update: unknown) => updates.push(update),
			} as never,
		) as unknown as Promise<Record<string, unknown>>;
		await vi.waitFor(() => expect(listAwaitingLead("lead")).toHaveLength(1));
		expect(updates).toContainEqual({
			awaitingLead: { iterations: 4, maxIterations: 4 },
		});
		expect(resumeSuspended("fixer", 5, "lead").ok).toBe(true);
		const output = await running;
		expect(setMaxIterationsMock).toHaveBeenCalledWith(5);
		expect(output).toMatchObject({
			text: "finished",
			iterations: 7,
			maxIterations: 9,
			finishReason: "completed",
			agentId: "sub-agent-1",
		});
		expect(output.stopReason).toBeUndefined();
		stopListening();
	});

	it("returns an agent it cannot ask the lead about as awaiting_lead, and keeps its workspace", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { resumeSuspended } = await import("./agent-iteration-cap.js");
		runMock.mockResolvedValue(doneResult("halfway", 4, "max_iterations"));
		continueMock.mockResolvedValue(doneResult("finished", 2));
		const onSubAgentEnd = vi.fn();
		const onSubAgentSettled = vi.fn();
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "m",
			}),
			onSubAgentEnd,
			onSubAgentSettled,
		});
		const output = (await tool.execute(
			{ name: "solo", task: "t", max_iterations: 4 } as never,
			{
				agentId: "p",
				conversationId: "c",
				iteration: 1,
				sessionId: "nobody-listening",
				toolCallId: "call_1",
			} as never,
		)) as unknown as Record<string, unknown>;
		expect(output).toMatchObject({
			state: "awaiting_lead",
			stopReason: "iteration_cap",
			iterations: 4,
			maxIterations: 4,
		});
		expect(String(output.text)).toContain("resume_agent");
		// Its workspace is not handed back and disposed while it waits.
		expect(onSubAgentEnd).not.toHaveBeenCalled();
		expect(onSubAgentSettled).not.toHaveBeenCalled();

		const resumed = resumeSuspended("solo", 3, "nobody-listening");
		const final = await resumed.completion;
		expect(final?.result.text).toBe("finished");
		await vi.waitFor(() => expect(onSubAgentSettled).toHaveBeenCalledTimes(1));
		expect(onSubAgentEnd).toHaveBeenCalledWith(
			expect.objectContaining({
				result: expect.objectContaining({ text: "finished", iterations: 6 }),
			}),
		);
	});
});

// Lead-agent-control spec, A: `wait: false` returns the round at once, and
// the agent's row hears of its end when it comes, as a batch member's does.
describe("spawn_agent in the background", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns the round at once and ends the agent's row when it finishes", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { __resetAgentRounds, roundsFor } = await import("./agent-rounds.js");
		let finish: () => void = () => {};
		runMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = () =>
						resolve({
							text: "background work done",
							iterations: 1,
							finishReason: "completed",
							usage: { inputTokens: 1, outputTokens: 1 },
						});
				}),
		);
		const updates: Array<Record<string, unknown>> = [];
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "lead-model",
			}),
		});
		const ack = (await tool.execute(
			{ systemPrompt: "p", task: "t", name: "bg", wait: false },
			{
				agentId: "parent",
				conversationId: "c",
				iteration: 1,
				sessionId: "bg-session",
				toolCallId: "call-bg",
				emitUpdate: (update: unknown) =>
					updates.push(update as Record<string, unknown>),
			} as never,
		)) as unknown as Record<string, unknown>;
		expect(ack).toMatchObject({
			background: true,
			round: "r1",
			agents: [{ id: "r1-1", name: "bg" }],
		});
		await vi.waitFor(() => expect(runMock).toHaveBeenCalled());
		finish();
		await vi.waitFor(() =>
			expect(roundsFor("bg-session").get("r1")?.status).toBe("done"),
		);
		expect(updates.at(-1)).toMatchObject({
			finished: { text: "background work done" },
		});
		__resetAgentRounds();
	});

	// Ruling 2: the lead is not held for a long job. Measured 2026-09-26: a
	// 75-agent batch that blocked left the lead answering stuck-agent reports
	// in side turns for its whole run.
	it("runs several agents in the background unless told to wait", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { __resetAgentRounds } = await import("./agent-rounds.js");
		runMock.mockImplementation(() => new Promise(() => {}));
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "lead-model",
			}),
		});
		const ack = (await tool.execute(
			{
				systemPrompt: "p",
				agents: [
					{ name: "a", task: "one" },
					{ name: "b", task: "two" },
				],
			},
			{
				agentId: "parent",
				conversationId: "c",
				iteration: 1,
				sessionId: "bg-batch",
				toolCallId: "call-batch",
			} as never,
		)) as unknown as Record<string, unknown>;
		expect(ack).toMatchObject({ background: true, round: "r1" });
		__resetAgentRounds();
	});

	// pandorum 2026-09-26: `wait: true` on 50 agents held the lead for the
	// whole round, and the user's steers queued behind it.
	it("lets a message for the lead end a `wait: true` batch, which goes on in the background", async () => {
		const { createSpawnAgentTool } = await import("./spawn-agent-tool.js");
		const { __resetAgentRounds, roundsFor } = await import("./agent-rounds.js");
		const finishers: Array<() => void> = [];
		runMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishers.push(() =>
						resolve({
							text: "done",
							iterations: 1,
							finishReason: "completed",
							usage: { inputTokens: 1, outputTokens: 1 },
						}),
					);
				}),
		);
		const tool = createSpawnAgentTool({
			configProvider: createDelegatedAgentConfigProvider({
				providerId: "anthropic",
				modelId: "lead-model",
			}),
		});
		const turn = new AbortController();
		const call = tool.execute(
			{
				systemPrompt: "p",
				wait: true,
				agents: [
					{ name: "a", task: "one" },
					{ name: "b", task: "two" },
				],
			},
			{
				agentId: "parent",
				conversationId: "c",
				iteration: 1,
				sessionId: "woken-batch",
				toolCallId: "call-woken",
				signal: turn.signal,
			} as never,
		);
		const rounds = roundsFor("woken-batch");
		await vi.waitFor(() => expect(rounds.leadAwaiting).toBe(true));
		expect(rounds.wakeAwaits()).toBe(true);
		const ack = (await call) as unknown as Record<string, unknown>;
		expect(ack).toMatchObject({ background: true, round: "r1" });
		expect(String(ack.note)).toContain("A message for you arrived");
		expect(rounds.leadBlocked).toBe(false);
		// The lead's turn ending does not stop the agents it left running.
		turn.abort("turn over");
		await vi.waitFor(() => expect(finishers).toHaveLength(2));
		const delivered: string[] = [];
		rounds.onSettled((round) => delivered.push(round.record.id));
		for (const finish of finishers) {
			finish();
		}
		await vi.waitFor(() => expect(rounds.get("r1")?.status).toBe("done"));
		expect(delivered).toEqual(["r1"]);
		__resetAgentRounds();
	});
});
