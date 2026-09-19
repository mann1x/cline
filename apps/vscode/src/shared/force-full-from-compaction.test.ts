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

	// Zero has to survive as a value rather than read as "unset". It is now the
	// default -- the ladder is off unless someone asks for it -- so the panel
	// shows a filled box reading 0 and writes a number when it is changed. A
	// key that defaulted to `undefined` would render an empty box that means
	// nothing, and `?? 0` at every reader would hide which of the two it was.
	it("spells the off switch as a number, not as unset", () => {
		const value = getDefaultValue("forceFullFromCompaction")
		assert.equal(typeof value, "number")
		assert.equal(Number.isFinite(value), true)
	})
})
