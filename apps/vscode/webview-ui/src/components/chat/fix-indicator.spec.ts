import {
	type AtomicProtocolSessionSettings,
	type AtomicProtocolSettings,
	DEFAULT_ATOMIC_PROTOCOL_SESSION,
	DEFAULT_ATOMIC_PROTOCOL_SETTINGS,
} from "@shared/AtomicProtocolSettings"
import { describe, expect, it } from "vitest"
import { describeFixIndicator } from "./fix-indicator"

const settings = (over: Partial<AtomicProtocolSettings>): AtomicProtocolSettings => ({
	...DEFAULT_ATOMIC_PROTOCOL_SETTINGS,
	...over,
})
const session = (over: Partial<AtomicProtocolSessionSettings>): AtomicProtocolSessionSettings => ({
	...DEFAULT_ATOMIC_PROTOCOL_SESSION,
	...over,
})

describe("the Fix segment", () => {
	it("is dim and not engaged while the protocol is off", () => {
		const indicator = describeFixIndicator(settings({ mode: "off" }), session({ engaged: true }))

		expect(indicator.available).toBe(false)
		expect(indicator.engaged).toBe(false)
		// Dimmed with no explanation is a control that looks broken.
		expect(indicator.title).toContain("Settings")
	})

	it("is available but not engaged under on until the task engages it", () => {
		const idle = describeFixIndicator(settings({ mode: "on" }), session({ engaged: false }))

		expect(idle.available).toBe(true)
		expect(idle.engaged).toBe(false)
		// The only place the user is told where the switch actually is.
		expect(idle.title).toContain("Auto-approve panel")
	})

	it("is engaged under on once the task engages it", () => {
		const live = describeFixIndicator(settings({ mode: "on" }), session({ engaged: true }))

		expect(live.engaged).toBe(true)
		expect(live.label).toContain("engaged for this task")
		expect(live.title).toContain("Disengage")
	})

	// Static is engaged by definition. Sending the user to look for a switch
	// that is deliberately not there would be worse than saying so.
	it("reads as engaged under static, and says it cannot be switched here", () => {
		const stat = describeFixIndicator(settings({ mode: "static" }), session({ engaged: false }))

		expect(stat.available).toBe(true)
		expect(stat.engaged).toBe(true)
		expect(stat.title).toContain("Not switchable from here")
		expect(stat.title).not.toContain("Auto-approve panel")
	})

	it("treats a missing session as not engaged rather than throwing", () => {
		expect(describeFixIndicator(settings({ mode: "on" }), undefined).engaged).toBe(false)
		expect(describeFixIndicator(undefined, undefined).available).toBe(false)
	})
})
