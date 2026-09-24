import type { AgentEvent, AgentTool } from "@cline/shared";
import { describe, expect, it } from "vitest";
import {
	createWorkerStruggleSupervisor,
	describeWorkerNudge,
} from "./worker-struggle";

const BUDGET_MESSAGE =
	"I have used my thinking budget. I must stop analysing now and act on what I have: make the tool call, or give a short final answer if no call is needed.";

type Supervisor = ReturnType<typeof createWorkerStruggleSupervisor>;

/**
 * One tool-calling turn. `spent` ends its reasoning the way the engine ends
 * reasoning it cut at the budget -- which is what the replayed `k76ar4` did on
 * 9 of its 18 turns.
 */
function turn(
	supervisor: Supervisor,
	iteration: number,
	options: { spent?: boolean; reasoning?: string; refusedEdit?: boolean } = {},
): void {
	supervisor.observe({ type: "iteration_start", iteration });
	const reasoning =
		options.reasoning ??
		(options.spent
			? `Line 90 ends with }}});} so one brace is extra. Actually, I have enough evidence to write the report. Let me try awk once more.\n\n${BUDGET_MESSAGE}`
			: "Reading the next section.");
	supervisor.observe({
		type: "content_end",
		contentType: "reasoning",
		reasoning,
	});
	supervisor.observe({
		type: "content_end",
		contentType: "tool",
		toolName: options.refusedEdit ? "editor" : "grep",
		...(options.refusedEdit
			? { error: "refused: the range no longer matches" }
			: {}),
		output: "ok",
	});
	supervisor.observe({
		type: "iteration_end",
		iteration,
		hadToolCalls: true,
		toolCallCount: 1,
	});
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

	// The loop the replay found: thinking that runs out its budget turn after
	// turn, each time followed by one more probe instead of an answer.
	it("nudges on thinking that keeps exhausting its budget, then stops if it carries on", () => {
		const transitions: string[] = [];
		const supervisor = createWorkerStruggleSupervisor({
			onTransition: (phase, reason) => transitions.push(`${phase}:${reason}`),
		});
		// k76ar4's first six turns: 1 2 [spent] 2 [spent] [spent].
		turn(supervisor, 1);
		turn(supervisor, 2);
		turn(supervisor, 3, { spent: true });
		turn(supervisor, 4);
		turn(supervisor, 5, { spent: true });
		expect(supervisor.phase).toBe("watching");
		turn(supervisor, 6, { spent: true });
		expect(supervisor.phase).toBe("nudged");

		// Inside the grace window nothing counts toward the stop.
		turn(supervisor, 7, { spent: true });
		turn(supervisor, 8, { spent: true });
		expect(supervisor.phase).toBe("nudged");

		turn(supervisor, 9, { spent: true });
		expect(supervisor.phase).toBe("nudged");
		turn(supervisor, 10, { spent: true });
		expect(supervisor.phase).toBe("stopped");
		expect(supervisor.stopSignal.aborted).toBe(true);
		expect(transitions).toEqual([
			"nudged:thinking-budget",
			"stopped:thinking-budget",
		]);
	});

	// The workers that took longest on the replayed swarms -- 29, 36 and 43
	// turns -- all answered. The turn count earns a nudge and nothing more.
	it("nudges a long run but never stops it for its length alone", () => {
		const supervisor = createWorkerStruggleSupervisor({
			nudgeAfterIterations: 6,
		});
		for (let i = 1; i <= 60; i += 1) {
			turn(supervisor, i);
		}
		expect(supervisor.phase).toBe("nudged");
		expect(supervisor.stopSignal.aborted).toBe(false);
	});

	// Detection parity with the lead: the reused detector catches an unbroken
	// run of refused edits. Nudge only -- the replayed workers it fired on went
	// on to answer.
	it("nudges on a refused-edit streak and does not stop for it", () => {
		const transitions: string[] = [];
		const supervisor = createWorkerStruggleSupervisor({
			nudgeAfterIterations: 1_000,
			onTransition: (phase, reason) => transitions.push(`${phase}:${reason}`),
		});
		for (let i = 1; i <= 30; i += 1) {
			turn(supervisor, i, { refusedEdit: true });
		}
		expect(transitions).toEqual(["nudged:struggle"]);
		expect(supervisor.stopSignal.aborted).toBe(false);
	});

	// Budget turns spread thinly are a model using its thinking, not a loop.
	it("does not nudge on budget turns spread outside its window", () => {
		const supervisor = createWorkerStruggleSupervisor({
			nudgeAfterIterations: 1_000,
		});
		for (let i = 1; i <= 30; i += 1) {
			turn(supervisor, i, { spent: i % 4 === 0 });
		}
		expect(supervisor.phase).toBe("watching");
	});

	it("matches the session's own budget message when it knows it", () => {
		const supervisor = createWorkerStruggleSupervisor({
			thinkingBudgetMessage: "\n\nBUDGET GONE -- act now.\n",
			nudgeAfterIterations: 1_000,
		});
		for (let i = 1; i <= 3; i += 1) {
			turn(supervisor, i, {
				reasoning: "long thought...\nBUDGET GONE -- act now.",
			});
		}
		expect(supervisor.phase).toBe("nudged");
	});

	// Tail-anchored: reasoning that talks about a budget mid-thought has not
	// run out of it.
	it("does not count reasoning that only mentions its budget mid-thought", () => {
		const supervisor = createWorkerStruggleSupervisor({
			nudgeAfterIterations: 1_000,
		});
		const mention = `I have used my thinking budget wisely so far. ${"More careful analysis of the braces. ".repeat(40)}`;
		for (let i = 1; i <= 6; i += 1) {
			turn(supervisor, i, { reasoning: mention });
		}
		expect(supervisor.phase).toBe("watching");
	});

	// Delivered on the next tool result, never appended to the conversation --
	// a delegated run's message store is snapshotted at start and overwritten
	// at end.
	it("attaches the held nudge to the next tool result, once", async () => {
		const supervisor = createWorkerStruggleSupervisor({
			nudgeAfterIterations: 2,
			nudgeMessage: "COMMIT NOW",
		});
		turn(supervisor, 1);
		turn(supervisor, 2);
		expect(supervisor.phase).toBe("nudged");

		const [grep] = supervisor.wrapTools([textTool("grep", "found 3 matches")]);
		const first = await grep.execute({}, {} as never);
		expect(first).toContain("found 3 matches");
		expect(first).toContain("COMMIT NOW");

		const second = await grep.execute({}, {} as never);
		expect(second).toBe("found 3 matches");
	});

	it("words the nudge for what fired it", async () => {
		const supervisor = createWorkerStruggleSupervisor({
			nudgeAfterIterations: 1_000,
		});
		for (let i = 1; i <= 3; i += 1) {
			turn(supervisor, i, { spent: true });
		}
		const [grep] = supervisor.wrapTools([textTool("grep", "ok")]);
		expect(await grep.execute({}, {} as never)).toContain(
			"run out its whole budget",
		);
	});

	it("stops through a caller-provided abort controller", () => {
		const controller = new AbortController();
		const supervisor = createWorkerStruggleSupervisor({
			abortController: controller,
			graceIterations: 0,
			budgetTurnsToStop: 1,
		});
		for (let i = 1; i <= 4; i += 1) {
			turn(supervisor, i, { spent: true });
		}
		expect(controller.signal.aborted).toBe(true);
		expect(supervisor.stopSignal).toBe(controller.signal);
	});
});

describe("describeWorkerNudge", () => {
	it("tells the worker to commit a SUMMARY and names no tool it cannot reach", () => {
		for (const reason of [
			"thinking-budget",
			"struggle",
			"non-progress",
			undefined,
		] as const) {
			const message = describeWorkerNudge(reason);
			expect(message).toMatch(/SUMMARY/);
			expect(message).toMatch(/cannot hand this to an expert/i);
			expect(message).not.toMatch(/`escalate`|`spawn_agent`/);
		}
	});
});
