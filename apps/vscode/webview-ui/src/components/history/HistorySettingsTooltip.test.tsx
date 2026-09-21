import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { HISTORY_SETTINGS_HOVER_DELAY_MS, HistorySettingsTooltip } from "./HistorySettingsTooltip"

describe("HistorySettingsTooltip", () => {
	it("lays out every row it is given", () => {
		render(
			<HistorySettingsTooltip
				settings={[
					{ label: "Provider", value: "opencoti" },
					{ label: "temperature", value: "0.5" },
				]}
			/>,
		)

		expect(screen.getByText("Provider")).toBeTruthy()
		expect(screen.getByText("opencoti")).toBeTruthy()
		expect(screen.getByText("temperature")).toBeTruthy()
		expect(screen.getByText("0.5")).toBeTruthy()
	})

	// A card with nothing in it is worse than no card: it opens, covers the row
	// under the pointer, and says nothing.
	it("renders nothing when there is nothing to say", () => {
		const { container } = render(<HistorySettingsTooltip settings={[]} />)
		expect(container.firstChild).toBeNull()
	})

	// The number is the feature. A list is scanned far more often than it is
	// interrogated, so the dwell has to be past the point of being accidental.
	it("waits two seconds", () => {
		expect(HISTORY_SETTINGS_HOVER_DELAY_MS).toBe(2000)
	})
})
