import type { SubagentStatusItem } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { currentWarning, type WarningSeen } from "./subagentWarning"

function agent(over: Partial<SubagentStatusItem>): SubagentStatusItem {
	return {
		index: 0,
		prompt: "p",
		status: "running",
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalCost: 0,
		contextTokens: 0,
		contextWindow: 0,
		contextUsagePercentage: 0,
		...over,
	}
}

const warn = { at: 1, text: "node not answering", severity: "warn" as const }
const info = { at: 2, text: "refused it (refusal 1): at ceiling; waiting for room" }

describe("currentWarning", () => {
	it("an info line, such as a refusal, is never a warning", () => {
		expect(currentWarning(agent({ activity: [info] }), undefined).current).toBe(false)
	})

	it("a warning is current until the agent makes progress after it", () => {
		const first = currentWarning(agent({ activity: [warn] }), undefined)
		expect(first.current).toBe(true)
		const still = currentWarning(agent({ activity: [warn, info] }), first.seen)
		expect(still.current).toBe(true)
		const working = currentWarning(agent({ activity: [warn, info], outputTokens: 40 }), still.seen)
		expect(working.current).toBe(false)
	})

	it("a new warning after progress is current again", () => {
		const seen: WarningSeen = { warnings: 1, progressAtWarning: "0|0" }
		const cleared = currentWarning(agent({ activity: [warn], outputTokens: 40 }), seen)
		expect(cleared.current).toBe(false)
		const again = currentWarning(agent({ activity: [warn, { ...warn, at: 3 }], outputTokens: 40 }), cleared.seen)
		expect(again.current).toBe(true)
	})

	it("a tool call counts as progress", () => {
		const first = currentWarning(agent({ activity: [warn] }), undefined)
		expect(currentWarning(agent({ activity: [warn], toolCalls: 1 }), first.seen).current).toBe(false)
	})
})
