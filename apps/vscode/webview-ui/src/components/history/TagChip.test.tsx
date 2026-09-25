import { describe, expect, it } from "vitest"
import { tagStyle } from "./TagChip"

describe("tagStyle", () => {
	// A tag keeps one colour everywhere it appears, and case does not make a
	// new tag, so it does not make a new colour either.
	it("gives a tag the same colour every time, whatever its case", () => {
		expect(tagStyle("work")).toEqual(tagStyle("work"))
		expect(tagStyle("Work")).toEqual(tagStyle("WORK"))
	})

	it("draws from the agent palette", () => {
		const hues = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((tag) => tagStyle(tag).borderColor))
		expect(hues.size).toBeGreaterThan(1)
		for (const colour of hues) {
			expect(colour).toMatch(/^hsl\((210|275|175|40|245|315) 70% 50% \/ 0\.55\)$/)
		}
	})
})
