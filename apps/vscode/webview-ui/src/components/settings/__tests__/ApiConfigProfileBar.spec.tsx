import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ApiConfigProfileBar from "../ApiConfigProfileBar"
import { DROPDOWN_Z_INDEX } from "../ApiOptions"
import { __resetPendingEdits, registerPendingEdit } from "../utils/pendingEdits"

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
		profilesHook.isDirty = false
		profilesHook.activeName = "local-qwen"
	})

	afterEach(() => {
		__resetPendingEdits()
	})

	/**
	 * Picks a profile from the list.
	 *
	 * Assigned rather than passed as `target`: the custom element is not
	 * upgraded under jsdom, so it has no `value` setter for fireEvent to find.
	 */
	function pick(name: string) {
		const dropdown = document.getElementById("api-config-profile") as HTMLElement & { value: string }
		dropdown.value = name
		fireEvent.change(dropdown)
	}

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

	/**
	 * Loading a profile replaces every setting on the tab, and there was nothing
	 * between picking a name and that happening.
	 */
	describe("picking a profile over unsaved changes", () => {
		it("loads straight away when there is nothing to lose", () => {
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

			pick("cloud-sonnet")

			expect(profilesHook.loadProfile).toHaveBeenCalledWith("cloud-sonnet")
		})

		it("asks first when the panel has drifted from the profile", () => {
			profilesHook.isDirty = true
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

			pick("cloud-sonnet")

			expect(profilesHook.loadProfile).not.toHaveBeenCalled()
			expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
		})

		it("asks when a field is still inside its debounce, which isDirty cannot see", () => {
			// The measured case: the value is typed, the store has not been told
			// yet, so nothing the profile compares against has changed.
			registerPendingEdit({ pending: () => true, flush: () => {}, discard: () => {} })
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

			pick("cloud-sonnet")

			expect(profilesHook.loadProfile).not.toHaveBeenCalled()
			expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
		})

		it("loads the picked profile once the loss is accepted", () => {
			profilesHook.isDirty = true
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			pick("cloud-sonnet")

			fireEvent.click(screen.getByText("Discard and load"))

			expect(profilesHook.loadProfile).toHaveBeenCalledWith("cloud-sonnet")
		})

		it("saves the current profile first when asked to", () => {
			profilesHook.isDirty = true
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			pick("cloud-sonnet")

			fireEvent.click(screen.getByText(/Update .* first/))

			expect(profilesHook.saveProfile).toHaveBeenCalledWith("local-qwen")
		})

		it("loads nothing when the switch is cancelled", () => {
			profilesHook.isDirty = true
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			pick("cloud-sonnet")

			fireEvent.click(screen.getByText("Cancel"))

			expect(profilesHook.loadProfile).not.toHaveBeenCalled()
			expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
		})

		it("puts the list back to the profile that is actually loaded", () => {
			// The dropdown moved to the name that was clicked before anything was
			// loaded. `value` still holds activeName and has not changed, so React
			// has nothing to re-apply -- the list would go on naming a profile the
			// panel is not showing.
			profilesHook.isDirty = true
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			const before = document.getElementById("api-config-profile")
			pick("cloud-sonnet")

			fireEvent.click(screen.getByText("Cancel"))

			const after = document.getElementById("api-config-profile")
			expect(after).not.toBe(before)
			expect(after?.getAttribute("current-value") ?? (after as any)?.value).toBe("local-qwen")
		})

		it("does nothing when the profile already loaded is picked again", () => {
			profilesHook.isDirty = true
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

			pick("local-qwen")

			expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
			expect(profilesHook.loadProfile).not.toHaveBeenCalled()
		})
	})

	describe("the Load and Revert button", () => {
		it("reverts without asking, because saying Revert is the asking", () => {
			profilesHook.isDirty = true
			registerPendingEdit({ pending: () => true, flush: () => {}, discard: () => {} })
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

			fireEvent.click(screen.getByText("Revert"))

			expect(profilesHook.loadProfile).toHaveBeenCalledWith("local-qwen")
			expect(screen.queryByText("Unsaved changes")).not.toBeInTheDocument()
		})

		it("asks before a Load that would drop a field still inside its debounce", () => {
			// The label says Load rather than Revert only because isDirty cannot
			// see that field yet. It is the same loss either way.
			registerPendingEdit({ pending: () => true, flush: () => {}, discard: () => {} })
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

			fireEvent.click(screen.getByText("Load"))

			expect(profilesHook.loadProfile).not.toHaveBeenCalled()
			expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
		})

		it("loads straight away when nothing is pending", () => {
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

			fireEvent.click(screen.getByText("Load"))

			expect(profilesHook.loadProfile).toHaveBeenCalledWith("local-qwen")
		})
	})
})
