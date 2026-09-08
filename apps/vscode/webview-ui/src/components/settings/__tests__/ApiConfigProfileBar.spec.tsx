import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ApiConfigProfileBar from "../ApiConfigProfileBar"
import { DROPDOWN_Z_INDEX } from "../ApiOptions"

const profilesHook = {
	profiles: [{ name: "local-qwen" }, { name: "cloud-sonnet" }, { name: "vision" }],
	activeName: "local-qwen",
	isDirty: false,
	suggestedName: "ollama · qwen3",
	loadProfile: vi.fn(),
	saveProfile: vi.fn(),
	deleteProfile: vi.fn(),
}

vi.mock("../utils/useApiConfigurationProfiles", () => ({
	useApiConfigurationProfiles: () => profilesHook,
}))

describe("ApiConfigProfileBar", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("opens its list above the provider controls below it", () => {
		// The API Provider combobox raises its own input to DROPDOWN_Z_INDEX. An
		// unraised profile list was painted underneath it and clipped at the first
		// row — invisible until enough profiles were saved for the list to reach
		// that far down the panel.
		render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

		const dropdown = document.getElementById("api-config-profile")
		expect(dropdown).not.toBeNull()

		const wrapper = dropdown?.parentElement as HTMLElement
		const zIndex = Number.parseInt(window.getComputedStyle(wrapper).zIndex, 10)
		expect(Number.isNaN(zIndex)).toBe(false)
		expect(zIndex).toBeGreaterThan(DROPDOWN_Z_INDEX)
	})

	it("keeps the dropdown filling the row it shares with the buttons", () => {
		// The raised wrapper took over the flex sizing; without it the dropdown
		// collapses to its content width and the row reflows.
		render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

		const wrapper = document.getElementById("api-config-profile")?.parentElement as HTMLElement
		expect(wrapper.className).toContain("flex-1")
		expect(screen.getByText("local-qwen")).toBeInTheDocument()
	})
})
