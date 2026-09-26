import type { AgentConfig, AgentResult } from "@cline/shared";
import { describe, expect, it, vi } from "vitest";
import { AgentTeamsRuntime } from "./multi-agent";

/**
 * A teammate counts its tool calls and compactions the way a `spawn_agent`
 * row does: over its whole life, and per task. Each run of the stub calls
 * two tools and compacts once.
 */

const { createSessionRuntimeMock } = vi.hoisted(() => {
	// biome-ignore lint/complexity/useArrowFunction: `new SessionRuntime(...)` requires a non-arrow callable.
	const createSessionRuntimeMock = vi.fn(function (config?: unknown) {
		const onEvent = (config as { onEvent?: (event: unknown) => void })?.onEvent;
		const work = async () => {
			onEvent?.({
				type: "content_start",
				contentType: "text",
				text: "Reading",
			});
			onEvent?.({
				type: "content_start",
				contentType: "tool",
				toolName: "read_files",
			});
			onEvent?.({
				type: "content_start",
				contentType: "tool",
				toolName: "editor",
			});
			onEvent?.({
				type: "notice",
				noticeType: "status",
				message: "auto-compacted",
				metadata: {
					kind: "auto_compaction",
					cause: "pressure",
					phase: "completed",
					tokensBefore: 60_000,
					tokensAfter: 20_000,
				},
			});
			return {
				text: "done",
				iterations: 1,
				finishReason: "completed",
				durationMs: 1,
				usage: { inputTokens: 1, outputTokens: 1 },
				messages: [],
				toolCalls: [],
			} as unknown as AgentResult;
		};
		return {
			abort: vi.fn(),
			run: vi.fn(work),
			continue: vi.fn(work),
			canStartRun: vi.fn(() => true),
			getAgentId: vi.fn(() => "teammate-1"),
			getConversationId: vi.fn(() => "conv-1"),
			getMessages: vi.fn(() => []),
			subscribeEvents: vi.fn(() => () => {}),
		};
	});
	return { createSessionRuntimeMock };
});

vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => ({
	SessionRuntime: createSessionRuntimeMock,
}));

const config = {
	providerId: "anthropic",
	modelId: "m",
	systemPrompt: "Helper",
	tools: [],
} as unknown as AgentConfig;

const teammateOf = (runtime: AgentTeamsRuntime, agentId: string) =>
	runtime.exportState().members.find((member) => member.agentId === agentId);

describe("a teammate's tool calls and compactions", () => {
	it("are counted per task and over its life", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "t" });
		runtime.spawnTeammate({ agentId: "helper", config });

		await runtime.routeToTeammate("helper", "first");
		await runtime.routeToTeammate("helper", "second");

		expect(teammateOf(runtime, "helper")).toMatchObject({
			activity: {
				toolCalls: 4,
				compactions: 2,
				compactionsByCause: { pressure: 2 },
				lastCompaction: {
					cause: "pressure",
					tokensBefore: 60_000,
					tokensAfter: 20_000,
				},
			},
			taskActivity: { toolCalls: 2, compactions: 1 },
		});
	});

	it("are kept on the run record of an async task", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "t" });
		runtime.spawnTeammate({ agentId: "helper", config });

		const run = runtime.startTeammateRun("helper", "work");
		await runtime.awaitRun(run.id);

		const saved = runtime
			.exportState()
			.runs.find((entry) => entry.id === run.id);
		expect(saved?.activity).toMatchObject({ toolCalls: 2, compactions: 1 });
	});

	// The host exports the team for a progress row only when the counts moved:
	// a streamed chunk is not worth a full state.
	it("say on the event when they moved, and only then", async () => {
		const moved: Array<[string, boolean]> = [];
		const runtime = new AgentTeamsRuntime({
			teamName: "t",
			onTeamEvent: (event) => {
				if (event.type === "agent_event") {
					moved.push([event.event.type, event.activityChanged === true]);
				}
			},
		});
		runtime.spawnTeammate({ agentId: "helper", config });
		await runtime.routeToTeammate("helper", "first");
		expect(moved).toEqual([
			["content_start", false],
			["content_start", true],
			["content_start", true],
			["notice", true],
		]);
	});

	it("are not given to the lead", () => {
		const runtime = new AgentTeamsRuntime({
			teamName: "t",
			leadAgentId: "lead",
		});
		expect(teammateOf(runtime, "lead")?.activity).toBeUndefined();
	});

	// Saved with the team and restored with the session: a restored teammate
	// counts on from where it was, not from nothing.
	it("carry on from the saved count after a restore", async () => {
		const first = new AgentTeamsRuntime({ teamName: "t" });
		first.spawnTeammate({ agentId: "helper", config });
		await first.routeToTeammate("helper", "before");
		const saved = JSON.parse(JSON.stringify(first.exportState()));

		const restored = new AgentTeamsRuntime({ teamName: "t" });
		restored.hydrateState(saved);
		expect(teammateOf(restored, "helper")?.activity).toMatchObject({
			toolCalls: 2,
			compactions: 1,
		});
		restored.spawnTeammate({ agentId: "helper", config });
		await restored.routeToTeammate("helper", "after");
		expect(teammateOf(restored, "helper")).toMatchObject({
			activity: {
				toolCalls: 4,
				compactions: 2,
				compactionsByCause: { pressure: 2 },
			},
			taskActivity: { toolCalls: 2, compactions: 1 },
		});
	});
});
