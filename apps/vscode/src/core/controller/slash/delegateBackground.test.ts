import { strict as assert } from "node:assert"
import { EmptyRequest } from "@shared/proto/cline/common"
import { BackgroundDelegationControl, DelegateRequest } from "@shared/proto/cline/slash"
import { describe, it, vi } from "vitest"
import type { Controller } from ".."
import { controlBackgroundDelegation } from "./controlBackgroundDelegation"
import { delegateBackground } from "./delegateBackground"
import { listBackgroundDelegations } from "./listBackgroundDelegations"

const RUN = {
	id: "bg_1",
	agentName: "qa",
	prompt: "run the suite",
	status: "running" as const,
	startedAt: 1_700_000_000_000,
}

describe("delegateBackground slash handler", () => {
	// The whole difference from `delegate`: what comes back describes a run
	// that has started, not an answer that has arrived.
	it("returns the run rather than waiting for the agent", async () => {
		const startBackgroundDelegation = vi.fn().mockResolvedValue(RUN)
		const controller = { startBackgroundDelegation } as unknown as Controller

		const response = await delegateBackground(
			controller,
			DelegateRequest.create({ agentName: "qa", prompt: "run the suite" }),
		)

		assert.deepEqual(startBackgroundDelegation.mock.calls[0], ["qa", "run the suite"])
		assert.equal(response.id, "bg_1")
		assert.equal(response.status, "running")
		// Absent is empty on the wire, not the string "undefined".
		assert.equal(response.error, "")
		assert.equal(Number(response.endedAt), 0)
	})

	it("lets a refused delegation surface", async () => {
		const controller = {
			startBackgroundDelegation: vi.fn().mockRejectedValue(new Error('no agent named "qa"')),
		} as unknown as Controller

		await assert.rejects(
			() => delegateBackground(controller, DelegateRequest.create({ agentName: "qa", prompt: "go" })),
			/no agent named/,
		)
	})
})

describe("listing and controlling background delegations", () => {
	it("lists what the session is running", async () => {
		const controller = {
			listBackgroundDelegations: vi.fn().mockResolvedValue([{ ...RUN, activity: "reading the suite" }]),
		} as unknown as Controller

		const response = await listBackgroundDelegations(controller, EmptyRequest.create({}))

		assert.equal(response.runs.length, 1)
		assert.equal(response.runs[0].activity, "reading the suite")
	})

	it("passes a known action through and answers what the registry said", async () => {
		const controlBackground = vi.fn().mockResolvedValue(true)
		const controller = { controlBackgroundDelegation: controlBackground } as unknown as Controller

		const response = await controlBackgroundDelegation(
			controller,
			BackgroundDelegationControl.create({ id: "bg_1", action: "pause" }),
		)

		assert.deepEqual(controlBackground.mock.calls[0], ["bg_1", "pause"])
		assert.equal(response.value, true)
	})

	// A stale button in a panel is not a reason to throw at the user.
	it("answers false for an action nobody defined, without asking the session", async () => {
		const controlBackground = vi.fn()
		const controller = { controlBackgroundDelegation: controlBackground } as unknown as Controller

		const response = await controlBackgroundDelegation(
			controller,
			BackgroundDelegationControl.create({ id: "bg_1", action: "obliterate" }),
		)

		assert.equal(response.value, false)
		assert.equal(controlBackground.mock.calls.length, 0)
	})
})
