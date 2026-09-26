import assert from "node:assert/strict"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { describe, it, vi } from "vitest"
import type { Controller } from ".."
import { updateSettings } from "./updateSettings"

function makeController() {
	const controller = {
		task: undefined,
		postStateToWebview: vi.fn(async () => undefined),
		stateManager: {
			getGlobalSettingsKey: vi.fn(() => undefined),
			setGlobalState: vi.fn(),
		},
	}
	return controller as unknown as Controller & {
		stateManager: { setGlobalState: ReturnType<typeof vi.fn> }
	}
}

function written(controller: ReturnType<typeof makeController>) {
	const calls = controller.stateManager.setGlobalState.mock.calls as Array<[string, unknown]>
	return calls.filter(([key]) => key === "teammatesEnabled").at(-1)?.[1]
}

// The Teammates switch posts `teammatesEnabled`. A field the handler does not
// read would leave the switch flipping in the panel and the stored value --
// the one the session factory reads -- untouched.
describe("updateSettings — teammatesEnabled", () => {
	it("stores both values the switch sends", async () => {
		for (const value of [true, false]) {
			const controller = makeController()

			await updateSettings(controller, UpdateSettingsRequest.create({ teammatesEnabled: value }))

			assert.equal(written(controller), value)
		}
	})

	it("leaves the stored value alone when the field is absent", async () => {
		const controller = makeController()

		await updateSettings(controller, UpdateSettingsRequest.create({ subagentCommandsEnabled: true }))

		assert.equal(written(controller), undefined)
	})
})
