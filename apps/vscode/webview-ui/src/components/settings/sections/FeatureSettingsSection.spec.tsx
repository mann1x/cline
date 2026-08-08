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
