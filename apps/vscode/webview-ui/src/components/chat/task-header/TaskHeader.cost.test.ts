import { describe, expect, it } from "vitest"
import { shouldShowTaskCost } from "./TaskHeader"

describe("the task cost badge", () => {
	// Reported: "make sure when input/output price is set to 0 the conversation
	// does not report the price badges with $0.0000, it's useless." A local
	// llama.cpp or opencoti server is priced at zero, is on none of the excluded
	// provider lists, and reports usageCostDisplay "show" — so every task
	// carried a badge that could only ever read $0.0000.
	it("says nothing when the provider is free", () => {
		expect(
			shouldShowTaskCost({
				totalCost: 0,
				apiProvider: "opencoti",
				inputPrice: 0,
				outputPrice: 0,
				usageCostDisplay: "show",
			}),
		).toBe(false)
	})

	it("still shows a cost that was actually incurred", () => {
		expect(shouldShowTaskCost({ totalCost: 0.0132, apiProvider: "anthropic", usageCostDisplay: "show" })).toBe(true)
	})

	// The provider rules are unchanged; only the amount is new.
	it("keeps the providers that never report a cost quiet", () => {
		for (const apiProvider of ["vscode-lm", "ollama", "lmstudio"]) {
			expect(shouldShowTaskCost({ totalCost: 1, apiProvider, usageCostDisplay: "show" })).toBe(false)
		}
	})

	it("still requires both prices on a bare openai-compatible endpoint", () => {
		expect(shouldShowTaskCost({ totalCost: 1, apiProvider: "openai", inputPrice: 3 })).toBe(false)
		expect(shouldShowTaskCost({ totalCost: 1, apiProvider: "openai", inputPrice: 3, outputPrice: 15 })).toBe(true)
	})

	it("says nothing while a subscription provider is flat-rated", () => {
		expect(shouldShowTaskCost({ totalCost: 1, apiProvider: "openai-codex", usageCostDisplay: "subscription" })).toBe(false)
	})
})
