import assert from "node:assert/strict"
import { DEFAULT_ATOMIC_PROTOCOL_SETTINGS } from "@shared/AtomicProtocolSettings"
import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { describe, it, vi } from "vitest"
import type { Controller } from ".."
import { updateSettings } from "./updateSettings"

function makeController(current = DEFAULT_ATOMIC_PROTOCOL_SETTINGS) {
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

const stored = {
	...DEFAULT_ATOMIC_PROTOCOL_SETTINGS,
	mode: "always" as const,
	oracleCommand: "node run_game.js index.html",
	oracleExpect: '"ok":\\s*true',
}

function lastWrite(controller: ReturnType<typeof makeController>) {
	const calls = controller.stateManager.setGlobalState.mock.calls as Array<[string, unknown]>
	const call = calls.filter(([key]) => key === "atomicProtocolSettings").at(-1)
	return call?.[1] as typeof stored | undefined
}

describe("updateSettings — atomicProtocolSettings", () => {
	// The settings view posts one field per keystroke. Before the two oracle
	// fields were made `optional` in the proto, the untouched one arrived as ""
	// rather than absent, the merge read that as "the user cleared it", and the
	// state that came back blanked the other box while you were still typing.
	it("keeps the stored expect pattern while the command is being typed", async () => {
		const controller = makeController(stored)

		await updateSettings(
			controller,
			UpdateSettingsRequest.create({ atomicProtocolSettings: { oracleCommand: "node run_game.js man" } }),
		)

		const written = lastWrite(controller)
		assert.equal(written?.oracleCommand, "node run_game.js man")
		assert.equal(written?.oracleExpect, '"ok":\\s*true')
	})

	it("keeps the stored command while the expect pattern is being typed", async () => {
		const controller = makeController(stored)

		await updateSettings(controller, UpdateSettingsRequest.create({ atomicProtocolSettings: { oracleExpect: '"ok' } }))

		const written = lastWrite(controller)
		assert.equal(written?.oracleExpect, '"ok')
		assert.equal(written?.oracleCommand, "node run_game.js index.html")
	})

	// Empty is a real value for both -- it hands the choice of check back to the
	// workspace -- so an explicitly emptied box must still clear the stored one.
	it("clears a field the user actually emptied", async () => {
		const controller = makeController(stored)

		await updateSettings(controller, UpdateSettingsRequest.create({ atomicProtocolSettings: { oracleCommand: "" } }))

		const written = lastWrite(controller)
		assert.equal(written?.oracleCommand, "")
		assert.equal(written?.oracleExpect, '"ok":\\s*true')
	})

	it("leaves both alone when the request only changes the mode", async () => {
		const controller = makeController(stored)

		await updateSettings(controller, UpdateSettingsRequest.create({ atomicProtocolSettings: { mode: "auto" } }))

		const written = lastWrite(controller)
		assert.equal(written?.mode, "auto")
		assert.equal(written?.oracleCommand, "node run_game.js index.html")
		assert.equal(written?.oracleExpect, '"ok":\\s*true')
	})
})
