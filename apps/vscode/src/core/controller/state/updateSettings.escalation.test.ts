import assert from "node:assert/strict"
import { DEFAULT_ESCALATION_SETTINGS, type EscalationSettings } from "@shared/EscalationSettings"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { describe, it, vi } from "vitest"
import type { Controller } from ".."
import { updateSettings } from "./updateSettings"

function makeController(current: EscalationSettings) {
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

const stored: EscalationSettings = {
	requireApproval: true,
	closeAfterEscalation: true,
	maxEscalations: 5,
	maxFollowUps: 8,
}

function lastWrite(controller: ReturnType<typeof makeController>) {
	const calls = controller.stateManager.setGlobalState.mock.calls as Array<[string, unknown]>
	return calls.filter(([key]) => key === "escalationSettings").at(-1)?.[1] as EscalationSettings | undefined
}

describe("updateSettings — escalationSettings", () => {
	// The settings view posts one field at a time. proto3 gives an absent
	// number the same wire form as zero, so an assignment here would zero every
	// budget the user was not editing.
	it("keeps the stored budgets while one checkbox is being ticked", async () => {
		const controller = makeController(stored)

		await updateSettings(controller, UpdateSettingsRequest.create({ escalationSettings: { requireApproval: false } }))

		const written = lastWrite(controller)
		assert.equal(written?.requireApproval, false)
		assert.equal(written?.maxEscalations, 5)
		assert.equal(written?.maxFollowUps, 8)
		assert.equal(written?.closeAfterEscalation, true)
	})

	it("keeps the stored switches while a budget is being typed", async () => {
		const controller = makeController(stored)

		await updateSettings(controller, UpdateSettingsRequest.create({ escalationSettings: { maxFollowUps: 12 } }))

		const written = lastWrite(controller)
		assert.equal(written?.maxFollowUps, 12)
		assert.equal(written?.maxEscalations, 5)
		assert.equal(written?.requireApproval, true)
	})

	// Off is a value a user chooses, and it has to survive the round trip: a
	// merge that treated `false` as "not sent" could never turn either of these
	// back off once they were on.
	it("stores a switch turned off", async () => {
		const controller = makeController(stored)

		await updateSettings(controller, UpdateSettingsRequest.create({ escalationSettings: { closeAfterEscalation: false } }))

		assert.equal(lastWrite(controller)?.closeAfterEscalation, false)
	})

	it("ignores a budget of zero rather than storing one", async () => {
		const controller = makeController(DEFAULT_ESCALATION_SETTINGS)

		await updateSettings(controller, UpdateSettingsRequest.create({ escalationSettings: { maxEscalations: 0 } }))

		assert.equal(lastWrite(controller)?.maxEscalations, DEFAULT_ESCALATION_SETTINGS.maxEscalations)
	})
})
