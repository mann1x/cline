import type { AgentResult } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Task graph phase 6 through the real team runtime: a task the plan gave a
 * teammate starts on it as a background run once it is ready, and the next
 * one once that run ends. The teammate is the queue tests' fake.
 */

const llms = vi.hoisted(() => ({
	releasePolykvAgent: vi.fn(async (_id: string) => ({
		closed: [],
		failed: [],
	})),
}));

vi.mock("@cline/llms", async (importOriginal) => ({
	...(await importOriginal<typeof import("@cline/llms")>()),
	releasePolykvAgent: llms.releasePolykvAgent,
}));

interface FakeTeammate {
	started: string[];
	aborts: number;
	finish(text?: string, finishReason?: AgentResult["finishReason"]): void;
	running(): boolean;
	/** An event from the agent, as its runtime would announce it. */
	emit(event: unknown): void;
}

const fakes = vi.hoisted(() => ({ list: [] as FakeTeammate[] }));

vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => ({
	// biome-ignore lint/complexity/useArrowFunction: `new SessionRuntime(...)` requires a non-arrow callable.
	SessionRuntime: vi.fn(function (config: {
		onEvent?: (event: unknown) => void;
	}) {
		let settle: ((result: AgentResult) => void) | undefined;
		const fake: FakeTeammate = {
			started: [],
			aborts: 0,
			finish: (text = "done", finishReason = "completed") => {
				const done = settle;
				settle = undefined;
				done?.(result(text, finishReason));
			},
			running: () => settle !== undefined,
			emit: (event) => config.onEvent?.(event),
		};
		fakes.list.push(fake);
		const start = (message: string) => {
			if (settle) {
				throw new Error(
					"Cannot start a new run while another run is already in progress",
				);
			}
			fake.started.push(message);
			return new Promise<AgentResult>((resolve) => {
				settle = resolve;
			});
		};
		return {
			abort: vi.fn(() => {
				fake.aborts++;
				const done = settle;
				settle = undefined;
				done?.(result("stopped", "aborted"));
			}),
			run: vi.fn(start),
			continue: vi.fn((message?: string) => start(message ?? "")),
			restore: vi.fn(),
			canStartRun: vi.fn(() => !settle),
			getAgentId: vi.fn(() => "runtime-id"),
			getConversationId: vi.fn(() => "conv"),
			getMessages: vi.fn(() => []),
			subscribeEvents: vi.fn(() => () => {}),
		};
	}),
}));

const { AgentTeamsRuntime } = await import("./multi-agent");
const { TaskGraphStore } = await import("@cline/taskboard");
const { createGraphTeamBoard } = await import("@cline/taskboard");

function result(
	text: string,
	finishReason: AgentResult["finishReason"],
): AgentResult {
	return {
		text,
		iterations: 1,
		finishReason,
		durationMs: 1,
		usage: {
			inputTokens: 1,
			outputTokens: 1,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalCost: 0,
		},
		messages: [],
		toolCalls: [],
		model: { id: "m", provider: "p" },
		startedAt: new Date(0),
		endedAt: new Date(1),
	};
}

beforeEach(() => {
	fakes.list.length = 0;
});

describe("the plan's tasks run on their teammates", () => {
	it("starts each when ready and its teammate exists, one at a time", async () => {
		const runtime = new AgentTeamsRuntime({ teamName: "t" });
		const store = new TaskGraphStore();
		const started: string[] = [];
		const board = createGraphTeamBoard(store, {
			onDispatched: (agent, task) => started.push(`${agent}:${task}`),
		});
		runtime.useTaskBoard(board);
		store.plan({
			tasks: [
				{ title: "Parse", to: "w1" },
				{ title: "Report", to: "w1", depends: ["#1"] },
				{ title: "Docs" },
			],
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(started).toEqual([]);
		runtime.spawnTeammate({
			agentId: "w1",
			config: { providerId: "p", modelId: "m", systemPrompt: "w1", tools: [] },
		});
		const w1 = fakes.list.at(-1) as FakeTeammate;
		await vi.waitFor(() => expect(w1.started).toHaveLength(1));
		expect(w1.started[0]).toContain("Task T1 from the lead's plan: Parse");
		expect(w1.started[0]).toContain("[Task board] You hold T1 (Parse)");
		expect(store.getState().tasks.get("T1")?.claimedBy).toBe("w1");
		board.complete("T1", "w1", "parsed");
		w1.finish("parsed");
		await vi.waitFor(() => expect(w1.started).toHaveLength(2));
		expect(w1.started[1]).toContain("It builds on: T1 Parse (done: parsed).");
		expect(started).toEqual(["w1:T1", "w1:T2"]);
		expect(store.getState().tasks.get("T3")?.status).toBe("active");
	});
});
