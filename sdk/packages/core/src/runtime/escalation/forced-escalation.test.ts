/**
 * The guard that stands down, once, and only for one turn.
 */

import type { AgentEvent } from "@cline/shared";
import { describe, expect, it } from "vitest";
import { createForcedEscalation } from "./forced-escalation";

function harness(remaining = 3) {
	const stopped: string[] = [];
	let left = remaining;
	const forced = createForcedEscalation({
		remaining: () => left,
		stop: (message) => stopped.push(message),
	});
	return {
		forced,
		stopped,
		spend() {
			left -= 1;
		},
		turn(iteration: number, escalated = false) {
			forced.observe({ type: "iteration_start", iteration } as AgentEvent);
			if (escalated) {
				forced.observe({
					type: "content_start",
					contentType: "tool",
					toolName: "escalate",
				} as AgentEvent);
			}
			forced.observe({
				type: "iteration_end",
				iteration,
				hadToolCalls: escalated,
				toolCallCount: escalated ? 1 : 0,
			} as AgentEvent);
		},
	};
}

describe("a terminal guard with somewhere to go", () => {
	it("answers the guard with one turn and the brief to write in it", () => {
		const { forced, turn } = harness();
		turn(20);

		const decision = forced.decide({
			guard: "The repeated-call loop guard",
			diagnosis: "Detected repeated tool calls to `editor`.",
		});

		expect(decision?.action).toBe("continue");
		expect(decision?.action === "continue" && decision.guidance).toContain(
			"escalate",
		);
		expect(decision?.action === "continue" && decision.guidance).toContain(
			"repeated tool calls",
		);
	});

	// The second time a terminal guard fires, it fires.
	it("stands down once in a task", () => {
		const { forced, turn } = harness();
		turn(20);
		expect(
			forced.decide({ guard: "The consecutive-mistake limit" }),
		).toBeDefined();

		expect(
			forced.decide({ guard: "The consecutive-mistake limit" }),
		).toBeUndefined();
	});

	// An offer the budget would refuse is worse than no offer.
	it("leaves the guard standing with no escalations left", () => {
		const { forced, spend, turn } = harness(1);
		turn(20);
		spend();

		expect(
			forced.decide({ guard: "The reasoning-loop guard" }),
		).toBeUndefined();
	});
});

describe("deferred, never removed", () => {
	// The mistake limit's `continue` resets its counter, so without this the run
	// gets a fresh six mistakes out of a guard that was about to end it.
	it("ends the run when the turn goes somewhere else", () => {
		const { forced, stopped, turn } = harness();
		turn(20);
		forced.decide({ guard: "The repeated-call loop guard" });

		turn(21);

		expect(stopped).toHaveLength(1);
		expect(stopped[0]).toContain("The repeated-call loop guard ended this run");
	});

	it("says nothing at the end of the turn the offer was made in", () => {
		const { forced, stopped } = harness();
		forced.observe({ type: "iteration_start", iteration: 20 } as AgentEvent);
		forced.decide({ guard: "The repeated-call loop guard" });
		forced.observe({
			type: "iteration_end",
			iteration: 20,
			hadToolCalls: true,
			toolCallCount: 1,
		} as AgentEvent);

		expect(stopped).toHaveLength(0);
	});

	it("lets the run continue when the offer was taken", () => {
		const { forced, stopped, turn } = harness();
		turn(20);
		forced.decide({ guard: "The repeated-call loop guard" });

		turn(21, true);
		turn(22);

		expect(stopped).toHaveLength(0);
	});
});
