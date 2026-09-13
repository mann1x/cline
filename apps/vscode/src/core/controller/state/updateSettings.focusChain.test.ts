import assert from "node:assert/strict"
import { DEFAULT_FOCUS_CHAIN_SETTINGS } from "@shared/FocusChainSettings"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { describe, it, vi } from "vitest"
import type { Controller } from ".."
import { updateSettings } from "./updateSettings"

function makeController(current = DEFAULT_FOCUS_CHAIN_SETTINGS) {
	const controller = {
		task: undefined,
		postStateToWebview: vi.fn(async () => undefined),
		stateManager: {
			getGlobalSettingsKey: vi.fn(() => current),
			setGlobalState: vi.fn(),
		},
	}
	return controller as unknown as Controller & {
		stateManager: { setGlobalState: ReturnType<typeof vi.fn> }
	}
}

describe("updateSettings — focusChainSettings", () => {
	it("persists the toggle", async () => {
		const controller = makeController({ enabled: true, remindClineInterval: 6 })

		await updateSettings(
			controller,
			UpdateSettingsRequest.create({ focusChainSettings: { enabled: false, remindClineInterval: 6 } }),
		)

		assert.deepEqual(controller.stateManager.setGlobalState.mock.calls.at(-1), [
			"focusChainSettings",
			{ enabled: false, remindClineInterval: 6 },
		])
	})

	it("keeps the stored reminder interval when the request omits it", async () => {
		// proto3 gives an absent number the same wire form as zero, so a request
		// carrying only the toggle arrives with `remindClineInterval: 0`.
		// Assigning that would mean "remind on every single message".
		const controller = makeController({ enabled: false, remindClineInterval: 11 })

		await updateSettings(controller, UpdateSettingsRequest.create({ focusChainSettings: { enabled: true } }))

		assert.deepEqual(controller.stateManager.setGlobalState.mock.calls.at(-1), [
			"focusChainSettings",
			{ enabled: true, remindClineInterval: 11 },
		])
	})

	it("leaves the setting alone when the request does not mention it", async () => {
		const controller = makeController()

		await updateSettings(controller, UpdateSettingsRequest.create({}))

		const touched = controller.stateManager.setGlobalState.mock.calls.some(([key]) => key === "focusChainSettings")
		assert.equal(touched, false)
	})
})
