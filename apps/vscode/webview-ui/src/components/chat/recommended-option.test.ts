import { describe, expect, it } from "vitest"
import { readOptionItems } from "./recommended-option"

/**
 * Asked for after a run offered options and no view: the model should say which
 * one it would pick, when it has a basis to. The mark rides as a suffix because
 * the options are a plain `string[]` from the schema all the way to the button.
 */
describe("the recommendation on an option", () => {
	it("marks the one option the model chose and strips the marker", () => {
		const items = readOptionItems(["Keep the current behaviour", "Rewrite the parser (recommended)"])

		expect(items.map((item) => item.label)).toEqual(["Keep the current behaviour", "Rewrite the parser"])
		expect(items.map((item) => item.recommended)).toEqual([false, true])
	})

	// The reported case: "there are cases where every choice is genuinely
	// different and there's no one that can be set as recommended." Nothing
	// marked is a valid answer and must render exactly as it did before.
	it("leaves every option unmarked when the model recommended none", () => {
		const items = readOptionItems(["Dark theme", "Light theme", "Follow the system"])

		expect(items.map((item) => item.recommended)).toEqual([false, false, false])
		expect(items.map((item) => item.label)).toEqual(["Dark theme", "Light theme", "Follow the system"])
	})

	// Marking everything is not a recommendation. Honouring the first would be
	// inventing a preference the model did not express.
	it("treats more than one mark as no recommendation", () => {
		const items = readOptionItems(["Ship it (recommended)", "Hold it (recommended)"])

		expect(items.map((item) => item.recommended)).toEqual([false, false])
		// The marker still comes off, so the buttons do not read as duplicates
		// of a word the user never chose.
		expect(items.map((item) => item.label)).toEqual(["Ship it", "Hold it"])
	})

	it("tolerates how the model writes it", () => {
		for (const written of ["Do it (Recommended)", "Do it (recommended).", "Do it  (RECOMMENDED) "]) {
			const [item] = readOptionItems([written, "Do not"])
			expect(item.label).toBe("Do it")
			expect(item.recommended).toBe(true)
		}
	})

	// A marker with nothing in front of it would render as an empty button.
	it("does not eat an option that is only the marker", () => {
		const [item] = readOptionItems(["(recommended)", "Something else"])

		expect(item.label).toBe("(recommended)")
		expect(item.recommended).toBe(false)
	})

	it("says nothing about options that are not there", () => {
		expect(readOptionItems(undefined)).toEqual([])
	})
})
