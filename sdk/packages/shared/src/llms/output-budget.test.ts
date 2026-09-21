import { describe, expect, it } from "vitest";
import {
	buildOutputBudgetSection,
	OUTPUT_BUDGET_AUTO_WINDOW_SHARE,
	OUTPUT_BUDGET_CEILING_TOKENS,
	resolveOutputBudgetTokens,
	withOutputBudgetSection,
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
		// 75% of 1M is 750,000. The ceiling is also the length of the worst
		// turn a looping model can spend before control comes back, which is
		// why it is 96,000 and not the window's own arithmetic.
		expect(
			resolveOutputBudgetTokens({ mode: "auto", contextWindow: 1_000_000 }),
		).toBe(OUTPUT_BUDGET_CEILING_TOKENS);
	});

	it("lets the user lower the ceiling while staying on auto", () => {
		expect(
			resolveOutputBudgetTokens({
				mode: "auto",
				contextWindow: 1_000_000,
				maxTokens: 32_000,
			}),
		).toBe(32_000);
	});

	// The ceiling moved from 512,000 to 96,000 to bound recovery time, and the
	// claim made for that change was that it costs nothing at the sizes people
	// actually run. This is that claim: at and below a 128,000-token window the
	// share is what binds, so the answer is the one it has always been.
	it("changes nothing at or below a 128,000-token window", () => {
		expect(resolveOutputBudgetTokens({ contextWindow: 128_000 })).toBe(96_000);
		expect(resolveOutputBudgetTokens({ contextWindow: 64_000 })).toBe(48_000);
		expect(resolveOutputBudgetTokens({ contextWindow: 32_768 })).toBe(24_576);
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
		expect(OUTPUT_BUDGET_CEILING_TOKENS).toBe(96_000);
	});
});

describe("withOutputBudgetSection", () => {
	// The section was built in the VS Code factory and lived only there, so the
	// CLI told the model nothing about the cap its reply would be cut at. Moving
	// the wording here is half of it; this is the other half -- the one place
	// every host's session passes through.
	it("appends the section when the host has not", () => {
		const prompt = withOutputBudgetSection("You are Cline.", {
			outputCap: 98304,
			contextWindow: 131072,
		});

		expect(prompt).toContain("# Output Budget");
		expect(prompt).toContain("98304 tokens");
		expect(prompt.startsWith("You are Cline.")).toBe(true);
	});

	// VS Code resolves richer numbers (it asks Ollama for the real allowance)
	// and appends the section itself before this runs. Appending a second one
	// would state two different caps in one prompt, which is worse than either.
	it("leaves a prompt that already states a budget alone", () => {
		const already = `You are Cline.${buildOutputBudgetSection(32000, 128000)}`;
		const prompt = withOutputBudgetSection(already, {
			outputCap: 98304,
			contextWindow: 131072,
		});

		expect(prompt).toBe(already);
	});

	// No cap is not a cap of zero. With nothing to state, saying nothing is the
	// honest answer -- the same rule resolveOutputBudgetTokens follows.
	it("says nothing when there is no cap to state", () => {
		expect(
			withOutputBudgetSection("You are Cline.", { outputCap: undefined }),
		).toBe("You are Cline.");
	});
});
