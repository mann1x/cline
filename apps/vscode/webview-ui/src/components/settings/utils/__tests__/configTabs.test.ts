import { describe, expect, it } from "vitest"
import { type ConfigTab, isModelTab, SCOPED_TABS } from "../configTabs"

describe("isModelTab", () => {
	it("is true for the session's own modes", () => {
		expect(isModelTab("plan")).toBe(true)
		expect(isModelTab("act")).toBe(true)
	})

	// The Model button uses this for both `isActive` and `disabled`. A scoped
	// tab that answers `true` here renders Model as the selected tab while its
	// own content is showing, and disables the only control that leads back.
	it("is false for every scoped tab, so Model is reachable from all of them", () => {
		for (const tab of SCOPED_TABS) {
			expect(isModelTab(tab as ConfigTab), `${tab} must not report as the Model tab`).toBe(false)
		}
	})

	it("is false on the Images tab specifically", () => {
		expect(isModelTab("imagegen")).toBe(false)
	})
})
