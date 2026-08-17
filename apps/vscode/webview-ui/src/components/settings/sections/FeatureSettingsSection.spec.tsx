import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import FeatureSettingsSection from "./FeatureSettingsSection"

const mockUpdateSetting = vi.fn()
const mockExtensionState = vi.hoisted(() => ({
	value: {
		enableCheckpointsSetting: true,
		hooksEnabled: false,
		showFeatureTips: false,
		mcpDisplayMode: "rich",
		yoloModeToggled: false,
		useAutoCondense: false,
		compactionStrategy: "basic",
		subagentsEnabled: false,
		worktreesEnabled: { user: true, featureFlag: true },
		focusChainSettings: { enabled: false, remindClineInterval: 6 },
		remoteConfigSettings: {},
		backgroundEditEnabled: false,
		editVerificationSettings: { mode: "nudge" },
		atomicProtocolSettings: { mode: "off", oracleCommand: "", oracleExpect: "", maxChanges: 3, maxTransactions: 6 },
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => mockExtensionState.value),
}))

vi.mock("../utils/settingsHandlers", () => ({
	updateSetting: (...args: unknown[]) => mockUpdateSetting(...args),
}))

describe("FeatureSettingsSection", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
		mockExtensionState.value = {
			...mockExtensionState.value,
			useAutoCondense: false,
			compactionStrategy: "basic",
			focusChainSettings: { enabled: false, remindClineInterval: 6 },
		}
	})

	it("renders Hooks feature toggle", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Hooks")).toBeTruthy()

		const advancedSection = container.querySelector("#advanced-features")
		const agentSection = container.querySelector("#agent-features")

		expect(advancedSection?.querySelector("#Hooks")).toBeTruthy()
		expect(agentSection?.querySelector("#Hooks")).toBeNull()
	})

	it("renders Feature Tips toggle in the Editor section", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Feature Tips")).toBeTruthy()

		const editorSection = container.querySelector("#optional-features")
		const agentSection = container.querySelector("#agent-features")

		expect(editorSection?.querySelector('[id="Feature Tips"]')).toBeTruthy()
		expect(agentSection?.querySelector('[id="Feature Tips"]')).toBeNull()
	})

	it("renders the Auto Compact Strategy setting in the Agent section", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Auto Compact Strategy")).toBeTruthy()

		const agentSection = container.querySelector("#agent-features")
		expect(agentSection?.textContent).toContain("Basic")
	})

	it("disables Auto Compact Strategy when Auto Compact is off", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const strategySelect = container.querySelector("#agent-features button[role='combobox']")
		expect(strategySelect).toHaveAttribute("disabled")
	})

	it("calls updateSetting with hooksEnabled when toggled", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const hooksSwitch = container.querySelector("#Hooks")
		expect(hooksSwitch).toBeTruthy()

		fireEvent.click(hooksSwitch as Element)

		expect(mockUpdateSetting).toHaveBeenCalledWith("hooksEnabled", true)
	})

	it("renders the Task Checklist toggle in the Agent section", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const agentSection = container.querySelector("#agent-features")
		expect(agentSection?.querySelector('[id="Task Checklist"]')).toBeTruthy()
	})

	it("keeps the reminder interval when the Task Checklist is toggled", () => {
		// The setting is an object, so the toggle has to send the whole thing.
		// A tuned interval must survive that round trip rather than snapping
		// back to the default.
		mockExtensionState.value = {
			...mockExtensionState.value,
			focusChainSettings: { enabled: false, remindClineInterval: 11 },
		}
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(container.querySelector('[id="Task Checklist"]') as Element)

		expect(mockUpdateSetting).toHaveBeenCalledWith("focusChainSettings", { enabled: true, remindClineInterval: 11 })
	})

	it("calls updateSetting with showFeatureTips when toggled", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const featureTipsSwitch = container.querySelector('[id="Feature Tips"]')
		expect(featureTipsSwitch).toBeTruthy()

		fireEvent.click(featureTipsSwitch as Element)

		expect(mockUpdateSetting).toHaveBeenCalledWith("showFeatureTips", true)
	})
})

describe("Thinking Compaction", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
		mockExtensionState.value = {
			...mockExtensionState.value,
			useAutoCondense: true,
		}
	})

	it("sits below the Compaction Prompt, because it is the other half of it", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const labels = Array.from(container.querySelectorAll("label")).map((label) => label.textContent)
		const compaction = labels.indexOf("Compaction Prompt")
		const thinking = labels.indexOf("Thinking Compaction Prompt")

		expect(compaction).toBeGreaterThanOrEqual(0)
		expect(thinking).toBe(compaction + 1)
	})

	it("is on unless it has been turned off", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(container.querySelector("#thinkingCompactionEnabled")?.getAttribute("data-state")).toBe("checked")
	})

	it("turns off from the switch", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const toggle = container.querySelector("#thinkingCompactionEnabled")
		expect(toggle).toBeTruthy()
		fireEvent.click(toggle as Element)

		expect(mockUpdateSetting).toHaveBeenCalledWith("thinkingCompactionEnabled", false)
	})
})

/**
 * The third thing that rewrites reasoning. It had a prompt and a switch in the
 * session config from the day it shipped and nothing that wrote either, so the
 * built-in note was the only note it could ever produce and there was no way to
 * turn it off.
 */
describe("FeatureSettingsSection — capped thinking", () => {
	it("offers the prompt and the switch", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const labels = Array.from(container.querySelectorAll("label")).map((label) => label.textContent)
		expect(labels).toContain("Capped Thinking Prompt")
		expect(container.querySelector("#cappedThinkingEnabled")?.getAttribute("data-state")).toBe("checked")
	})

	it("turns off from the switch", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(container.querySelector("#cappedThinkingEnabled") as Element)

		expect(mockUpdateSetting).toHaveBeenCalledWith("cappedThinkingEnabled", false)
	})
})

/**
 * The guard that stops a run finishing with a file it changed and never
 * checked. It shipped built, wired and defaulting to "nudge", with nothing
 * anywhere that could change it — the mode was in storage and in the generated
 * Settings proto, and no request field, no handler and no control ever reached
 * it. So it could only ever be the value it was born with.
 */
describe("FeatureSettingsSection — check edited files", () => {
	it("shows the mode the guard is running on", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const labels = Array.from(container.querySelectorAll("label")).map((label) => label.textContent)
		expect(labels).toContain("Check Edited Files")
		expect(screen.getByText("Nudge")).toBeTruthy()
	})

	it("falls back to nudge rather than showing an empty control", () => {
		mockExtensionState.value = { ...mockExtensionState.value, editVerificationSettings: undefined }

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Nudge")).toBeTruthy()
	})
})

/**
 * The control that decides whether a failed attempt leaves its changes on disk.
 *
 * The command field is hidden while the protocol is off rather than disabled:
 * an oracle typed against a protocol that is not running is a setting the user
 * has every reason to believe is in force.
 */
describe("FeatureSettingsSection — change protocol", () => {
	it("shows the mode the protocol is running on", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const labels = Array.from(container.querySelectorAll("label")).map((label) => label.textContent)
		expect(labels).toContain("Change Protocol")
	})

	it("keeps the check out of sight while the protocol is off", () => {
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.queryByPlaceholderText("node run_game.js index.html")).toBeNull()
	})

	it("offers the check once the protocol is on, and shows the user's own", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			atomicProtocolSettings: {
				mode: "auto",
				oracleCommand: "node run_game.js manic_miner.html",
				maxChanges: 3,
				maxTransactions: 6,
			},
		}

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByDisplayValue("node run_game.js manic_miner.html")).toBeTruthy()
	})

	it("shows the changes-per-attempt target once the protocol is on", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			atomicProtocolSettings: { mode: "auto", oracleCommand: "", oracleExpect: "", maxChanges: 7, maxTransactions: 6 },
		}

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect((screen.getByLabelText("Changes per attempt") as HTMLInputElement).value).toBe("7")
	})

	it("keeps the changes-per-attempt target out of sight while the protocol is off", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			atomicProtocolSettings: { mode: "off", oracleCommand: "", oracleExpect: "", maxChanges: 3, maxTransactions: 6 },
		}

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.queryByLabelText("Changes per attempt")).toBeNull()
	})

	it("sends a new changes-per-attempt target", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			atomicProtocolSettings: { mode: "auto", oracleCommand: "", oracleExpect: "", maxChanges: 3, maxTransactions: 6 },
		}

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)
		fireEvent.change(screen.getByLabelText("Changes per attempt"), { target: { value: "10" } })

		expect(mockUpdateSetting).toHaveBeenCalledWith("atomicProtocolSettings", { maxChanges: 10 })
	})

	// The stored value would otherwise be overwritten mid-keystroke, and a zero
	// is indistinguishable on the wire from a field nobody set — so an emptied
	// box would arrive as "put it back to three" rather than as "unchanged".
	it("sends nothing for an emptied or zeroed target", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			atomicProtocolSettings: { mode: "auto", oracleCommand: "", oracleExpect: "", maxChanges: 3, maxTransactions: 6 },
		}

		// This describe block has no shared reset, and the test before it sends a
		// target of its own.
		mockUpdateSetting.mockClear()

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)
		const field = screen.getByLabelText("Changes per attempt")
		fireEvent.change(field, { target: { value: "" } })
		fireEvent.change(field, { target: { value: "0" } })

		expect(mockUpdateSetting).not.toHaveBeenCalled()
	})

	// proto3 gives an absent number the same wire form as zero, so the mode is
	// sent on its own and the limits are merged onto what is stored.
	it("sends only the mode when the mode is what changed", () => {
		mockExtensionState.value = { ...mockExtensionState.value, atomicProtocolSettings: undefined }

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getAllByText("Off").length).toBeGreaterThan(0)
	})
})
