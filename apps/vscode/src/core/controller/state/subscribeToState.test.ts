import assert from "node:assert/strict"
import { EmptyRequest } from "@shared/proto/cline/common"
import type { State } from "@shared/proto/cline/state"
import { afterEach, describe, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."
import { acknowledgeStateUpdate, resetStateUpdateGateForTests, sendStateUpdate, subscribeToState } from "./subscribeToState"

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

/**
 * A snapshot is the whole transcript. Posting the next one before the webview
 * has applied the last queues it in the webview's memory, and on a long
 * conversation that queue is what killed the panel.
 */
describe("state snapshots wait for the webview", () => {
	afterEach(() => {
		resetStateUpdateGateForTests()
		vi.useRealTimers()
	})

	async function subscribe() {
		const sent: string[] = []
		const stream = vi.fn(async (state: State) => {
			sent.push(JSON.parse(state.stateJson ?? "{}").version)
		})
		await subscribeToState(
			makeController(async () => ({ version: "first" })),
			EmptyRequest.create({}),
			stream,
		)
		return sent
	}
	const state = (version: string) => ({ version }) as never

	it("posts every snapshot to a client that never acknowledges", async () => {
		const sent = await subscribe()
		await sendStateUpdate(state("a"))
		await sendStateUpdate(state("b"))
		assert.deepEqual(sent, ["first", "a", "b"])
	})

	it("holds the newest snapshot until the last one is acknowledged, and drops the ones between", async () => {
		const sent = await subscribe()
		acknowledgeStateUpdate()
		await sendStateUpdate(state("a"))
		await sendStateUpdate(state("b"))
		await sendStateUpdate(state("c"))
		assert.deepEqual(sent, ["first", "a"])
		acknowledgeStateUpdate()
		await Promise.resolve()
		assert.deepEqual(sent, ["first", "a", "c"])
	})

	it("writes one line when a webview that used to acknowledge has been silent for thirty seconds, and one when it answers", async () => {
		vi.useFakeTimers()
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {})
		try {
			await subscribe()
			acknowledgeStateUpdate()
			// A session posting state once a second to a panel that is gone.
			for (let second = 0; second < 40; second++) {
				await sendStateUpdate(state(`s${second}`))
				await vi.advanceTimersByTimeAsync(1000)
			}
			const silent = warn.mock.calls.filter((call) => String(call[0]).includes("has not acknowledged"))
			assert.equal(silent.length, 1)
			acknowledgeStateUpdate()
			assert.equal(warn.mock.calls.filter((call) => String(call[0]).includes("acknowledging state again")).length, 1)
		} finally {
			warn.mockRestore()
		}
	})

	it("says nothing about a webview that keeps acknowledging", async () => {
		vi.useFakeTimers()
		const warn = vi.spyOn(Logger, "warn").mockImplementation(() => {})
		try {
			await subscribe()
			acknowledgeStateUpdate()
			for (let second = 0; second < 40; second++) {
				await sendStateUpdate(state(`s${second}`))
				await vi.advanceTimersByTimeAsync(1000)
				acknowledgeStateUpdate()
			}
			assert.equal(warn.mock.calls.length, 0)
		} finally {
			warn.mockRestore()
		}
	})

	it("stops waiting after two seconds, so a busy or hidden webview delays state and never loses it", async () => {
		vi.useFakeTimers()
		const sent = await subscribe()
		acknowledgeStateUpdate()
		await sendStateUpdate(state("a"))
		await sendStateUpdate(state("b"))
		assert.deepEqual(sent, ["first", "a"])
		await vi.advanceTimersByTimeAsync(2000)
		assert.deepEqual(sent, ["first", "a", "b"])
	})
})
