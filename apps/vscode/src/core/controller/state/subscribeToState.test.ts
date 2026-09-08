import assert from "node:assert/strict"
import { EmptyRequest } from "@shared/proto/cline/common"
import type { State } from "@shared/proto/cline/state"
import { describe, it, vi } from "vitest"
import type { Controller } from ".."
import { sendStateUpdate, subscribeToState } from "./subscribeToState"

// Reaches for the host provider, which no unit test has.
vi.mock("@/services/telemetry", () => ({
	telemetryService: { captureGrpcResponseSize: vi.fn() },
}))

function makeController(getState: () => Promise<unknown>) {
	return { getStateToPostToWebview: vi.fn(getState) } as unknown as Controller
}

/**
 * The webview renders nothing until this stream delivers its first state, and
 * it has no timeout of its own — so a failure here is a permanently blank
 * panel. It has to be loud on the way out.
 */
describe("the state subscription's first push", () => {
	it("reports a state it could not build instead of going quiet", async () => {
		const controller = makeController(async () => {
			throw new Error("providers.json is not valid JSON")
		})
		const sent: State[] = []

		await assert.rejects(
			subscribeToState(controller, EmptyRequest.create({}), async (state) => {
				sent.push(state)
			}),
			/providers\.json is not valid JSON/,
		)
		assert.equal(sent.length, 0)
	})

	// Registered but never fed is the state that produced a blank panel: the
	// stream looks alive to everything on the host side and says nothing.
	it("leaves no subscription behind when the state could not be built", async () => {
		const controller = makeController(async () => {
			throw new Error("nope")
		})
		const responseStream = vi.fn(async () => undefined)

		await subscribeToState(controller, EmptyRequest.create({}), responseStream).catch(() => undefined)
		await sendStateUpdate({ version: "1" } as never)

		assert.equal(responseStream.mock.calls.length, 0)
	})

	it("sends the state when it can be built", async () => {
		const controller = makeController(async () => ({ version: "1" }))
		const sent: State[] = []

		await subscribeToState(controller, EmptyRequest.create({}), async (state) => {
			sent.push(state)
		})

		assert.equal(sent.length, 1)
		assert.match(sent[0].stateJson ?? "", /"version":"1"/)
	})
})
