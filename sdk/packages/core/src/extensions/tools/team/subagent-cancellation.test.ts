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
