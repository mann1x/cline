import type { AgentResult } from "@cline/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeWorkerStop } from "../../../runtime/safety/worker-struggle-stop";
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
		// Kept while a listening lead decides: released, the resumed agent came
		// back to the engine a new session, and the pool floor held it back.
		expect(released).not.toHaveBeenCalled();
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

	it("gives its engine session back when there is no lead to ask", async () => {
		const released = vi.fn(async () => {});
		await runDelegatedWithCap({
			agent: scriptedAgent(4, []),
			start: async () => result("max_iterations", 4, "half"),
			name: "unheard",
			lifetime: createDelegatedAgentLifetime(),
			releaseEngineSession: released,
		});
		expect(released).toHaveBeenCalledTimes(1);
		stopSuspended("unheard");
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

const LOOP_STOP = "repeated-call loop guard stopped the run at iteration 12";

function looped(iterations: number, text = ""): AgentResult {
	return { ...result("aborted", iterations, text), abortReason: LOOP_STOP };
}

describe("an agent the loop guard stops", () => {
	it("waits for the lead, who is told it was looping, and resumes with the lead's instructions", async () => {
		const heard = listeningLead();
		const agent = scriptedAgent(30, [result("completed", 2, "fixed it")]);
		const updates: unknown[] = [];
		const running = runDelegatedWithCap({
			agent,
			start: async () => looped(12, "ran the test again"),
			name: "braces-8",
			sessionId: "lead",
			emitUpdate: (update) => updates.push(update),
		});
		await vi.waitFor(() => expect(listAwaitingLead("lead")).toHaveLength(1));
		expect(listAwaitingLead("lead")[0]).toMatchObject({
			reason: "looping",
			detail: LOOP_STOP,
		});
		flushAwaitingLeadNotices();
		const notice = heard.join("\n");
		expect(notice).toContain("braces-8");
		expect(notice).toContain("LOOPING");
		expect(notice).toContain(LOOP_STOP);
		expect(notice).toContain("restart_agent");
		expect(updates).toContainEqual({
			awaitingLead: {
				iterations: 12,
				maxIterations: 30,
				reason: "looping",
				detail: LOOP_STOP,
			},
		});

		expect(
			resumeSuspended("braces-8", 5, "lead", "Read the script's output instead")
				.ok,
		).toBe(true);
		const done = await running;
		expect(agent.continued[0]).toContain("loop guard");
		expect(agent.continued[0]).toContain("Read the script's output instead");
		// The 18 turns it had left under its cap carry over, plus the 5.
		expect(agent.caps).toEqual([23]);
		expect(done.maxIterations).toBe(35);
		expect(done.result.text).toBe("fixed it");
		expect(done.stopReason).toBeUndefined();
	});

	it("gives an agent with no cap no cap when it resumes", async () => {
		listeningLead();
		const agent = scriptedAgent(undefined, [result("completed", 2, "ok")]);
		const running = runDelegatedWithCap({
			agent,
			start: async () => looped(7),
			name: "a",
			sessionId: "lead",
		});
		await vi.waitFor(() => expect(listAwaitingLead("lead")).toHaveLength(1));
		resumeSuspended("a", 3, "lead");
		const done = await running;
		expect(agent.caps).toEqual([undefined]);
		expect(done.result.text).toBe("ok");
	});

	it("keeps the work, reported as the loop guard's stop, when the lead stops it", async () => {
		listeningLead();
		const running = runDelegatedWithCap({
			agent: scriptedAgent(30, []),
			start: async () => looped(12, "so far"),
			name: "a",
			sessionId: "lead",
		});
		await vi.waitFor(() => expect(listAwaitingLead("lead")).toHaveLength(1));
		expect(stopSuspended("a", { sessionId: "lead" }).message).toContain(
			"loop guard",
		);
		const done = await running;
		expect(done.stopReason).toBe("loop_guard");
		expect(done.result.text).toBe("so far");
	});

	it("does not hold a run someone stopped from outside", async () => {
		listeningLead();
		const controller = new AbortController();
		controller.abort();
		const done = await runDelegatedWithCap({
			agent: scriptedAgent(30, []),
			start: async () => looped(3),
			name: "a",
			sessionId: "lead",
			signal: controller.signal,
		});
		expect(done.stopReason).toBeUndefined();
		expect(listAwaitingLead("lead")).toHaveLength(0);
	});

	it("does not hold an abort that was not the loop guard", async () => {
		listeningLead();
		const done = await runDelegatedWithCap({
			agent: scriptedAgent(30, []),
			start: async () => ({
				...result("aborted", 3),
				abortReason: "maximum consecutive mistakes reached (6)",
			}),
			name: "a",
			sessionId: "lead",
		});
		expect(done.stopReason).toBeUndefined();
		expect(listAwaitingLead("lead")).toHaveLength(0);
	});
});

// Swarm 0926b: the struggle supervisor ended 4 workers outright ("worker
// stopped (thinking-budget)", then "This operation was aborted"), their work
// discarded. The loop guard's ruling applies to every harness stop of a
// delegated agent: it suspends the run for the lead.
const SUPERVISOR_STOP = describeWorkerStop("thinking-budget", {
	spentAfterNudge: 2,
});

function struggled(iterations: number, text = ""): AgentResult {
	return {
		...result("aborted", iterations, text),
		abortReason: SUPERVISOR_STOP,
	};
}

describe("an agent the struggle supervisor stops", () => {
	it("waits for the lead, who is told it was struggling in the supervisor's words, and resumes with instructions", async () => {
		const heard = listeningLead();
		const agent = scriptedAgent(40, [
			result("completed", 2, "SUMMARY: found it"),
		]);
		const updates: unknown[] = [];
		const rearmed = vi.fn();
		const running = runDelegatedWithCap({
			agent,
			start: async () => struggled(13, "probing once more"),
			name: "braces-7",
			sessionId: "lead",
			emitUpdate: (update) => updates.push(update),
			supervisor: { rearm: rearmed },
		});
		await vi.waitFor(() => expect(listAwaitingLead("lead")).toHaveLength(1));
		expect(listAwaitingLead("lead")[0]).toMatchObject({
			reason: "struggling",
			detail: SUPERVISOR_STOP,
		});
		flushAwaitingLeadNotices();
		const notice = heard.join("\n");
		expect(notice).toContain("braces-7");
		expect(notice).toContain("STRUGGLING");
		expect(notice).toContain(SUPERVISOR_STOP);
		expect(notice).toContain("restart_agent");
		expect(updates).toContainEqual({
			awaitingLead: {
				iterations: 13,
				maxIterations: 40,
				reason: "struggling",
				detail: SUPERVISOR_STOP,
			},
		});

		expect(
			resumeSuspended("braces-7", 5, "lead", "Write the SUMMARY now").ok,
		).toBe(true);
		const done = await running;
		expect(rearmed).toHaveBeenCalledTimes(1);
		expect(agent.continued[0]).toContain("struggle supervisor");
		expect(agent.continued[0]).toContain("Write the SUMMARY now");
		// The 27 turns it had left under its cap carry over, plus the 5.
		expect(agent.caps).toEqual([32]);
		expect(done.result.text).toBe("SUMMARY: found it");
		expect(done.stopReason).toBeUndefined();
	});

	it("keeps the work, reported as the supervisor's stop, when the lead stops it", async () => {
		listeningLead();
		const running = runDelegatedWithCap({
			agent: scriptedAgent(40, []),
			start: async () => struggled(13, "so far"),
			name: "a",
			sessionId: "lead",
		});
		await vi.waitFor(() => expect(listAwaitingLead("lead")).toHaveLength(1));
		expect(stopSuspended("a", { sessionId: "lead" }).message).toContain(
			"struggle supervisor",
		);
		const done = await running;
		expect(done.stopReason).toBe("supervisor");
		expect(done.result.text).toBe("so far");
	});

	it("does not hold a run someone stopped from outside", async () => {
		listeningLead();
		const controller = new AbortController();
		controller.abort();
		const done = await runDelegatedWithCap({
			agent: scriptedAgent(40, []),
			start: async () => struggled(3),
			name: "a",
			sessionId: "lead",
			signal: controller.signal,
		});
		expect(done.stopReason).toBeUndefined();
		expect(listAwaitingLead("lead")).toHaveLength(0);
	});

	it("is not taken for a bare abort", async () => {
		listeningLead();
		const done = await runDelegatedWithCap({
			agent: scriptedAgent(40, []),
			start: async () => ({
				...result("aborted", 3),
				abortReason: "This operation was aborted",
			}),
			name: "a",
			sessionId: "lead",
		});
		expect(done.stopReason).toBeUndefined();
		expect(listAwaitingLead("lead")).toHaveLength(0);
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

// A detached agent resumed after its spawn call returned ran outside its node
// lease and slot gate: the resume goes back through placement.
describe("a detached agent's resume", () => {
	it("runs inside the placement its path gives it", async () => {
		const agent = scriptedAgent(4, [result("completed", 2, "done")]);
		const order: string[] = [];
		await runDelegatedWithCap({
			agent,
			start: async () => result("max_iterations", 4, "half"),
			name: "solo",
			lifetime: createDelegatedAgentLifetime(),
			resumeThrough: async (run) => {
				order.push("placed");
				try {
					return await run();
				} finally {
					order.push("released");
				}
			},
		});
		const resumed = resumeSuspended("solo", 5);
		expect(resumed.ok).toBe(true);
		const final = await resumed.completion;
		expect(final?.result.text).toBe("done");
		expect(order).toEqual(["placed", "released"]);
		expect(agent.continued).toHaveLength(1);
	});
});
