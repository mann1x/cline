import { describe, expect, it } from "vitest"
import { REASONING_EFFORT_RATIOS } from "./reasoning-effort"
import {
	canonicalOllamaThinkLevel,
	isBudgetedOllamaThinkLevel,
	OLLAMA_THINK_BUDGET_FRACTIONS,
	ollamaThinkBudgetTokens,
	ollamaThinkBudgetWindow,
	resolveOllamaThinkBudget,
} from "./ollama-think-budget"

describe("ollama think budget fractions", () => {
	it("matches api/types.go thinkBudgetFraction exactly", () => {
		// Drift here is silent everywhere else: the server keeps computing its
		// own number and this side keeps reporting a different one.
		expect(OLLAMA_THINK_BUDGET_FRACTIONS).toEqual({
			max: [4, 5],
			high: [1, 2],
			medium: [1, 4],
			low: [1, 8],
			minimal: [1, 16],
		})
	})

	it("is not the AI SDK effort scale", () => {
		// The reason this module exists. `max` in particular differs: 4/5 here
		// against 1 there, and a budget equal to the whole window leaves the
		// model no room to answer in.
		expect(REASONING_EFFORT_RATIOS.max).toBe(1)
		expect(OLLAMA_THINK_BUDGET_FRACTIONS.max[0] / OLLAMA_THINK_BUDGET_FRACTIONS.max[1]).toBe(0.8)
		expect(OLLAMA_THINK_BUDGET_FRACTIONS.medium[0] / OLLAMA_THINK_BUDGET_FRACTIONS.medium[1]).not.toBe(
			REASONING_EFFORT_RATIOS.medium,
		)
	})

	it("resolves xhigh to max", () => {
		expect(canonicalOllamaThinkLevel("xhigh")).toBe("max")
		expect(canonicalOllamaThinkLevel("XHigh")).toBe("max")
		expect(isBudgetedOllamaThinkLevel("xhigh")).toBe(true)
		expect(isBudgetedOllamaThinkLevel("default")).toBe(false)
	})

	it("never lets a level consume the whole window", () => {
		for (const level of Object.keys(OLLAMA_THINK_BUDGET_FRACTIONS)) {
			expect(ollamaThinkBudgetTokens(level, 10_000)).toBeLessThan(10_000)
		}
	})

	it("leaves no budget for a level it does not know", () => {
		expect(ollamaThinkBudgetTokens("enthusiastic", 10_000)).toBe(0)
		expect(ollamaThinkBudgetTokens("medium", 0)).toBe(0)
	})
})

describe("ollamaThinkBudgetWindow", () => {
	it("divides the response cap, not the context, when both are known", () => {
		expect(ollamaThinkBudgetWindow(128_000, 8_000)).toBe(8_000)
	})

	it("falls back to the context when no response cap is set", () => {
		expect(ollamaThinkBudgetWindow(128_000, 0)).toBe(128_000)
		expect(ollamaThinkBudgetWindow(128_000, undefined)).toBe(128_000)
	})

	it("never exceeds the context", () => {
		expect(ollamaThinkBudgetWindow(4_000, 32_000)).toBe(4_000)
	})
})

describe("resolveOllamaThinkBudget", () => {
	it("scales a level with the shrinking response cap", () => {
		// The failure this guards: as the transcript grows, num_predict
		// collapses, and a level has to collapse with it.
		expect(resolveOllamaThinkBudget({ thinkBudget: "medium", numCtx: 128_000, numPredict: 32_000 }).tokens).toBe(8_000)
		expect(resolveOllamaThinkBudget({ thinkBudget: "medium", numCtx: 128_000, numPredict: 1_232 }).tokens).toBe(308)
	})

	it("clamps a literal budget that no longer fits the cap", () => {
		// A number chosen against a roomy window is the one thing that does not
		// shrink on its own, so it is the one thing that strands a turn.
		const resolved = resolveOllamaThinkBudget({
			thinkBudget: "8192",
			level: "medium",
			numCtx: 128_000,
			numPredict: 1_232,
		})
		expect(resolved.clamped).toBe(true)
		expect(resolved.tokens).toBe(308)
	})

	it("leaves a literal budget alone while it still fits", () => {
		const resolved = resolveOllamaThinkBudget({
			thinkBudget: "4000",
			level: "medium",
			numCtx: 128_000,
			numPredict: 32_000,
		})
		expect(resolved.clamped).toBe(false)
		expect(resolved.tokens).toBe(4_000)
	})

	it("reads a budget as a level or a number, never as a prefix", () => {
		expect(resolveOllamaThinkBudget({ thinkBudget: "4high", numCtx: 0, numPredict: 10_000 }).tokens).toBe(0)
		expect(resolveOllamaThinkBudget({ thinkBudget: "high", numCtx: 0, numPredict: 10_000 }).tokens).toBe(5_000)
	})

	it("reports no budget when nothing asks for one", () => {
		expect(resolveOllamaThinkBudget({ numCtx: 128_000, numPredict: 32_000 }).tokens).toBe(0)
	})
})
