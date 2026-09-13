/**
 * The evidence beside the model's own account of itself.
 */

import { describe, expect, it } from "vitest";
import { buildEscalationAssessment } from "./assessment";

describe("the harness's own reading", () => {
	it("counts what was counted", () => {
		const assessment = buildEscalationAssessment({
			iteration: 64,
			signals: {
				iteration: 64,
				failedCalls: 5,
				distress: 3,
				hedgingRatio: 1.1,
			},
			transactions: { opened: 3, discarded: 2 },
		});

		expect(assessment).toContain("Turn 64");
		expect(assessment).toContain("last 10 turns: 5");
		expect(assessment).toContain("3 occurrences");
		expect(assessment).toContain("1.10×");
		expect(assessment).toContain("3 opened, 2 judged and rolled back");
	});

	// A run whose hedging is collapsing is converging, and saying so is as much
	// of the evidence as the other direction.
	it("says so when the hedging is falling", () => {
		const assessment = buildEscalationAssessment({
			signals: {
				iteration: 40,
				failedCalls: 4,
				distress: 0,
				hedgingRatio: 0.4,
			},
		});

		expect(assessment).toContain("converging");
	});

	// Nothing measured is a real answer. A section reading "0 failures, no
	// transactions" would be read as evidence of health.
	it("says nothing when nothing has been measured", () => {
		expect(buildEscalationAssessment({})).toBeUndefined();
		expect(
			buildEscalationAssessment({ transactions: { opened: 0, discarded: 0 } }),
		).toBeUndefined();
	});

	// Nothing here separates a hard task from a stuck model, and a line that
	// claimed to would be claiming a precision the study does not support.
	it("does not deliver a verdict", () => {
		const assessment = buildEscalationAssessment({
			signals: { iteration: 64, failedCalls: 9, distress: 6, hedgingRatio: 2 },
		});

		expect(assessment).toContain("None of this is a verdict");
	});

	// Carried verbatim, bound and all: the walker words its own line because
	// the bound has to travel with the number wherever it is read.
	it("carries the complexity lines it was handed", () => {
		const assessment = buildEscalationAssessment({
			signals: { iteration: 40, failedCalls: 5, distress: 0 },
			complexity: [
				"Cognitive complexity of `step` (game.js:10-40): 31. That measures how hard…",
			],
		});

		expect(assessment).toContain("Cognitive complexity of `step`");
	});

	it("says when a guard has already stood down", () => {
		const assessment = buildEscalationAssessment({
			signals: { iteration: 90, failedCalls: 6, distress: 0 },
			guardStoodDown: true,
		});

		expect(assessment).toContain("terminal guard has already stood down");
	});
});
