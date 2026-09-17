import assert from "node:assert/strict"
import { resolveStruggleThresholds } from "@cline/core"
import { describe, it } from "vitest"
import { DEFAULT_ESCALATION_SETTINGS } from "./EscalationSettings"

// The Escalation tab shows these numbers in filled boxes rather than empty
// ones, so a user tuning them starts from what is in force instead of guessing
// what "blank" means. That only holds while the two agree, and nothing in the
// type system makes them: core's constants and the panel's defaults are two
// literals in two packages.
describe("escalation thresholds", () => {
	it("shows the numbers the detector would use when told nothing", () => {
		const core = resolveStruggleThresholds(undefined)

		assert.equal(DEFAULT_ESCALATION_SETTINGS.struggleFailedCalls, core.failedCalls)
		assert.equal(DEFAULT_ESCALATION_SETTINGS.struggleDistressHits, core.distressHits)
		assert.equal(DEFAULT_ESCALATION_SETTINGS.struggleWindow, core.window)
		assert.equal(DEFAULT_ESCALATION_SETTINGS.struggleMinIteration, core.minIteration)
		assert.equal(DEFAULT_ESCALATION_SETTINGS.struggleMaxPerTask, core.maxPerTask)
		assert.equal(DEFAULT_ESCALATION_SETTINGS.struggleEditStreak, core.editStreak)
		assert.equal(DEFAULT_ESCALATION_SETTINGS.struggleFailedTransactions, core.failedTransactions)
	})
})
