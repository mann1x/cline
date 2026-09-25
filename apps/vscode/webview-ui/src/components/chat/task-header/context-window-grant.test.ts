import { describe, expect, it } from "vitest"
import { resolveShownContextWindow } from "./context-window-grant"

describe("the window the context bar ends at", () => {
	it("is the grant when the server granted less than configured", () => {
		expect(resolveShownContextWindow(262_144, { grantedTokens: 163_840, askedTokens: 262_144 })).toEqual({
			max: 163_840,
			granted: true,
			smallerThanAsked: true,
			asked: 262_144,
		})
	})

	it("is the configured window when there is no grant", () => {
		expect(resolveShownContextWindow(262_144, undefined)).toEqual({
			max: 262_144,
			granted: false,
			smallerThanAsked: false,
		})
	})

	// Compaction and the output cap are sized to the configured window.
	it("does not grow past the configured window", () => {
		expect(resolveShownContextWindow(65_536, { grantedTokens: 262_144 }).max).toBe(65_536)
	})

	it("compares with the configured window when the grant names no ask", () => {
		expect(resolveShownContextWindow(262_144, { grantedTokens: 131_072 })).toMatchObject({
			max: 131_072,
			smallerThanAsked: true,
			asked: 262_144,
		})
	})
})
