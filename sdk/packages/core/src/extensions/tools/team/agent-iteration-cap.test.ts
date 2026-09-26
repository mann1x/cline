import type { AgentResult } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	__resetAwaitingLead,
	type CappableAgent,
	createDelegatedAgentLifetime,
	flushAwaitingLeadNotices,
	listAwaitingLead,
	onAwaitingLead,
	resumeSuspended,
	runDelegatedWithCap,
	stopSuspended,
} from "./agent-iteration-cap";
import { onLeadNudge } from "./agent-trouble";

afterEach(() => {
	__resetAwaitingLead();
});

function result(
	finishReason: AgentResult["finishReason"],
	iterations: number,
	text = "",
): AgentResult {
	return {
		text,
		usage: { inputTokens: 10 * iterations, outputTokens: iterations },
		messages: [],
		toolCalls: [],
		iterations,
		finishReason,
		model: { id: "m", provider: "p" },
		startedAt: new Date(0),
		endedAt: new Date(0),
		durationMs: 0,
	};
}

let agentSerial = 0;

/** An agent whose runs come from a script, recording what it was asked. */
function scriptedAgent(
	cap: number | undefined,
	continuations: AgentResult[],
): CappableAgent & { continued: string[]; caps: Array<number | undefined> } {
	let maxIterations = cap;
	const id = `agent_${++agentSerial}`;
	const agent = {
		continued: [] as string[],
		caps: [] as Array<number | undefined>,
		getAgentId: () => id,
		getMaxIterations: () => maxIterations,
		setMaxIterations: (value: number | undefined) => {
			maxIterations = value;
		},
		continue: async (message?: string) => {
			agent.continued.push(message ?? "");
			agent.caps.push(maxIterations);
			const next = continuations.shift();
			if (!next) {
				throw new Error("no scripted continuation");
			}
			return next;
		},
	};
	return agent;
}

/** A lead that is listening, as the host's side turn is. */
function listeningLead(sessionId = "lead"): string[] {
	const heard: string[] = [];
	onLeadNudge(sessionId, (text) => heard.push(text));
	return heard;
}

describe("an agent that reaches its iteration cap", () => {
	it("waits for the lead instead of ending, and continues when resumed", async () => {
		const heard = listeningLead();
		const agent = scriptedAgent(4, [result("completed", 3, "all fixed")]);
		const updates: unknown[] = [];
		const released = vi.fn(async () => {});
		const running = runDelegatedWithCap({
			agent,
			start: async () => result("max_iterations", 4, "half done"),
			name: "brace-fix-1",
			sessionId: "lead",
			emitUpdate: (update) => updates.push(update),
			releaseEngineSession: released,
		});
		await vi.waitFor(() => expect(listAwaitingLead("lead")).toHaveLength(1));
		flushAwaitingLeadNotices();
		expect(heard.join("\n")).toContain("brace-fix-1");
		expect(heard.join("\n")).toContain("4-iteration cap");
		expect(heard.join("\n")).toContain("resume_agent");
		expect(released).toHaveBeenCalledTimes(1);
		expect(updates).toContainEqual({
			awaitingLead: { iterations: 4, maxIterations: 4 },
		});

		const outcome = resumeSuspended("brace-fix-1", 6, "lead");
		expect(outcome.ok).toBe(true);
		const done = await running;
		expect(agent.caps).toEqual([6]);
		expect(agent.continued[0]).toContain("6");
		expect(done.result.text).toBe("all fixed");
		expect(done.result.finishReason).toBe("completed");
		expect(done.iterations).toBe(7);
		expect(done.maxIterations).toBe(10);
		expect(done.result.usage.inputTokens).toBe(70);
		expect(done.stopReason).toBeUndefined();
		expect(updates).toContainEqual({ awaitingLead: null });
		expect(listAwaitingLead("lead")).toHaveLength(0);
	});

	it("keeps the work when the lead stops it at the cap", async () => {
		listeningLead();
		const agent = scriptedAgent(4, []);
		const running = runDelegatedWithCap({
			agent,
			start: async () => result("max_iterations", 4, "half done"),
			name: "a",
			sessionId: "lead",
		});
		await vi.waitFor(() => expect(listAwaitingLead("lead")).toHaveLength(1));
		expect(stopSuspended("a", { sessionId: "lead" }).ok).toBe(true);
		const done = await running;
		expect(done.result.text).toBe("half done");
		expect(done.stopReason).toBe("iteration_cap");
		expect(done.iterations).toBe(4);
		expect(done.maxIterations).toBe(4);
	});

	it("resolves when its own stop fires, as a stop at the cap", async () => {
		listeningLead();
		const controller = new AbortController();
		const running = runDelegatedWithCap({
			agent: scriptedAgent(2, []),
			start: async () => result("max_iterations", 2, "partial"),
			name: "a",
			sessionId: "lead",
			signal: controller.signal,
		});
		await vi.waitFor(() => expect(listAwaitingLead("lead")).toHaveLength(1));
		controller.abort();
		const done = await running;
		expect(done.stopReason).toBe("iteration_cap");
		expect(done.result.text).toBe("partial");
	});

	it("tells the lead once for several agents that stop together", async () => {
		const heard = listeningLead();
		const runs = ["a", "b", "c"].map((name) =>
			runDelegatedWithCap({
				agent: scriptedAgent(4, []),
				start: async () => result("max_iterations", 4),
				name,
				sessionId: "lead",
			}),
		);
		await vi.waitFor(() => expect(listAwaitingLead("lead")).toHaveLength(3));
		flushAwaitingLeadNotices();
		expect(heard).toHaveLength(1);
		for (const name of ["a", "b", "c"]) {
			expect(heard[0]).toContain(name);
			stopSuspended(name, { sessionId: "lead" });
		}
		await Promise.all(runs);
	});

	it("refuses a resume for an agent that is not waiting, and says so", () => {
		const outcome = resumeSuspended("nobody", 5, "lead");
		expect(outcome.ok).toBe(false);
		expect(outcome.message).toContain("nobody");
	});

	it("refuses a resume that adds no iterations", async () => {
		listeningLead();
		const running = runDelegatedWithCap({
			agent: scriptedAgent(4, []),
			start: async () => result("max_iterations", 4),
			name: "a",
			sessionId: "lead",
		});
		await vi.waitFor(() => expect(listAwaitingLead("lead")).toHaveLength(1));
		expect(resumeSuspended("a", 0, "lead").ok).toBe(false);
		stopSuspended("a", { sessionId: "lead" });
		await running;
	});

	it("runs a completed agent straight through", async () => {
		const done = await runDelegatedWithCap({
			agent: scriptedAgent(4, []),
			start: async () => result("completed", 2, "ok"),
			name: "a",
			sessionId: "lead",
		});
		expect(done.result.text).toBe("ok");
		expect(done.iterations).toBe(2);
		expect(done.maxIterations).toBe(4);
		expect(listAwaitingLead()).toHaveLength(0);
	});
});

describe("an agent at its cap with no lead to ask", () => {
	it("returns as awaiting_lead, keeps its resources, and resumes in the background", async () => {
		const agent = scriptedAgent(4, [result("completed", 2, "finished later")]);
		const lifetime = createDelegatedAgentLifetime();
		const finished: unknown[] = [];
		const events: string[] = [];
		const stop = onAwaitingLead((event) => events.push(event.type));
		const outcome = await runDelegatedWithCap({
			agent,
			start: async () => result("max_iterations", 4, "half"),
			name: "solo",
			lifetime,
			onDetachedFinish: async (final) => {
				finished.push(final);
			},
		});
		expect(outcome.state).toBe("awaiting_lead");
		expect(outcome.stopReason).toBe("iteration_cap");
		expect(outcome.result.text).toBe("half");

		const cleanup = vi.fn(async () => {});
		const ended = lifetime.end(cleanup);
		// Held open: the transcript, the overlay and the rest are kept.
		await Promise.resolve();
		expect(cleanup).not.toHaveBeenCalled();
		expect(listAwaitingLead()).toMatchObject([
			{ name: "solo", detached: true, iterations: 4, maxIterations: 4 },
		]);

		const resumed = resumeSuspended("solo", 3);
		expect(resumed.ok).toBe(true);
		const final = await resumed.completion;
		expect(final?.result.text).toBe("finished later");
		expect(final?.iterations).toBe(6);
		expect(final?.maxIterations).toBe(7);
		await ended;
		await lifetime.ended;
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(finished).toHaveLength(1);
		expect(events).toEqual(["suspended", "resumed", "finished"]);
		stop();
	});

	it("releases a detached agent's resources when it is stopped", async () => {
		const lifetime = createDelegatedAgentLifetime();
		await runDelegatedWithCap({
			agent: scriptedAgent(4, []),
			start: async () => result("max_iterations", 4, "half"),
			name: "solo",
			lifetime,
		});
		const cleanup = vi.fn(async () => {});
		await lifetime.end(cleanup);
		expect(cleanup).not.toHaveBeenCalled();
		stopSuspended("solo");
		await lifetime.ended;
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it("runs cleanup at once for an agent that was never detached", async () => {
		const lifetime = createDelegatedAgentLifetime();
		const cleanup = vi.fn(async () => {});
		await lifetime.end(cleanup);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});
});
