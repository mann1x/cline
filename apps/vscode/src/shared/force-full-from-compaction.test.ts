import assert from "node:assert/strict"
import { FORCE_FULL_FROM_COMPACTION } from "@cline/core"
import { describe, it } from "vitest"
import { getDefaultValue } from "./storage/state-keys"

// The Compaction section shows this number in a filled box rather than an empty
// one, so a user tuning it starts from what is in force instead of guessing
// what "blank" means. That only holds while the two agree, and nothing in the
// type system makes them: core's constant and the panel's default are two
// literals in two packages. Same arrangement as `escalation-thresholds.test.ts`.
describe("the forced full compaction", () => {
	it("defaults to the compaction core would drop the tail at", () => {
		assert.equal(getDefaultValue("forceFullFromCompaction"), FORCE_FULL_FROM_COMPACTION)
	})

	// Zero has to survive as a value rather than read as "unset": it is how the
	// behaviour is turned off, and a default of zero would also mean the panel
	// could never express "from the second".
	it("has a default that is not the off switch", () => {
		assert.notEqual(getDefaultValue("forceFullFromCompaction"), 0)
	})
})
