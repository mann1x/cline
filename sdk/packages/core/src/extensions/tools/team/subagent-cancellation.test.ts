import { afterEach, describe, expect, it } from "vitest";
import {
	__resetSubagentCancellations,
	registerSubagentCancellation,
	subagentCancelId,
	subagentCancellation,
} from "./subagent-cancellation";

/**
 * Stopping one agent without stopping the session, which was the only control
 * there was: a fan-out of five where one grinds had four finished reports and
 * a cancel button that threw them away with it.
 */
describe("stopping one sub-agent", () => {
	afterEach(() => {
		__resetSubagentCancellations();
	});

	it("aborts the agent it names and nothing else", () => {
		const one = registerSubagentCancellation("s::call-1", undefined);
		const two = registerSubagentCancellation("s::call-2", undefined);

		expect(subagentCancellation.cancel("s::call-1")).toBe(true);
		expect(one.signal?.aborted).toBe(true);
		expect(two.signal?.aborted).toBe(false);
	});

	// A session's own cancel must still reach every agent under it.
	it("follows the parent's abort", () => {
		const parent = new AbortController();
		const agent = registerSubagentCancellation("s::call-1", parent.signal);

		parent.abort();
		expect(agent.signal?.aborted).toBe(true);
	});

	it("runs already aborted when the parent was", () => {
		const parent = new AbortController();
		parent.abort();
		expect(
			registerSubagentCancellation("s::c", parent.signal).signal?.aborted,
		).toBe(true);
	});

	// Nothing may outlive the run it refers to: a stale entry is a stop button
	// that reports success and does nothing.
	it("forgets an agent that has finished", () => {
		const agent = registerSubagentCancellation("s::call-1", undefined);
		agent.release();

		expect(subagentCancellation.running()).toEqual([]);
		expect(subagentCancellation.cancel("s::call-1")).toBe(false);
	});

	it("is a no-op for an agent that was never running", () => {
		expect(subagentCancellation.cancel("s::nothing")).toBe(false);
	});

	// A tool call id is unique only within the conversation that produced it.
	it("names an agent by session and tool call together", () => {
		expect(subagentCancelId("session-1", "call-1")).toBe("session-1::call-1");
		expect(subagentCancelId("session-2", "call-1")).toBe("session-2::call-1");
		// Nothing to name it by: it runs on the parent's signal, unregistered,
		// rather than under a name nothing can address.
		expect(subagentCancelId("session-1", undefined)).toBeUndefined();
		const unnamed = registerSubagentCancellation(undefined, undefined);
		expect(subagentCancellation.running()).toEqual([]);
		expect(unnamed.signal).toBeUndefined();
	});
});

describe("restarting a sub-agent", () => {
	// pandorum 2026-09-24: two agents stuck after the server restarted under
	// them. Stop was the only control, and a stopped agent is a lost task.
	it("runs the agent again from its task when its attempt is restarted", async () => {
		const registration = registerSubagentCancellation(
			"s::restart-1",
			undefined,
		);
		const signals: AbortSignal[] = [];
		let restarts = 0;
		const result = await registration.restartable(
			async () => {
				const signal = registration.signal as AbortSignal;
				signals.push(signal);
				if (signals.length === 1) {
					expect(subagentCancellation.restart("s::restart-1")).toBe(true);
					expect(signal.aborted).toBe(true);
					return "abandoned";
				}
				return "second attempt";
			},
			() => {
				restarts += 1;
			},
		);
		expect(result).toBe("second attempt");
		expect(restarts).toBe(1);
		expect(signals[1]?.aborted).toBe(false);
		registration.release();
	});

	it("does not bring back an agent that was stopped", async () => {
		const registration = registerSubagentCancellation(
			"s::restart-2",
			undefined,
		);
		let runs = 0;
		await expect(
			registration.restartable(async () => {
				runs += 1;
				subagentCancellation.restart("s::restart-2");
				subagentCancellation.cancel("s::restart-2");
				throw new Error("aborted");
			}),
		).rejects.toThrow("aborted");
		expect(runs).toBe(1);
		expect(subagentCancellation.restart("s::restart-2")).toBe(false);
		registration.release();
	});

	it("stops the current attempt when the agent is stopped", async () => {
		const registration = registerSubagentCancellation(
			"s::restart-3",
			undefined,
		);
		await registration.restartable(async () => {
			const signal = registration.signal as AbortSignal;
			subagentCancellation.cancel("s::restart-3");
			expect(signal.aborted).toBe(true);
		});
		registration.release();
	});
});

describe("the lead's controls on one agent", () => {
	afterEach(() => {
		__resetSubagentCancellations();
	});

	// Spec C: requeue continues the agent's transcript; it does not restart it.
	it("requeues at the next boundary and carries the transcript on", async () => {
		const agent = registerSubagentCancellation("s::c", undefined, "a");
		const carried: unknown[] = [];
		const result = await agent.restartable(() =>
			agent.continuable(async (carry) => {
				carried.push(carry);
				if (!carry) {
					agent.track({ getMessages: () => ["turn-1", "turn-2"] });
					expect(
						subagentCancellation.requeue("s::c", {
							reason: "slow",
							avoidNodeId: "node-1",
						}),
					).toBe(true);
					// The boundary: its next turn's message check.
					expect(agent.takeMessage()).toBeUndefined();
					expect(agent.signal?.aborted).toBe(true);
					throw new DOMException("aborted", "AbortError");
				}
				return "continued";
			}),
		);
		expect(result).toBe("continued");
		expect(carried[1]).toEqual({
			messages: ["turn-1", "turn-2"],
			reason: "slow",
			avoidNodeId: "node-1",
		});
	});

	it("requeues at once an agent that is only waiting on infrastructure", async () => {
		const agent = registerSubagentCancellation("s::c", undefined, "a");
		let segments = 0;
		await agent.continuable(async (carry) => {
			segments += 1;
			if (!carry) {
				agent.setWaitingInfra(true);
				subagentCancellation.requeue("s::c");
				expect(agent.signal?.aborted).toBe(true);
				throw new DOMException("aborted", "AbortError");
			}
			return undefined;
		});
		expect(segments).toBe(2);
	});

	it("restarts from the task with the lead's revised instructions", async () => {
		const agent = registerSubagentCancellation("s::c", undefined, "a");
		const seen: Array<string | undefined> = [];
		await agent.restartable(async () => {
			seen.push(agent.instructions);
			if (seen.length === 1) {
				subagentCancellation.restart("s::c", { instructions: "Be brief." });
				throw new DOMException("aborted", "AbortError");
			}
			return undefined;
		});
		expect(seen).toEqual([undefined, "Be brief."]);
	});

	it("holds an agent at its cap until the lead grants more iterations", async () => {
		const agent = registerSubagentCancellation("s::c", undefined, "a");
		const waiting = agent.awaitLead();
		expect(subagentCancellation.inspect("s::c")?.awaitingLead).toBe(true);
		expect(subagentCancellation.resumeSuspended("s::c", 5)).toBe(true);
		await expect(waiting).resolves.toBe(5);
		expect(subagentCancellation.inspect("s::c")?.awaitingLead).toBe(false);
		expect(subagentCancellation.resumeSuspended("s::c", 5)).toBe(false);
	});

	it("remembers who stopped it", () => {
		registerSubagentCancellation("s::c", undefined, "a");
		subagentCancellation.cancel("s::c", "lead");
		expect(subagentCancellation.stoppedBy("s::c")).toBe("lead");
		registerSubagentCancellation("s::d", undefined, "b");
		subagentCancellation.cancel("s::d");
		expect(subagentCancellation.stoppedBy("s::d")).toBe("user");
	});
});

// requeue_agent on a path that runs its agent outside a continuable loop
// would only have stopped it: nothing there takes the transcript back.
describe("a requeue with nothing to carry it", () => {
	it("is refused rather than taken as a stop", () => {
		registerSubagentCancellation("s::bare", undefined, "a");
		expect(subagentCancellation.requeue("s::bare")).toBe(false);
		expect(subagentCancellation.inspect("s::bare")?.requeuePending).toBe(false);
	});
});
