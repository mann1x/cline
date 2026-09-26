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

	it("is released as soon as a task ends, and kept for the next one", async () => {
		// opencoti mail #322: every resident sequence keeps its SWA window,
		// idle ones too. A teammate that waits for its next task holds nothing.
		const { runtime, spawn, engineSessionOf } = team();
		await spawn("w");
		const own = engineSessionOf(0);
		const member = (
			runtime as unknown as {
				members: Map<
					string,
					{ agent: { canStartRun: () => boolean; run: unknown } }
				>;
			}
		).members.get("w");
		if (!member) {
			throw new Error("no teammate");
		}
		member.agent.canStartRun = () => true;
		member.agent.run = async () => ({
			text: "done",
			finishReason: "completed",
			iterations: 1,
			usage: { inputTokens: 1, outputTokens: 1 },
			messages: [],
			toolCalls: [],
		});

		await runtime.routeToTeammate("w", "task one");
		expect(llms.releasePolykvAgent).toHaveBeenCalledTimes(1);
		expect(llms.releasePolykvAgent).toHaveBeenCalledWith(own);

		await runtime.routeToTeammate("w", "task two");
		expect(llms.releasePolykvAgent).toHaveBeenCalledTimes(2);
		expect(llms.releasePolykvAgent).toHaveBeenLastCalledWith(own);
		runtime.shutdownTeammate("w");
	});

	it("opens a fresh task at a fresh window, and resumes only a continued one", async () => {
		// The between-task close kept the recorded grant, so every later task
		// asked for exactly the old window with `resume` -- refused at once,
		// never waited, by a server that could not give that much back. A
		// fresh task has no history to fit: it asks like a new session.
		const { recordPolykvGrantedWindow, getPolykvGrantedWindow } = await import(
			"@cline/llms"
		);
		const { runtime, spawn, engineSessionOf } = team();
		await spawn("w");
		const own = engineSessionOf(0) as string;
		const member = (
			runtime as unknown as {
				members: Map<
					string,
					{
						agent: {
							canStartRun: () => boolean;
							run: unknown;
							continue: unknown;
						};
					}
				>;
			}
		).members.get("w");
		if (!member) {
			throw new Error("no teammate");
		}
		const grantAtStart: Array<number | undefined> = [];
		const answer = async () => {
			grantAtStart.push(getPolykvGrantedWindow(own));
			recordPolykvGrantedWindow(own, 131_072);
			return {
				text: "done",
				finishReason: "completed",
				iterations: 1,
				usage: { inputTokens: 1, outputTokens: 1 },
				messages: [],
				toolCalls: [],
			};
		};
		member.agent.canStartRun = () => true;
		member.agent.run = answer;
		member.agent.continue = answer;

		await runtime.routeToTeammate("w", "task one");
		await runtime.routeToTeammate("w", "task two");
		await runtime.routeToTeammate("w", "task three", {
			continueConversation: true,
		});

		expect(grantAtStart).toEqual([undefined, undefined, 131_072]);
		runtime.shutdownTeammate("w");
	});

	it("is not booked by a second task while the last one's close is in flight", async () => {
		// Two tasks for one teammate at once (an async run and a sync call):
		// both passed the busy check while the first waited for the close, and
		// the second found the close already taken and started at once -- its
		// booking could be closed under it, and the first then failed on
		// `SessionRuntime state is "running"`.
		const { runtime, spawn } = team();
		await spawn("w");
		const member = (
			runtime as unknown as {
				members: Map<
					string,
					{
						agent: { canStartRun: () => boolean; run: unknown };
						pendingEngineRelease?: Promise<unknown>;
					}
				>;
			}
		).members.get("w");
		if (!member) {
			throw new Error("no teammate");
		}
		let closeLanded = false;
		member.pendingEngineRelease = new Promise((resolve) =>
			setTimeout(() => {
				closeLanded = true;
				resolve(undefined);
			}, 20),
		);
		let running = false;
		const starts: Array<{ task: string; afterClose: boolean }> = [];
		member.agent.canStartRun = () => !running;
		member.agent.run = async (task: string) => {
			if (running) {
				throw new Error('SessionRuntime state is "running"');
			}
			running = true;
			starts.push({ task, afterClose: closeLanded });
			await new Promise((resolve) => setTimeout(resolve, 10));
			running = false;
			return {
				text: task,
				finishReason: "completed",
				iterations: 1,
				usage: { inputTokens: 1, outputTokens: 1 },
				messages: [],
				toolCalls: [],
			};
		};

		const [first, second] = await Promise.allSettled([
			runtime.routeToTeammate("w", "async-run"),
			runtime.routeToTeammate("w", "sync-call"),
		]);

		expect(first.status).toBe("fulfilled");
		expect(second.status).toBe("rejected");
		expect(String((second as PromiseRejectedResult).reason)).toContain(
			"another run is already in progress",
		);
		expect(starts).toEqual([{ task: "async-run", afterClose: true }]);
		runtime.shutdownTeammate("w");
	});
});
