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
	return calls.filter(([key]) => key === "updateChannel").at(-1)?.[1]
}

describe("updateSettings — updateChannel", () => {
	it("stores each of the three values the dropdown offers", async () => {
		for (const channel of ["off", "notify", "auto"]) {
			const controller = makeController()

			await updateSettings(controller, UpdateSettingsRequest.create({ updateChannel: channel }))

			assert.equal(written(controller), channel)
		}
	})

	it("stores the default rather than an unknown value", async () => {
		// It arrives as a proto string, so nothing upstream constrains it. A
		// value stored verbatim would read as neither "off" nor "auto" nor
		// "notify" and silently disable the check, which looks exactly like a
		// feature that was never built.
		const controller = makeController()

		await updateSettings(controller, UpdateSettingsRequest.create({ updateChannel: "weekly" }))

		assert.equal(written(controller), "notify")
	})

	it("leaves the stored value alone when the field is absent", async () => {
		// The settings view posts one field at a time; every other post must
		// not touch this one.
		const controller = makeController()

		await updateSettings(controller, UpdateSettingsRequest.create({ showRequestTimings: true }))

		assert.equal(written(controller), undefined)
	})
})
