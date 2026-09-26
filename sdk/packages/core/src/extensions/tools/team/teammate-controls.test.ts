import type { AgentResult, AgentToolContext } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lead's controls act on a teammate's current task, as they do on a
 * round's agent: stop_agents, restart_agent, message_agents, requeue_agent,
 * and its row's stop (audit G-11, rounds gap 1).
 *
 * The fake teammate runs one task at a time; each ends when the test says,
 * and an abort ends it as aborted. `boundary()` is its turn boundary: where a
 * real agent reads a pending message.
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
	calls: Array<{ kind: "run" | "continue"; message?: string }>;
	aborts: number;
	restored: unknown[][];
	finish(text?: string): void;
	boundary(): Promise<string | undefined>;
}

const fakes = vi.hoisted(() => ({ list: [] as FakeTeammate[] }));

vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => ({
	// biome-ignore lint/complexity/useArrowFunction: `new SessionRuntime(...)` requires a non-arrow callable.
	SessionRuntime: vi.fn(function (config: {
		consumePendingUserMessage?: () => string | undefined | Promise<unknown>;
	}) {
		let settle: ((result: AgentResult) => void) | undefined;
		const fake: FakeTeammate = {
			calls: [],
			aborts: 0,
			restored: [],
			finish: (text = "done") => {
				const done = settle;
				settle = undefined;
				done?.(result(text, "completed"));
			},
			boundary: async () =>
				(await config.consumePendingUserMessage?.()) as string | undefined,
		};
		fakes.list.push(fake);
		const start = (kind: "run" | "continue", message?: string) => {
			if (settle) {
				throw new Error(
					"Cannot start a new run while another run is already in progress",
				);
			}
			fake.calls.push({ kind, message });
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
			run: vi.fn((message: string) => start("run", message)),
			continue: vi.fn((message?: string) => start("continue", message)),
			restore: vi.fn((messages: unknown[]) => fake.restored.push(messages)),
			canStartRun: vi.fn(() => !settle),
			getAgentId: vi.fn(() => "runtime-id"),
			getConversationId: vi.fn(() => "conv"),
			getMessages: vi.fn(() => [{ role: "user", content: "earlier" }]),
			subscribeEvents: vi.fn(() => () => {}),
		};
	}),
}));

const { AgentTeamsRuntime } = await import("./multi-agent");
const { createLeadAgentTools } = await import("./lead-agent-tools");
const { __resetSubagentCancellations, subagentCancellation } = await import(
	"./subagent-cancellation"
);

const SESSION = "lead-session";

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

function team() {
	const runtime = new AgentTeamsRuntime({
		teamName: "t",
		sessionId: SESSION,
		maxConcurrentRuns: 4,
	});
	const spawn = (agentId: string) => {
		runtime.spawnTeammate({
			agentId,
			config: {
				providerId: "p",
				modelId: "m",
				systemPrompt: `role of ${agentId}`,
				tools: [],
				engineSessionId: `${SESSION}~teammate-${agentId}`,
			},
		});
		return fakes.list[fakes.list.length - 1] as FakeTeammate;
	};
	const tools = createLeadAgentTools({ sessionId: SESSION });
	const call = (name: string, input: Record<string, unknown>) => {
		const tool = tools.find((entry) => entry.name === name);
		if (!tool) {
			throw new Error(`no ${name}`);
		}
		return tool.execute(input, {
			sessionId: SESSION,
			agentId: "lead",
			conversationId: "c",
			iteration: 1,
		} as AgentToolContext) as Promise<string>;
	};
	return { runtime, spawn, call };
}

beforeEach(() => {
	fakes.list.length = 0;
	llms.releasePolykvAgent.mockClear();
});

afterEach(() => {
	__resetSubagentCancellations();
});

describe("the lead's controls on a teammate's task", () => {
	it("stop_agents stops it by name; the run is cancelled by the lead, and its next run starts", async () => {
		const { runtime, spawn, call } = team();
		const w = spawn("w");
		const first = runtime.startTeammateRun("w", "task one");
		runtime.startTeammateRun("w", "task two");
		await vi.waitFor(() => expect(w.calls).toHaveLength(1));

		const said = await call("stop_agents", { agents: ["w"] });

		expect(said).toMatch(/Stopped 1 agent\(s\): w/);
		expect(w.aborts).toBe(1);
		await vi.waitFor(() => expect(w.calls).toHaveLength(2));
		const stopped = runtime.getRun(first.id);
		expect(stopped?.status).toBe("cancelled");
		expect(stopped?.error).toMatch(/lead/);
		w.finish();
	});

	it("stop_agents with no names reaches a running teammate too", async () => {
		const { runtime, spawn, call } = team();
		const w = spawn("w");
		const sync = runtime.routeToTeammate("w", "sync task");
		await vi.waitFor(() => expect(w.calls).toHaveLength(1));

		await call("stop_agents", {});

		await expect(sync).resolves.toEqual(
			expect.objectContaining({ finishReason: "aborted" }),
		);
		expect(runtime.getSnapshot().members).toContainEqual(
			expect.objectContaining({ agentId: "w", status: "idle" }),
		);
	});

	it("message_agents leaves the message for its next turn boundary", async () => {
		const { runtime, spawn, call } = team();
		const w = spawn("w");
		runtime.startTeammateRun("w", "task");
		await vi.waitFor(() => expect(w.calls).toHaveLength(1));

		const said = await call("message_agents", {
			text: "Use the new API",
			agents: ["w"],
		});

		expect(said).toMatch(/Sent to 1 agent\(s\): w/);
		expect(await w.boundary()).toBe("Use the new API");
		w.finish();
	});

	it("restart_agent starts the task over with the revised instructions, as one run", async () => {
		const { runtime, spawn, call } = team();
		const w = spawn("w");
		const run = runtime.startTeammateRun("w", "fix the parser");
		await vi.waitFor(() => expect(w.calls).toHaveLength(1));

		const said = await call("restart_agent", {
			agent_id: "w",
			instructions: "Start from the tokenizer.",
		});

		expect(said).toMatch(/Restarted w/);
		await vi.waitFor(() => expect(w.calls).toHaveLength(2));
		expect(w.calls[1]).toEqual({
			kind: "run",
			message:
				"fix the parser\n\n# Revised instructions from the lead\n\nStart from the tokenizer.",
		});
		// The abandoned attempt's engine session is given back before the next.
		expect(llms.releasePolykvAgent).toHaveBeenCalledWith(
			`${SESSION}~teammate-w`,
		);
		expect(runtime.getRun(run.id)?.status).toBe("running");
		w.finish("fixed");
		await vi.waitFor(() =>
			expect(runtime.getRun(run.id)?.status).toBe("completed"),
		);
	});

	it("restart_agent on a continued task goes back to the conversation it was given", async () => {
		const { runtime, spawn, call } = team();
		const w = spawn("w");
		runtime.startTeammateRun("w", "go on", { continueConversation: true });
		await vi.waitFor(() => expect(w.calls).toHaveLength(1));

		await call("restart_agent", { agent_id: "w" });

		await vi.waitFor(() => expect(w.calls).toHaveLength(2));
		expect(w.restored).toEqual([[{ role: "user", content: "earlier" }]]);
		expect(w.calls[1]).toEqual({ kind: "continue", message: "go on" });
		w.finish();
	});

	it("requeue_agent stops it at its next boundary and carries on from its transcript", async () => {
		const { runtime, spawn, call } = team();
		const w = spawn("w");
		const run = runtime.startTeammateRun("w", "long task");
		await vi.waitFor(() => expect(w.calls).toHaveLength(1));

		const said = await call("requeue_agent", { agent_id: "w" });
		expect(said).toMatch(/Requeued w/);
		expect(w.aborts).toBe(0);

		expect(await w.boundary()).toBeUndefined();
		await vi.waitFor(() => expect(w.calls).toHaveLength(2));
		expect(w.aborts).toBe(1);
		expect(w.calls[1]?.kind).toBe("continue");
		expect(w.calls[1]?.message).toMatch(/requeued/i);
		expect(llms.releasePolykvAgent).toHaveBeenCalledWith(
			`${SESSION}~teammate-w`,
		);
		w.finish("done after requeue");
		await vi.waitFor(() =>
			expect(runtime.getRun(run.id)?.status).toBe("completed"),
		);
	});

	it("its row carries a stop id while it runs, and the row's stop is the user's", async () => {
		const { runtime, spawn } = team();
		const w = spawn("w");
		const memberOf = () =>
			runtime.exportState().members.find((member) => member.agentId === "w");
		expect(memberOf()?.cancelId).toBeUndefined();

		const run = runtime.startTeammateRun("w", "task");
		await vi.waitFor(() => expect(w.calls).toHaveLength(1));
		const cancelId = memberOf()?.cancelId;
		expect(cancelId).toBeDefined();

		expect(subagentCancellation.cancel(cancelId as string)).toBe(true);

		await vi.waitFor(() =>
			expect(runtime.getRun(run.id)?.status).toBe("cancelled"),
		);
		expect(runtime.getRun(run.id)?.error).toMatch(/user/);
		expect(memberOf()?.cancelId).toBeUndefined();
	});
});
