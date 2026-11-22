import { fireEvent, render, screen, waitFor } from "@testing-library/react"
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
	renameProfile: vi.fn().mockResolvedValue(true),
}

const refreshAgents = vi.fn().mockResolvedValue({ agents: [] })
vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: { refreshAgents: (...args: unknown[]) => refreshAgents(...args) },
}))

vi.mock("../utils/useApiConfigurationProfiles", () => ({
	useApiConfigurationProfiles: () => profilesHook,
}))

describe("ApiConfigProfileBar", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		profilesHook.isDirty = false
		profilesHook.activeName = "local-qwen"
		profilesHook.renameProfile.mockResolvedValue(true)
		refreshAgents.mockResolvedValue({ agents: [] })
	})

	afterEach(() => {
		__resetPendingEdits()
	})

	const field = () => document.getElementById("api-config-profile") as HTMLElement & { value: string }

	/** Opens the list and clicks a profile in it. */
	function pick(name: string) {
		fireEvent.focus(field())
		fireEvent.click(screen.getByRole("option", { name }))
	}

	/**
	 * Types into the picker.
	 *
	 * Assigned rather than passed as `target`: the custom element is not
	 * upgraded under jsdom, so it has no `value` setter for fireEvent to find.
	 */
	function type(text: string) {
		fireEvent.focus(field())
		field().value = text
		fireEvent.input(field())
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
		expect(field().getAttribute("value") ?? field().value).toBe("local-qwen")
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

		// Same failure as "opens its list above the provider controls", one layer
		// further out. Every model picker in the settings view raises its list to
		// 1,000; the dialog was on Tailwind's z-50, so the Model ID list painted
		// straight over the top of it and the buttons underneath could not be
		// read, let alone clicked.
		it("puts the dialog above the model pickers, not under them", () => {
			profilesHook.isDirty = true
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

			pick("cloud-sonnet")

			const heading = screen.getByText("Unsaved changes")
			const overlay = heading.closest("[class*='fixed']") as HTMLElement
			expect(overlay).not.toBeNull()
			const zIndex = Number.parseInt(window.getComputedStyle(overlay).zIndex, 10)
			expect(Number.isNaN(zIndex)).toBe(false)
			expect(zIndex).toBeGreaterThan(DROPDOWN_Z_INDEX)
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

		it("goes back to showing the profile that is actually loaded", () => {
			// The old dropdown moved to the name that was clicked before anything
			// was loaded, and a cancelled switch left it naming a profile the panel
			// was not showing.
			profilesHook.isDirty = true
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			pick("cloud-sonnet")

			fireEvent.click(screen.getByText("Cancel"))

			expect(screen.queryByRole("listbox")).toBeNull()
			expect(field().getAttribute("value") ?? field().value).toBe("local-qwen")
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

	// One press next to "Save as…" used to take the profile with it.
	it("asks before deleting, and deletes only on confirm", () => {
		render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

		fireEvent.click(screen.getByText("Delete"))
		expect(profilesHook.deleteProfile).not.toHaveBeenCalled()
		expect(screen.getByText("Delete “local-qwen”?")).toBeInTheDocument()

		fireEvent.click(screen.getByText("Keep it"))
		expect(profilesHook.deleteProfile).not.toHaveBeenCalled()
		expect(screen.queryByText("Delete “local-qwen”?")).toBeNull()

		fireEvent.click(screen.getByText("Delete"))
		fireEvent.click(screen.getByText("Delete profile"))
		expect(profilesHook.deleteProfile).toHaveBeenCalledWith("local-qwen")
	})

	// The picker has no text to select, so Copy copied nothing; the name is
	// what a "Save as…" wants to start from.
	it("copies the selected profile's name", () => {
		render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
		const setData = vi.fn()
		const wrapper = document.getElementById("api-config-profile")?.parentElement as HTMLElement

		fireEvent.copy(wrapper, { clipboardData: { setData } })

		expect(setData).toHaveBeenCalledWith("text/plain", "local-qwen")
	})

	// The webview dispatches no copy event with nothing selected, so the key is
	// what has to be answered (pandorum, 2026-09-30: Ctrl+C copied nothing).
	it("copies the selected profile's name on Ctrl+C", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
		render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

		fireEvent.keyDown(document.getElementById("api-config-profile") as HTMLElement, { key: "c", ctrlKey: true })

		expect(writeText).toHaveBeenCalledWith("local-qwen")
	})

	// "Save as…" from a profile is most often a variant of it.
	it("offers the loaded profile's name to Save as, edited or not", () => {
		profilesHook.isDirty = true
		render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

		fireEvent.click(screen.getByText("Save as…"))

		expect(screen.getByPlaceholderText("Profile name")).toHaveValue("local-qwen")
	})

	it("offers a generated name when no profile is loaded", () => {
		profilesHook.activeName = ""
		render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)

		fireEvent.click(screen.getByText("Save as…"))

		expect(screen.getByPlaceholderText("Profile name")).toHaveValue("ollama · qwen3")
	})

	// pandorum, 2026-11-22: too many profiles to find one in the list.
	describe("filtering the list", () => {
		it("shows every profile until something is typed", () => {
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			fireEvent.focus(field())
			expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
				"local-qwen",
				"cloud-sonnet",
				"vision",
			])
		})

		it("keeps the profiles whose name has every word typed", () => {
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			type("SON cloud")
			expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["cloud-sonnet"])
			expect(screen.getByText("1 of 3 profiles")).toBeInTheDocument()
		})

		it("says so when nothing matches", () => {
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			type("gemini")
			expect(screen.queryAllByRole("option")).toHaveLength(0)
			expect(screen.getByText("No profile matches “gemini”.")).toBeInTheDocument()
		})

		it("loads the only match on Enter", () => {
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			type("vis")
			fireEvent.keyDown(field(), { key: "Enter" })
			expect(profilesHook.loadProfile).toHaveBeenCalledWith("vision")
		})

		it("moves through the list with the arrows", () => {
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			fireEvent.focus(field())
			fireEvent.keyDown(field(), { key: "ArrowDown" })
			fireEvent.keyDown(field(), { key: "ArrowDown" })
			fireEvent.keyDown(field(), { key: "Enter" })
			expect(profilesHook.loadProfile).toHaveBeenCalledWith("cloud-sonnet")
		})
	})

	// Renaming took "Save as…" under the new name and a Delete of the old one.
	describe("the right-click menu", () => {
		function rightClick(element: HTMLElement) {
			fireEvent.contextMenu(element, { clientX: 40, clientY: 60 })
		}

		it("opens on a profile in the list, for that profile", () => {
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			fireEvent.focus(field())
			rightClick(screen.getByRole("option", { name: "vision" }))

			const menu = screen.getByRole("menu")
			expect(menu.textContent).toContain("vision")
			expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Rename…", "Copy name", "Delete…"])
		})

		it("opens on the field for the loaded profile", () => {
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			rightClick(field())
			expect(screen.getByRole("menu").textContent).toContain("local-qwen")
		})

		it("renames from the menu", async () => {
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			fireEvent.focus(field())
			rightClick(screen.getByRole("option", { name: "vision" }))
			fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }))

			const input = screen.getByPlaceholderText("New profile name") as HTMLElement & { value: string }
			expect(input).toHaveValue("vision")
			input.value = "vision · qwen3-vl"
			fireEvent.input(input)
			fireEvent.click(screen.getByText("Rename"))

			await waitFor(() => expect(profilesHook.renameProfile).toHaveBeenCalledWith("vision", "vision · qwen3-vl"))
			await waitFor(() => expect(screen.queryByPlaceholderText("New profile name")).toBeNull())
		})

		it("will not rename onto another profile's name", () => {
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			rightClick(field())
			fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }))

			const input = screen.getByPlaceholderText("New profile name") as HTMLElement & { value: string }
			input.value = "Cloud-Sonnet"
			fireEvent.input(input)

			expect(screen.getByText("Another profile is already called “Cloud-Sonnet”.")).toBeInTheDocument()
			fireEvent.click(screen.getByText("Rename"))
			fireEvent.keyDown(input, { key: "Enter" })
			expect(profilesHook.renameProfile).not.toHaveBeenCalled()
		})

		it("names the agents whose files still use the old name", async () => {
			refreshAgents.mockResolvedValue({
				agents: [
					{ name: "reviewer", profile: "Local-Qwen" },
					{ name: "planner", profile: "cloud-sonnet" },
				],
			})
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			rightClick(field())
			fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }))

			expect(await screen.findByText(/The agent reviewer name it in its file/)).toBeInTheDocument()
		})

		it("asks before deleting from the menu", () => {
			render(<ApiConfigProfileBar scope={{ kind: "mode", mode: "act" }} />)
			fireEvent.focus(field())
			rightClick(screen.getByRole("option", { name: "cloud-sonnet" }))
			fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }))

			expect(screen.getByText("Delete “cloud-sonnet”?")).toBeInTheDocument()
			expect(profilesHook.deleteProfile).not.toHaveBeenCalled()
		})
	})
})
