import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A teammate runs in an engine session of its own, as a `spawn_agent` agent
 * does, and gives it back when it is shut down.
 *
 * It had none: the handler fell back to the conversation's id, so every
 * teammate request went out as the LEAD's engine session, and its compaction
 * read -- and re-rooted -- the lead's.
 */

const llms = vi.hoisted(() => ({
	createGateway: vi.fn(),
	createAgentModel: vi.fn(),
	releasePolykvAgent: vi.fn(async () => ({ closed: [], failed: [] })),
}));

vi.mock("@cline/llms", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cline/llms")>()),
	createGateway: llms.createGateway,
	releasePolykvAgent: llms.releasePolykvAgent,
}));

const { createAgentModelFromConfig } = await import(
	"../../../services/llms/handler-factory"
);
const { AgentTeamsRuntime } = await import("./multi-agent");
const { createAgentTeamsTools } = await import("./team-tools");
const { createDelegatedAgentConfigProvider } = await import(
	"./delegated-agent"
);

const lead = { agentId: "lead", conversationId: "c", iteration: 1 };

function team() {
	const runtime = new AgentTeamsRuntime({ teamName: "t" });
	const spawnSpy = vi.spyOn(runtime, "spawnTeammate");
	const tools = createAgentTeamsTools({
		runtime,
		requesterId: "lead",
		teammateConfigProvider: createDelegatedAgentConfigProvider({
			providerId: "opencoti",
			modelId: "m",
			baseUrl: "http://engine/v1",
			sessionId: "lead-session",
		}),
	});
	const spawn = (agentId: string) =>
		tools
			.find((tool) => tool.name === "team_spawn_teammate")
			?.execute({ agentId, rolePrompt: "Write" }, lead);
	const engineSessionOf = (index: number) =>
		spawnSpy.mock.calls[index]?.[0]?.config.engineSessionId;
	return { runtime, spawnSpy, spawn, engineSessionOf };
}

beforeEach(() => {
	llms.createGateway.mockReset();
	llms.createGateway.mockImplementation(() => ({
		createAgentModel: llms.createAgentModel,
	}));
	llms.releasePolykvAgent.mockClear();
});

describe("a teammate's engine session", () => {
	it("is the one its requests are sent in, not the lead's", async () => {
		const { runtime, spawnSpy, spawn } = team();
		await spawn("w");
		const config = spawnSpy.mock.calls[0]?.[0]?.config;

		createAgentModelFromConfig(config as never, undefined);

		const calls = llms.createGateway.mock.calls as unknown as Array<
			[{ providerConfigs: Array<{ options?: Record<string, unknown> }> }]
		>;
		const options = calls.at(-1)?.[0].providerConfigs[0].options ?? {};
		expect(options.polykvSessionId).toMatch(/^lead-session~teammate-w/);
		runtime.shutdownTeammate("w");
	});

	it("is released when the teammate is shut down", async () => {
		const { runtime, spawn, engineSessionOf } = team();
		await spawn("w");
		const own = engineSessionOf(0);
		expect(own).toBeDefined();

		runtime.shutdownTeammate("w");

		expect(llms.releasePolykvAgent).toHaveBeenCalledWith(own);
	});

	it("is released with the team, and a respawn gets a fresh one", async () => {
		const { runtime, spawn, engineSessionOf } = team();
		await spawn("w");
		runtime.shutdownTeammate("w");
		await spawn("w");
		const first = engineSessionOf(0);
		const second = engineSessionOf(1);
		expect(second).not.toBe(first);

		runtime.cleanup();

		expect(llms.releasePolykvAgent).toHaveBeenCalledWith(second);
	});
});
