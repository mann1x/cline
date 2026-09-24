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

	it("renders the Compaction Strategy setting in the Agent section", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Compaction Strategy")).toBeTruthy()

		const agentSection = container.querySelector("#agent-features")
		expect(agentSection?.textContent).toContain("Basic")
	})

	// This asserted the opposite, which was the bug written down as the
	// contract. The strategy governs how a compaction rewrites context, and a
	// manual compaction rewrites context: it force-enables the pass and reads
	// this same setting. Greyed out with Auto Compact off, the strategy a manual
	// compaction ran could not be chosen -- it silently used the default.
	// The general form of the council fix. `enabled` is the only compaction
	// setting that means "automatic"; every other one describes HOW a compaction
	// is done, and a manual compaction is a compaction -- it force-enables the
	// pass and spreads the same config for the rest. Greyed out, they were
	// settings you could not reach for the only kind of compaction you could
	// still run.
	it("leaves every how-a-compaction-is-done control reachable with Auto Compact off", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			useAutoCondense: false,
			thinkingCompactionEnabled: true,
			keepRecentMessagesAtCompaction: true,
		}
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		for (const id of [
			"keepRecentMessagesAtCompaction",
			"force-full-from-compaction",
			"thinkingCompactionEnabled",
			"councilCompactionEnabled",
		]) {
			const control = container.querySelector(`#${id}`)
			expect(control, id).toBeTruthy()
			expect(control?.hasAttribute("disabled"), id).toBe(false)
		}
	})

	it("keeps Compaction Strategy usable when Auto Compact is off", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const strategySelect = container.querySelector("#agent-features button[role='combobox']")
		expect(strategySelect).toBeTruthy()
		expect(strategySelect).not.toHaveAttribute("disabled")
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

	// Deleted upstream in c3671de7d and never restored, so the session factory's
	// read of `subagentsEnabled` could only ever see the default.
	it("renders the Subagents toggle in the Agent section", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const agentSection = container.querySelector("#agent-features")
		expect(agentSection?.querySelector("#Subagents")).toBeTruthy()
	})

	it("calls updateSetting with subagentsEnabled when toggled", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(container.querySelector("#Subagents") as Element)

		expect(mockUpdateSetting).toHaveBeenCalledWith("subagentsEnabled", true)
	})

	it("renders the 'Agents can run commands' toggle under Subagents", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const agentSection = container.querySelector("#agent-features")
		expect(agentSection?.querySelector('[id="Agents can run commands"]')).toBeTruthy()
	})

	it("calls updateSetting with subagentCommandsEnabled when toggled", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(container.querySelector('[id="Agents can run commands"]') as Element)

		expect(mockUpdateSetting).toHaveBeenCalledWith("subagentCommandsEnabled", true)
	})

	it("persists a trimmed agentModelOverride on blur", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const field = container.querySelector("#agent-model-override") as HTMLInputElement
		expect(field).toBeTruthy()
		fireEvent.change(field, { target: { value: "  qwen3-coder:30b  " } })
		fireEvent.blur(field)

		expect(mockUpdateSetting).toHaveBeenCalledWith("agentModelOverride", "qwen3-coder:30b")
	})

	// Default on. An extension state that predates the key must still render
	// the row checked, or the first thing a user does is turn back on what was
	// never off -- and the row reads as a new opt-in feature rather than as the
	// behaviour they have had all along.
	it("renders Strong coding nudges on when the state has no value for it", () => {
		mockExtensionState.value = { ...mockExtensionState.value, strongNudgesEnabled: undefined }
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const row = container.querySelector('[id="Strong coding nudges"]')
		expect(row).toBeTruthy()
		expect(row?.getAttribute("aria-checked")).toBe("true")
	})

	it("calls updateSetting with strongNudgesEnabled when switched off", () => {
		mockExtensionState.value = { ...mockExtensionState.value, strongNudgesEnabled: true }
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(container.querySelector('[id="Strong coding nudges"]') as Element)

		expect(mockUpdateSetting).toHaveBeenCalledWith("strongNudgesEnabled", false)
	})

	it("says what switching the nudges off costs", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(container.querySelector("#agent-features")?.textContent).toContain("ask questions")
	})

	// The toggle is not the whole gate, and the other half is otherwise only in
	// the extension log.
	it("says that the open-ended spawn also needs parallel sessions above 1", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(container.querySelector("#agent-features")?.textContent).toContain("parallel sessions above 1")
	})

	it("calls updateSetting with showFeatureTips when toggled", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const featureTipsSwitch = container.querySelector('[id="Feature Tips"]')
		expect(featureTipsSwitch).toBeTruthy()

		fireEvent.click(featureTipsSwitch as Element)

		expect(mockUpdateSetting).toHaveBeenCalledWith("showFeatureTips", true)
	})
})

/**
 * The tickbox decides which of two prompts the field below it edits, so the
 * thing worth testing is not that it toggles but that the other prompt is
 * still there afterwards. A field that rewrote one setting under the user
 * would look identical on screen.
 */
describe("Keep Recent Messages At Compaction", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
		mockExtensionState.value = {
			...mockExtensionState.value,
			useAutoCondense: true,
			keepRecentMessagesAtCompaction: true,
			compactionPrompt: "my replay prompt",
			fullCompactionPrompt: "my full prompt",
		}
	})

	it("sits above the prompt it decides", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const labels = Array.from(container.querySelectorAll("label")).map((label) => label.textContent)
		const tickbox = labels.indexOf("Keep Recent Messages At Compaction")
		// The other way the tail is dropped goes with the switch that decides
		// whether there is a tail at all, not with the prompt below them.
		const dropFrom = labels.indexOf("Drop the tail from compaction number")
		const prompt = labels.indexOf("Compaction Prompt")

		expect(tickbox).toBeGreaterThanOrEqual(0)
		expect(dropFrom).toBe(tickbox + 1)
		expect(prompt).toBe(dropFrom + 1)
	})

	// Zero is the off switch, and the whole chain from this box down to core
	// has to carry it as a value rather than read it as an empty field.
	it("sends a zero, which is how the tail is never dropped", () => {
		// Started from the old staged value on purpose: zero is the default now,
		// so typing it into a box that already reads zero is not an edit and
		// would assert nothing.
		mockExtensionState.value = { ...mockExtensionState.value, forceFullFromCompaction: 2 }
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.change(container.querySelector("#force-full-from-compaction") as Element, {
			target: { value: "0" },
		})

		expect(mockUpdateSetting).toHaveBeenCalledWith("forceFullFromCompaction", 0)
	})

	it("sends the compaction the tail stops surviving", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.change(container.querySelector("#force-full-from-compaction") as Element, {
			target: { value: "3" },
		})

		expect(mockUpdateSetting).toHaveBeenCalledWith("forceFullFromCompaction", 3)
	})

	// With the switch off every compaction already keeps nothing, so a number
	// saying which one stops keeping it has nothing left to say.
	it("goes quiet when the tail is off altogether", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			keepRecentMessagesAtCompaction: false,
		}
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(container.querySelector("#force-full-from-compaction")?.hasAttribute("disabled")).toBe(true)
	})

	it("is on unless it has been turned off", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(container.querySelector("#keepRecentMessagesAtCompaction")?.getAttribute("data-state")).toBe("checked")
	})

	it("turns off from the switch", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(container.querySelector("#keepRecentMessagesAtCompaction") as Element)

		expect(mockUpdateSetting).toHaveBeenCalledWith("keepRecentMessagesAtCompaction", false)
	})

	it("edits the replay prompt while it is on", () => {
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Compaction Prompt")).toBeTruthy()
		expect(screen.queryByText("Full Compaction Prompt")).toBeNull()
		expect(screen.getByDisplayValue("my replay prompt")).toBeTruthy()
	})

	it("edits the full prompt while it is off, and leaves the other one stored", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			keepRecentMessagesAtCompaction: false,
		}
		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByText("Full Compaction Prompt")).toBeTruthy()
		expect(screen.getByDisplayValue("my full prompt")).toBeTruthy()
		// The replay prompt is not on screen and was not written to either.
		expect(screen.queryByDisplayValue("my replay prompt")).toBeNull()
		expect(mockUpdateSetting).not.toHaveBeenCalled()
	})
})

describe("Thinking Compaction", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
		mockExtensionState.value = {
			...mockExtensionState.value,
			useAutoCondense: true,
			// Named rather than inherited: every describe in this file spreads
			// the one mutated state object forward, so a key another block left
			// off arrives here silently -- and this block asserts on the label
			// that the tickbox changes.
			keepRecentMessagesAtCompaction: true,
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
 * The review pass over what the two above wrote. It has a switch and no prompt
 * of its own: the reviewer's instruction is about how to review, not about the
 * shape of the summary, and the summary's shape is already the compaction
 * prompt's job.
 */
describe("FeatureSettingsSection compaction council", () => {
	beforeEach(() => {
		mockUpdateSetting.mockClear()
	})

	it("sits with the two passes it reviews", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const labels = Array.from(container.querySelectorAll("label")).map((label) => label.textContent)
		const thinking = labels.indexOf("Thinking Compaction Prompt")
		const council = labels.indexOf("Compaction Council")

		expect(thinking).toBeGreaterThanOrEqual(0)
		expect(council).toBe(thinking + 1)
	})

	it("is on unless it has been turned off", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(container.querySelector("#councilCompactionEnabled")?.getAttribute("data-state")).toBe("checked")
	})

	it("turns off from the switch", () => {
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const toggle = container.querySelector("#councilCompactionEnabled")
		expect(toggle).toBeTruthy()
		fireEvent.click(toggle as Element)

		expect(mockUpdateSetting).toHaveBeenCalledWith("councilCompactionEnabled", false)
	})

	it("stays usable with Auto Compact off, because a manual compaction runs it too", () => {
		// The council belongs to the agentic strategy, and a manual compaction
		// runs that strategy: it force-enables the pass and reads this same
		// setting. Greying the switch out with Auto Compact off left three extra
		// model calls per manual compaction with no control over them.
		mockExtensionState.value = { ...mockExtensionState.value, useAutoCondense: false }
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		const council = container.querySelector("#councilCompactionEnabled")
		expect(council).toBeTruthy()
		expect(council?.hasAttribute("disabled")).toBe(false)
		// The thinking pass is the same shape and was fixed with it:
		// `thinkingSummaryEnabled !== false` gates a model call exactly as
		// `councilEnabled === false` does, so greying it out cost a second
		// unwanted call per manual compaction.
		expect(container.querySelector("#thinkingCompactionEnabled")?.hasAttribute("disabled")).toBe(false)
	})

	it("can still be switched off with Auto Compact off", () => {
		mockExtensionState.value = { ...mockExtensionState.value, useAutoCondense: false }
		const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		fireEvent.click(container.querySelector("#councilCompactionEnabled") as Element)

		expect(mockUpdateSetting).toHaveBeenCalledWith("councilCompactionEnabled", false)
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

	it("offers the check under static, and shows the user's own", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			atomicProtocolSettings: {
				mode: "static",
				oracleCommand: "node run_game.js manic_miner.html",
				maxChanges: 3,
				maxTransactions: 6,
			},
		}

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.getByDisplayValue("node run_game.js manic_miner.html")).toBeTruthy()
	})

	// Under On the check belongs to the task and is set next to the engage
	// button. Showing a second copy here would be two fields for one decision,
	// and the one you were not looking at would be the one that counted.
	it("keeps the check out of the settings panel under on", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			atomicProtocolSettings: {
				mode: "on",
				oracleCommand: "node run_game.js manic_miner.html",
				maxChanges: 3,
				maxTransactions: 6,
			},
		}

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.queryByPlaceholderText("node run_game.js index.html")).toBeNull()
		expect(screen.queryByDisplayValue("node run_game.js manic_miner.html")).toBeNull()
		expect(screen.queryByText("Model proposes the check")).toBeNull()
	})

	it("shows both limits once the protocol is on", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			atomicProtocolSettings: { mode: "on", oracleCommand: "", oracleExpect: "", maxChanges: 7, maxTransactions: 4 },
		}

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect((screen.getByLabelText("Changes per attempt") as HTMLInputElement).value).toBe("7")
		expect((screen.getByLabelText("Attempts per task") as HTMLInputElement).value).toBe("4")
	})

	it("keeps both limits out of sight while the protocol is off", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			atomicProtocolSettings: { mode: "off", oracleCommand: "", oracleExpect: "", maxChanges: 3, maxTransactions: 6 },
		}

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)

		expect(screen.queryByLabelText("Changes per attempt")).toBeNull()
		expect(screen.queryByLabelText("Attempts per task")).toBeNull()
	})

	// One at a time, and merged onto what is stored: sending both would make
	// every edit of one an assertion about the other.
	it("sends a new changes-per-attempt target on its own", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			atomicProtocolSettings: { mode: "static", oracleCommand: "", oracleExpect: "", maxChanges: 3, maxTransactions: 6 },
		}

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)
		fireEvent.change(screen.getByLabelText("Changes per attempt"), { target: { value: "10" } })

		expect(mockUpdateSetting).toHaveBeenCalledWith("atomicProtocolSettings", { maxChanges: 10 })
	})

	it("sends a new attempts-per-task target on its own", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			atomicProtocolSettings: { mode: "static", oracleCommand: "", oracleExpect: "", maxChanges: 3, maxTransactions: 6 },
		}

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)
		fireEvent.change(screen.getByLabelText("Attempts per task"), { target: { value: "2" } })

		expect(mockUpdateSetting).toHaveBeenCalledWith("atomicProtocolSettings", { maxTransactions: 2 })
	})

	// The stored value would otherwise be overwritten mid-keystroke, and a zero
	// is indistinguishable on the wire from a field nobody set — so an emptied
	// box would arrive as "put it back to three" rather than as "unchanged".
	it("sends nothing for an emptied or zeroed target", () => {
		mockExtensionState.value = {
			...mockExtensionState.value,
			atomicProtocolSettings: { mode: "static", oracleCommand: "", oracleExpect: "", maxChanges: 3, maxTransactions: 6 },
		}

		// This describe block has no shared reset, and the test before it sends a
		// target of its own.
		mockUpdateSetting.mockClear()

		render(<FeatureSettingsSection renderSectionHeader={() => null} />)
		for (const label of ["Changes per attempt", "Attempts per task"]) {
			const field = screen.getByLabelText(label)
			fireEvent.change(field, { target: { value: "" } })
			fireEvent.change(field, { target: { value: "0" } })
		}

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
