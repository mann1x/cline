import type { AgentResult } from "@cline/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A teammate's async runs, queued, cancelled and shut down (audit B-3..B-6).
 *
 * The fake teammate runs one task at a time, as a `SessionRuntime` does: a
 * second `run` while one is going throws the runtime's own error. Each run
 * waits until the test ends it, and an abort ends it as aborted.
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
}

const fakes = vi.hoisted(() => ({ list: [] as FakeTeammate[] }));

vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => ({
	// biome-ignore lint/complexity/useArrowFunction: `new SessionRuntime(...)` requires a non-arrow callable.
	SessionRuntime: vi.fn(function () {
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
type TeamEvent = import("./multi-agent").TeamEvent;

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

function team(options: { maxConcurrentRuns?: number } = {}) {
	const events: TeamEvent[] = [];
	const runtime = new AgentTeamsRuntime({
		teamName: "t",
		maxConcurrentRuns: options.maxConcurrentRuns ?? 4,
		onTeamEvent: (event) => events.push(event),
	});
	const spawn = (agentId: string, engineSessionId?: string) => {
		runtime.spawnTeammate({
			agentId,
			config: {
				providerId: "p",
				modelId: "m",
				systemPrompt: `role of ${agentId}`,
				tools: [],
				...(engineSessionId ? { engineSessionId } : {}),
			},
		});
		return fakes.list[fakes.list.length - 1] as FakeTeammate;
	};
	return { runtime, events, spawn };
}

const statusOf = (
	runtime: InstanceType<typeof AgentTeamsRuntime>,
	id: string,
) => runtime.getRun(id)?.status;

beforeEach(() => {
	fakes.list.length = 0;
	llms.releasePolykvAgent.mockClear();
});

describe("a teammate's async queue", () => {
	it("runs two async tasks for one teammate one after the other", async () => {
		const { runtime, spawn } = team();
		const reviewer = spawn("reviewer");

		const first = runtime.startTeammateRun("reviewer", "task one");
		const second = runtime.startTeammateRun("reviewer", "task two");
		await vi.waitFor(() => expect(reviewer.started).toEqual(["task one"]));
		expect(statusOf(runtime, second.id)).toBe("queued");

		reviewer.finish("one done");
		await vi.waitFor(() =>
			expect(reviewer.started).toEqual(["task one", "task two"]),
		);
		expect(statusOf(runtime, first.id)).toBe("completed");
		reviewer.finish("two done");
		await vi.waitFor(() =>
			expect(statusOf(runtime, second.id)).toBe("completed"),
		);
	});

	it("still runs other teammates' tasks beside a busy one", async () => {
		const { runtime, spawn } = team();
		const a = spawn("a");
		const b = spawn("b");

		runtime.startTeammateRun("a", "a1");
		runtime.startTeammateRun("a", "a2");
		const forB = runtime.startTeammateRun("b", "b1");

		await vi.waitFor(() => expect(b.started).toEqual(["b1"]));
		expect(a.started).toEqual(["a1"]);
		b.finish();
		await vi.waitFor(() =>
			expect(statusOf(runtime, forB.id)).toBe("completed"),
		);
		a.finish();
		await vi.waitFor(() => expect(a.started).toEqual(["a1", "a2"]));
		a.finish();
	});

	it("starts a queued run when the teammate's sync task ends", async () => {
		const { runtime, spawn } = team();
		const w = spawn("w");

		const sync = runtime.routeToTeammate("w", "sync task");
		const queued = runtime.startTeammateRun("w", "async task");
		await vi.waitFor(() => expect(w.started).toEqual(["sync task"]));
		expect(statusOf(runtime, queued.id)).toBe("queued");

		w.finish();
		await sync;
		await vi.waitFor(() =>
			expect(w.started).toEqual(["sync task", "async task"]),
		);
		w.finish();
		await vi.waitFor(() =>
			expect(statusOf(runtime, queued.id)).toBe("completed"),
		);
	});
});

const eventsOf = (events: TeamEvent[], type: string, runId: string) =>
	events.filter(
		(event) =>
			event.type === type &&
			"run" in event &&
			(event.run as { id: string }).id === runId,
	);

describe("team_cancel_run on a running run", () => {
	it("stops the teammate, and its next queued run starts and completes", async () => {
		const { runtime, events, spawn } = team();
		const w = spawn("w");

		const first = runtime.startTeammateRun("w", "long task");
		const next = runtime.startTeammateRun("w", "next task");
		await vi.waitFor(() => expect(w.started).toEqual(["long task"]));

		runtime.cancelRun(first.id, "not needed");

		expect(w.aborts).toBe(1);
		await vi.waitFor(() =>
			expect(w.started).toEqual(["long task", "next task"]),
		);
		expect(statusOf(runtime, first.id)).toBe("cancelled");
		w.finish("next done");
		await vi.waitFor(() =>
			expect(statusOf(runtime, next.id)).toBe("completed"),
		);
		expect(statusOf(runtime, first.id)).toBe("cancelled");
		expect(eventsOf(events, "run_cancelled", first.id)).toHaveLength(1);
		expect(eventsOf(events, "run_completed", first.id)).toHaveLength(0);
		expect(eventsOf(events, "run_failed", next.id)).toHaveLength(0);
	});

	it("leaves a queued run's teammate alone", async () => {
		const { runtime, spawn } = team();
		const w = spawn("w");

		runtime.startTeammateRun("w", "running task");
		const queued = runtime.startTeammateRun("w", "queued task");
		await vi.waitFor(() => expect(w.started).toEqual(["running task"]));

		runtime.cancelRun(queued.id);

		expect(w.aborts).toBe(0);
		expect(statusOf(runtime, queued.id)).toBe("cancelled");
		w.finish();
	});
});

describe("a teammate shut down with work queued", () => {
	it("cancels its running and queued runs, and starts none after", async () => {
		const { runtime, events, spawn } = team();
		const w = spawn("w", "lead~teammate-w-1");

		const running = runtime.startTeammateRun("w", "task-1");
		const queued = runtime.startTeammateRun("w", "task-2");
		await vi.waitFor(() => expect(w.started).toEqual(["task-1"]));

		runtime.shutdownTeammate("w", "lead_removed_it");

		await vi.waitFor(() =>
			expect(statusOf(runtime, running.id)).toBe("cancelled"),
		);
		expect(statusOf(runtime, queued.id)).toBe("cancelled");
		// Past the aborted task's end and its dispatch: nothing else starts.
		await vi.waitFor(() =>
			expect(llms.releasePolykvAgent).toHaveBeenCalledWith("lead~teammate-w-1"),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(w.started).toEqual(["task-1"]);
		expect(eventsOf(events, "run_completed", running.id)).toHaveLength(0);
	});

	it("starts no queued run of another teammate the session shut down", async () => {
		// probe3: `a` aborted at session shutdown, then `b START task-2`.
		const { runtime, spawn } = team({ maxConcurrentRuns: 1 });
		const a = spawn("a");
		const b = spawn("b");

		const forA = runtime.startTeammateRun("a", "task-1");
		const forB = runtime.startTeammateRun("b", "task-2");
		await vi.waitFor(() => expect(a.started).toEqual(["task-1"]));

		runtime.shutdownTeammate("a", "runtime_shutdown:session_stop");
		runtime.shutdownTeammate("b", "runtime_shutdown:session_stop");

		await vi.waitFor(() =>
			expect(statusOf(runtime, forA.id)).toBe("cancelled"),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(b.started).toEqual([]);
		expect(statusOf(runtime, forB.id)).toBe("cancelled");
	});

	it("does not start a task waiting on the last task's engine close", async () => {
		let closeLanded: (() => void) | undefined;
		const { runtime, spawn } = team();
		const w = spawn("w", "lead~teammate-w-2");

		const first = runtime.routeToTeammate("w", "first");
		await vi.waitFor(() => expect(w.started).toEqual(["first"]));
		llms.releasePolykvAgent.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					closeLanded = () => resolve({ closed: [], failed: [] });
				}),
		);
		w.finish();
		await first;

		const second = runtime.routeToTeammate("w", "second");
		const outcome = second.catch((error: Error) => error);
		runtime.shutdownTeammate("w");
		closeLanded?.();

		expect(await outcome).toEqual(
			expect.objectContaining({
				message: expect.stringContaining("shut down"),
			}),
		);
		expect(w.started).toEqual(["first"]);
		// Its session closed for good, not left booked by a task that ran on.
		expect(
			llms.releasePolykvAgent.mock.calls.filter(
				([id]) => id === "lead~teammate-w-2",
			).length,
		).toBeGreaterThanOrEqual(2);
	});

	it("records a run whose teammate was aborted as cancelled, not completed", async () => {
		const { runtime, events, spawn } = team();
		const w = spawn("w");

		const run = runtime.startTeammateRun("w", "task");
		await vi.waitFor(() => expect(w.started).toEqual(["task"]));
		w.finish("cut short", "aborted");

		await vi.waitFor(() => expect(statusOf(runtime, run.id)).toBe("cancelled"));
		expect(eventsOf(events, "run_completed", run.id)).toHaveLength(0);
	});

	it("refuses a new task, sync or async, with a message that says so", async () => {
		const { runtime, spawn } = team();
		const w = spawn("w");
		runtime.shutdownTeammate("w");

		await expect(runtime.routeToTeammate("w", "more")).rejects.toThrow(
			/"w" was shut down.*team_spawn_teammate/,
		);
		expect(() => runtime.startTeammateRun("w", "more")).toThrow(
			/"w" was shut down.*team_spawn_teammate/,
		);
		expect(w.started).toEqual([]);
		expect(runtime.isTeammateActive("w")).toBe(false);
	});
});
