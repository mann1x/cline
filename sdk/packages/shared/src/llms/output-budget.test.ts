import { describe, expect, it } from "vitest";
import {
	OUTPUT_BUDGET_AUTO_WINDOW_SHARE,
	OUTPUT_BUDGET_CEILING_TOKENS,
	resolveOutputBudgetTokens,
} from "./output-budget";

describe("resolveOutputBudgetTokens", () => {
	it("targets three quarters of the window on auto", () => {
		expect(
			resolveOutputBudgetTokens({ mode: "auto", contextWindow: 128_000 }),
		).toBe(96_000);
	});

	it("treats an unset mode as auto", () => {
		expect(resolveOutputBudgetTokens({ contextWindow: 128_000 })).toBe(96_000);
	});

	it("holds auto to the absolute ceiling on a very wide window", () => {
		// 75% of 1M is 750,000, and models struggle past 512k whatever the
		// window says it can hold.
		expect(
			resolveOutputBudgetTokens({ mode: "auto", contextWindow: 1_000_000 }),
		).toBe(OUTPUT_BUDGET_CEILING_TOKENS);
	});

	it("lets the user lower the ceiling while staying on auto", () => {
		expect(
			resolveOutputBudgetTokens({
				mode: "auto",
				contextWindow: 1_000_000,
				maxTokens: 200_000,
			}),
		).toBe(200_000);
	});

	it("does not let the auto override raise the absolute ceiling", () => {
		expect(
			resolveOutputBudgetTokens({
				mode: "auto",
				contextWindow: 1_000_000,
				maxTokens: 900_000,
			}),
		).toBe(OUTPUT_BUDGET_CEILING_TOKENS);
	});

	it("never exceeds what the model says it can emit", () => {
		expect(
			resolveOutputBudgetTokens({
				mode: "auto",
				contextWindow: 200_000,
				modelMaxOutputTokens: 8_192,
			}),
		).toBe(8_192);
	});

	it("sends the manual value as typed", () => {
		expect(
			resolveOutputBudgetTokens({
				mode: "manual",
				maxTokens: 64_000,
				contextWindow: 128_000,
			}),
		).toBe(64_000);
	});

	it("still holds a manual value to the absolute ceiling", () => {
		expect(
			resolveOutputBudgetTokens({ mode: "manual", maxTokens: 900_000 }),
		).toBe(OUTPUT_BUDGET_CEILING_TOKENS);
	});

	it("falls back to auto when manual is selected with no value typed", () => {
		expect(
			resolveOutputBudgetTokens({ mode: "manual", contextWindow: 128_000 }),
		).toBe(96_000);
	});

	it("answers nothing when there is no window to size against", () => {
		expect(resolveOutputBudgetTokens({ mode: "auto" })).toBeUndefined();
	});

	it("keeps the share and the ceiling as the two published numbers", () => {
		expect(OUTPUT_BUDGET_AUTO_WINDOW_SHARE).toBe(0.75);
		expect(OUTPUT_BUDGET_CEILING_TOKENS).toBe(512_000);
	});
});
