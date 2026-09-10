import { describe, expect, it } from "vitest"
import { subagentIdentity } from "./subagentIdentity"

describe("subagentIdentity", () => {
	it("uses the name the lead gave the sub-agent", () => {
		expect(subagentIdentity(1, "api-review").label).toBe("api-review")
		expect(subagentIdentity(2, "  tests  ").label).toBe("tests")
	})

	it("falls back to the index when nothing named it", () => {
		expect(subagentIdentity(3).label).toBe("Agent 3")
		expect(subagentIdentity(4, "   ").label).toBe("Agent 4")
	})

	it("gives concurrent sub-agents different colours", () => {
		const colours = [1, 2, 3, 4, 5, 6].map((index) => subagentIdentity(index).style.backgroundColor)
		expect(new Set(colours).size).toBe(colours.length)
	})

	it("never assigns red or green, which mean failed and completed", () => {
		// Every hue the palette can produce, not only the first six: the seventh
		// agent wraps around, and a wrap that landed on red would be worse than
		// a repeat.
		for (let index = 1; index <= 24; index++) {
			const hue = Number(/hsl\((\d+)/.exec(subagentIdentity(index).style.backgroundColor)?.[1])
			expect(Number.isFinite(hue)).toBe(true)
			const isRed = hue < 25 || hue > 330
			const isGreen = hue >= 85 && hue <= 160
			expect(isRed || isGreen).toBe(false)
		}
	})

	it("gives the same sub-agent the same colour every time it is rendered", () => {
		expect(subagentIdentity(2, "tests").style).toEqual(subagentIdentity(2, "tests").style)
		// The colour is the position, not the name -- a renamed agent in the
		// same slot keeps its colour, and two agents cannot collide on one.
		expect(subagentIdentity(2, "tests").style).toEqual(subagentIdentity(2, "docs").style)
	})
})
