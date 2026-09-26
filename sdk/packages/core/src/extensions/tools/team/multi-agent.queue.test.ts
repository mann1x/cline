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
	finish(text?: string): void;
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
			finish: (text = "done") => {
				const done = settle;
				settle = undefined;
				done?.(result(text, "completed"));
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
