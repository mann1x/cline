import { describe, expect, it } from "vitest"
import {
	type AtomicProtocolSessionSettings,
	type AtomicProtocolSettings,
	DEFAULT_ATOMIC_PROTOCOL_SESSION,
	DEFAULT_ATOMIC_PROTOCOL_SETTINGS,
	normalizeAtomicProtocolMode,
	readAtomicProtocolMode,
	resolveAtomicProtocol,
} from "./AtomicProtocolSettings"

const settings = (over: Partial<AtomicProtocolSettings>): AtomicProtocolSettings => ({
	...DEFAULT_ATOMIC_PROTOCOL_SETTINGS,
	...over,
})

const session = (over: Partial<AtomicProtocolSessionSettings>): AtomicProtocolSessionSettings => ({
	...DEFAULT_ATOMIC_PROTOCOL_SESSION,
	...over,
})

describe("resolving the two halves of the change protocol", () => {
	it("engages static from the first turn, with the stored check", () => {
		const resolved = resolveAtomicProtocol(
			settings({ mode: "static", oracleCommand: "npm test", oracleExpect: "ok" }),
			session({ engaged: false, oracleCommand: "never used" }),
		)

		expect(resolved.engaged).toBe(true)
		expect(resolved.oracleCommand).toBe("npm test")
		expect(resolved.oracleExpect).toBe("ok")
	})

	// The point of static: a measured run must not depend on what the chat panel
	// happened to be showing when it started.
	it("ignores the session entirely under static, engaged flag included", () => {
		const resolved = resolveAtomicProtocol(
			settings({ mode: "static", proposeCheck: false }),
			session({ engaged: true, proposeCheck: true, oracleCommand: "node game.js" }),
		)

		expect(resolved.oracleCommand).toBe("")
		expect(resolved.proposeCheck).toBe(false)
	})

	it("does not engage under on until the user engages this task", () => {
		expect(resolveAtomicProtocol(settings({ mode: "on" }), session({})).engaged).toBe(false)
		expect(resolveAtomicProtocol(settings({ mode: "on" }), session({ engaged: true })).engaged).toBe(true)
	})

	it("takes the check from the task under on, not from settings", () => {
		const resolved = resolveAtomicProtocol(
			settings({ mode: "on", oracleCommand: "npm test", oracleExpect: "stored" }),
			session({ engaged: true, oracleCommand: "node run_game.js", oracleExpect: "task" }),
		)

		expect(resolved.oracleCommand).toBe("node run_game.js")
		expect(resolved.oracleExpect).toBe("task")
	})

	// Nothing is inherited across the on/static line. A command written for one
	// task would judge the next by a standard nobody chose for it, and an empty
	// command already means something: find something to run.
	it("does not fall back to the stored command when the task names none", () => {
		const resolved = resolveAtomicProtocol(
			settings({ mode: "on", oracleCommand: "npm test" }),
			session({ engaged: true, oracleCommand: "" }),
		)

		expect(resolved.oracleCommand).toBe("")
	})

	it("never engages when off, whatever the task says", () => {
		const resolved = resolveAtomicProtocol(settings({ mode: "off" }), session({ engaged: true, oracleCommand: "npm test" }))

		expect(resolved.engaged).toBe(false)
		// Cleared rather than carried: nothing downstream should be able to read
		// a check off a protocol that is not running.
		expect(resolved.oracleCommand).toBe("")
	})

	it("engages a mode stored before the rename, rather than waiting to be engaged", () => {
		for (const legacy of ["auto", "always"]) {
			const resolved = resolveAtomicProtocol(
				settings({ mode: legacy as AtomicProtocolSettings["mode"] }),
				session({ engaged: false }),
			)

			expect(resolved.engaged).toBe(true)
		}
	})
})

describe("reading a stored mode", () => {
	it("maps both old modes to static", () => {
		expect(readAtomicProtocolMode("auto")).toBe("static")
		expect(readAtomicProtocolMode("always")).toBe("static")
	})

	it("passes the three current modes through", () => {
		for (const mode of ["off", "on", "static"] as const) {
			expect(readAtomicProtocolMode(mode)).toBe(mode)
		}
	})

	// Two questions with different right answers: a dropdown needs a value and
	// `off` is the safe one; a write does not, and defaulting there would switch
	// the protocol off for someone who had it on.
	it("returns nothing for a value it does not know, and off when one is required", () => {
		expect(readAtomicProtocolMode("sometimes")).toBeUndefined()
		expect(readAtomicProtocolMode(undefined)).toBeUndefined()
		expect(normalizeAtomicProtocolMode("sometimes")).toBe("off")
	})
})
