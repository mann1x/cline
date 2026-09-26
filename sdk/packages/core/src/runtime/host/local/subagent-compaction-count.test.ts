import type { AgentEvent } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The per-agent compaction counter, through every delegated path.
 *
 * Each path builds its agent with `createDelegatedAgent` and wires the agent's
 * events through its own progress observer to the tool call's `emitUpdate`.
 * The stub agent compacts once while it runs, the way the compaction pipeline
 * announces it; each path must put the count on the row it reports to.
 */

const compacted: AgentEvent = {
	type: "notice",
	noticeType: "status",
	displayRole: "status",
	message: "auto-compacted",
	reason: "auto_compaction",
	metadata: {
		kind: "auto_compaction",
		cause: "pressure",
		phase: "completed",
		tokensBefore: 60_000,
		tokensAfter: 20_000,
	},
} as AgentEvent;

vi.mock("../../../extensions/tools/team/delegated-agent", async (original) => ({
	...(await original<
		typeof import("../../../extensions/tools/team/delegated-agent")
	>()),
	createDelegatedAgent: (options: {
		onEvent?: (event: AgentEvent) => void;
	}) => {
		const run = async () => {
			options.onEvent?.(compacted);
			return {
				text: "done",
				iterations: 1,
				finishReason: "completed",
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		};
		return {
			run,
			runWithHead: run,
			getAgentId: () => "sub-agent",
			getConversationId: () => "sub-conversation",
			subscribeEvents: () => () => {},
		};
	},
}));

const { createSessionSpawnTool, createSessionSwarmTool } = await import(
	"./spawn-tool"
);
const { createConfiguredAgentTools } = await import(
	"../../../extensions/tools/team/configured-agent-tool"
);

const deps = {
	getSession: () => undefined,
	subAgentStarts: new Map(),
	onAgentEvent: () => {},
	invokeBackendOptional: async () => {},
} as never;

const sessionConfig = {
	providerId: "ollama",
	modelId: "m",
	cwd: "/tmp",
	// Nothing listens: no pool, no capacity -- the unpooled case.
	baseUrl: "http://127.0.0.1:9",
	enableTools: false,
} as never;

type Executable = {
	execute: (input: unknown, context: unknown) => Promise<unknown>;
};

const countedFields = {
	compactions: 1,
	compactionsByCause: { pressure: 1 },
	lastCompaction: {
		cause: "pressure",
		tokensBefore: 60_000,
		tokensAfter: 20_000,
	},
};
const counted = expect.objectContaining(countedFields);
const countedFor = (member: number) =>
	expect.objectContaining({ ...countedFields, member });

function context(updates: unknown[]) {
	return {
		agentId: "lead",
		conversationId: "c",
		iteration: 1,
		sessionId: "lead-session",
		toolCallId: "call-1",
		emitUpdate: (update: unknown) => updates.push(update),
	};
}

describe("a delegated agent's compactions reach its row", () => {
	let updates: unknown[];
	beforeEach(() => {
		updates = [];
	});

	it("from spawn_agent", async () => {
		const tool = createSessionSpawnTool(
			deps,
			sessionConfig,
			"lead-session",
		) as unknown as Executable;
		await tool.execute({ systemPrompt: "s", task: "t" }, context(updates));
		expect(updates).toContainEqual(counted);
	});

	it("from each member of a spawn_agent batch, on the member's own row", async () => {
		const tool = createSessionSpawnTool(
			deps,
			sessionConfig,
			"lead-session",
		) as unknown as Executable;
		await tool.execute(
			{
				wait: true,
				agents: [
					{ name: "a", task: "one" },
					{ name: "b", task: "two" },
				],
			},
			context(updates),
		);
		expect(updates).toContainEqual(countedFor(0));
		expect(updates).toContainEqual(countedFor(1));
	});

	it("from a swarm worker", async () => {
		const swarm = createSessionSwarmTool(
			deps,
			sessionConfig,
			"lead-session",
		) as unknown as Executable;
		await swarm.execute(
			{ wait: true, systemPrompt: "s", tasks: [{ name: "w1", task: "a" }] },
			context(updates),
		);
		expect(updates).toContainEqual(countedFor(0));
	});

	it("from a merged spawn_agent, which runs as a swarm", async () => {
		const swarm = createSessionSwarmTool(deps, sessionConfig, "lead-session");
		const tool = createSessionSpawnTool(
			deps,
			sessionConfig,
			"lead-session",
			undefined,
			{ swarm } as never,
		) as unknown as Executable;
		await tool.execute(
			{
				wait: true,
				merge: true,
				agents: [
					{ name: "a", task: "one" },
					{ name: "b", task: "two" },
				],
			},
			context(updates),
		);
		expect(updates).toContainEqual(countedFor(0));
		expect(updates).toContainEqual(countedFor(1));
	});

	it("from a configured agent", async () => {
		const [tool] = createConfiguredAgentTools({
			configProvider: {
				getRuntimeConfig: () => ({ providerId: "ollama", modelId: "m" }),
				getConnectionConfig: () => ({ providerId: "ollama", modelId: "m" }),
				updateConnectionDefaults: () => {},
			},
			agents: [
				{
					name: "reviewer",
					description: "Reviews code",
					systemPrompt: "You review.",
				},
			],
		} as never);
		await (tool as unknown as Executable).execute(
			{ task: "review it" },
			context(updates),
		);
		expect(updates).toContainEqual(counted);
	});
});
