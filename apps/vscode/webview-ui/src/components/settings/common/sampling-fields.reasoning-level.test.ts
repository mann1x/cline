import { describe, expect, it } from "vitest"
import { buildSamplingPatch } from "./sampling-fields"

// The sampler section is written whole, so a field the patch builder does not
// carry is cleared the first time any other control writes the section. The
// reasoning level shares the section with the budget and the sampler.
describe("the reasoning level in the sampler section", () => {
	it("survives a write to another field", () => {
		const patch = buildSamplingPatch({
			dialect: "ollama",
			stored: { reasoningLevel: "xhigh", thinkBudget: "high" },
			draft: { temperature: "0.6" },
		})
		expect(patch.reasoningLevel).toBe("xhigh")
		expect(patch.thinkBudget).toBe("high")
		expect(patch.temperature).toBe(0.6)
	})

	it("is cleared by an empty draft, and the budget is left alone", () => {
		const patch = buildSamplingPatch({
			dialect: "ollama",
			stored: { reasoningLevel: "xhigh", thinkBudget: "high" },
			draft: { reasoningLevel: "" },
		})
		expect(patch.reasoningLevel).toBeUndefined()
		expect(patch.thinkBudget).toBe("high")
	})
})
