import { describe, expect, it } from "vitest";
import { createMistakeLimitDecisionResolver } from "./mistakes";

describe("createMistakeLimitDecisionResolver", () => {
	it("stops immediately when auto-approve is enabled", async () => {
		const decide = createMistakeLimitDecisionResolver({
			autoApproveAllRef: { current: true },
			askQuestionRef: { current: null },
		});

		await expect(
			decide({
				iteration: 1,
				consecutiveMistakes: 3,
				maxConsecutiveMistakes: 3,
				reason: "api_error",
			}),
		).resolves.toMatchObject({
			action: "stop",
		});
	});

	// The two stops read the same before this: a loop guard firing at one
	// recorded mistake was announced as "max consecutive mistakes reached (3)",
	// and the limit is where the reader then goes looking.
	it("names the loop guard, not the limit, on a forced stop", async () => {
		const decide = createMistakeLimitDecisionResolver({
			autoApproveAllRef: { current: true },
			askQuestionRef: { current: null },
		});

		const decision = await decide({
			iteration: 12,
			consecutiveMistakes: 1,
			maxConsecutiveMistakes: 6,
			reason: "tool_execution_failed",
			details: "This exact call to `editor` was refused 6 times",
			forced: true,
		});

		expect(decision).toMatchObject({ action: "stop" });
		expect(decision.reason).toContain("loop guard");
		expect(decision.reason).not.toContain("max consecutive mistakes");
	});

	it("asks nothing on a forced stop, even with a terminal attached", async () => {
		let asked = 0;
		const decide = createMistakeLimitDecisionResolver({
			autoApproveAllRef: { current: false },
			askQuestionRef: {
				current: async () => {
					asked += 1;
					return "Try a different approach";
				},
			},
		});

		await expect(
			decide({
				iteration: 12,
				consecutiveMistakes: 1,
				maxConsecutiveMistakes: 6,
				reason: "tool_execution_failed",
				forced: true,
			}),
		).resolves.toMatchObject({ action: "stop" });
		expect(asked).toBe(0);
	});

	it("continues with retry guidance for the default answer", async () => {
		const decide = createMistakeLimitDecisionResolver({
			autoApproveAllRef: { current: false },
			askQuestionRef: { current: null },
		});

		await expect(
			decide({
				iteration: 4,
				consecutiveMistakes: 2,
				maxConsecutiveMistakes: 3,
				reason: "tool_execution_failed",
				details: "bad args",
			}),
		).resolves.toMatchObject({
			action: "continue",
			guidance: expect.stringContaining("retry with a different approach"),
		});
	});

	it("honors an explicit stop answer", async () => {
		const decide = createMistakeLimitDecisionResolver({
			autoApproveAllRef: { current: false },
			askQuestionRef: { current: async () => "Stop this run" },
		});

		await expect(
			decide({
				iteration: 4,
				consecutiveMistakes: 2,
				maxConsecutiveMistakes: 3,
				reason: "invalid_tool_call",
			}),
		).resolves.toMatchObject({
			action: "stop",
		});
	});
});
