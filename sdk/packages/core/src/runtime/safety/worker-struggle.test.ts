import type { AgentEvent, AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	createWorkerStruggleSupervisor,
	describeWorkerNudge,
} from "./worker-struggle";

const iterStart = (iteration: number): AgentEvent => ({
	type: "iteration_start",
	iteration,
});

const iterEnd = (iteration: number): AgentEvent => ({
	type: "iteration_end",
	iteration,
	hadToolCalls: true,
	toolCallCount: 1,
});

const failedEdit = (): AgentEvent => ({
	type: "content_end",
	contentType: "tool",
	toolName: "editor",
	error: "refused: the range no longer matches the file",
});

/** Drive the supervisor through a run of `turns` tool-calling iterations. */
function grind(
	supervisor: ReturnType<typeof createWorkerStruggleSupervisor>,
	turns: number,
	start = 1,
): void {
	for (let i = start; i < start + turns; i += 1) {
		supervisor.observe(iterStart(i));
		supervisor.observe(iterEnd(i));
	}
}

function textTool(name: string, result: string): AgentTool<unknown, unknown> {
	return {
		name,
		description: "",
		inputSchema: { type: "object" },
		execute: async () => result,
	} as unknown as AgentTool<unknown, unknown>;
}

describe("createWorkerStruggleSupervisor", () => {
	it("starts watching, with the stop signal unset", () => {
		const supervisor = createWorkerStruggleSupervisor();
		expect(supervisor.phase).toBe("watching");
		expect(supervisor.stopSignal.aborted).toBe(false);
	});

	// The grep-grind class: a worker that keeps issuing slightly-varying probes
	// and never converges, with no failure the struggle detector can see. The
	// only thing that separates it from a productive worker is the turn count,
	// so that is what the non-progress signal reads.
	it("nudges once on a turn-count grind, then stops", () => {
		const supervisor = createWorkerStruggleSupervisor({
			nudgeAfterIterations: 6,
			stopAfterIterations: 10,
			graceIterations: 2,
		});

		grind(supervisor, 6);
		expect(supervisor.phase).toBe("nudged");
		expect(supervisor.stopSignal.aborted).toBe(false);

		grind(supervisor, 4, 7);
		expect(supervisor.phase).toBe("stopped");
		expect(supervisor.stopSignal.aborted).toBe(true);
	});

	// The nudge is delivered on the worker's next tool result, never appended to
	// the conversation -- the same delivery the lead's struggle offer uses,
	// because a delegated run's message store is snapshotted at start and
	// overwritten at end.
	it("attaches the held nudge to the next tool result, once", async () => {
		const supervisor = createWorkerStruggleSupervisor({
			nudgeAfterIterations: 6,
			stopAfterIterations: 100,
			nudgeMessage: "COMMIT NOW",
		});
		grind(supervisor, 6);
		expect(supervisor.phase).toBe("nudged");

		const [grep] = supervisor.wrapTools([textTool("grep", "found 3 matches")]);
		const first = await grep.execute({}, {} as never);
		expect(first).toContain("found 3 matches");
		expect(first).toContain("COMMIT NOW");

		// Consumed: a second call does not repeat it.
		const second = await grep.execute({}, {} as never);
		expect(second).toBe("found 3 matches");
	});

	// Detection parity with the lead: an unbroken run of refused edits is caught
	// by the reused StruggleDetector well before the turn budget runs out. This
	// is the `xsvod4` failing-editor grind from the 75-agent swarm.
	it("nudges on a refused-edit streak before the turn budget", () => {
		const supervisor = createWorkerStruggleSupervisor({
			nudgeAfterIterations: 100,
			stopAfterIterations: 200,
		});
		supervisor.observe(iterStart(1));
		supervisor.observe(failedEdit());
		supervisor.observe(failedEdit());
		supervisor.observe(failedEdit());
		expect(supervisor.phase).toBe("nudged");
	});

	// The one nudge is given a grace window to land before a stop can fire: a
	// struggle verdict the turn after the nudge must not stop the worker, or the
	// nudge it was just handed never reaches a tool result.
	it("does not stop within the grace window after nudging", () => {
		const supervisor = createWorkerStruggleSupervisor({
			nudgeAfterIterations: 4,
			stopAfterIterations: 200,
			graceIterations: 5,
		});
		grind(supervisor, 4);
		expect(supervisor.phase).toBe("nudged");

		// A refused-edit streak one turn later -- inside the grace window.
		supervisor.observe(iterStart(5));
		supervisor.observe(failedEdit());
		supervisor.observe(failedEdit());
		supervisor.observe(failedEdit());
		expect(supervisor.phase).toBe("nudged");
		expect(supervisor.stopSignal.aborted).toBe(false);
	});

	it("reports each transition to the observer", () => {
		const transitions: string[] = [];
		const supervisor = createWorkerStruggleSupervisor({
			nudgeAfterIterations: 4,
			stopAfterIterations: 6,
			graceIterations: 1,
			onTransition: (phase, reason) => transitions.push(`${phase}:${reason}`),
		});
		grind(supervisor, 6);
		expect(transitions).toEqual([
			"nudged:non-progress",
			"stopped:non-progress",
		]);
	});

	it("holds a caller-provided abort controller so an outer stop still works", () => {
		const controller = new AbortController();
		const supervisor = createWorkerStruggleSupervisor({
			nudgeAfterIterations: 2,
			stopAfterIterations: 4,
			graceIterations: 1,
			abortController: controller,
		});
		grind(supervisor, 4);
		expect(controller.signal.aborted).toBe(true);
		expect(supervisor.stopSignal).toBe(controller.signal);
	});
});

describe("describeWorkerNudge", () => {
	it("tells the worker to commit a SUMMARY and names no tool it cannot reach", () => {
		const message = describeWorkerNudge();
		expect(message).toMatch(/SUMMARY/);
		// It may say the expert is *unavailable*, but must never offer a tool a
		// headless worker does not hold.
		expect(message).toMatch(/cannot hand this to an expert/i);
		expect(message).not.toMatch(/`escalate`|`spawn_agent`/);
	});
});
