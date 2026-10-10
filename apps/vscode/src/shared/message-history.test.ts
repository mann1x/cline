import { describe, expect, it } from "vitest"
import {
	clampMessageHistoryLimit,
	MAX_MESSAGE_HISTORY_ENTRY_CHARS,
	type MessageHistoryCursor,
	pushMessageHistory,
	stepMessageHistory,
} from "./message-history"

describe("message history", () => {
	it("keeps the newest messages up to the limit, oldest first", () => {
		let history: string[] = []
		for (const text of ["one", "two", "three", "four"]) {
			history = pushMessageHistory(history, text, 3)
		}
		expect(history).toEqual(["two", "three", "four"])
	})

	it("moves a repeated message to the end instead of keeping it twice", () => {
		expect(pushMessageHistory(["continue", "fix the test"], " continue ", 50)).toEqual(["fix the test", "continue"])
	})

	it("keeps neither an empty message nor an oversized one", () => {
		expect(pushMessageHistory(["one"], "   ", 50)).toEqual(["one"])
		expect(pushMessageHistory(["one"], "x".repeat(MAX_MESSAGE_HISTORY_ENTRY_CHARS + 1), 50)).toEqual(["one"])
	})

	it("trims to a limit that was lowered", () => {
		expect(pushMessageHistory(["a", "b", "c", "d"], "", 2)).toEqual(["c", "d"])
	})

	it("reads a limit that is not a usable number as the default", () => {
		expect(clampMessageHistoryLimit(undefined)).toBe(50)
		expect(clampMessageHistoryLimit(0)).toBe(50)
		expect(clampMessageHistoryLimit(-3)).toBe(50)
		expect(clampMessageHistoryLimit("12")).toBe(12)
		expect(clampMessageHistoryLimit(100_000)).toBe(500)
	})

	it("walks up to the oldest and back down to what was typed", () => {
		const history = ["first", "second", "third"]
		let cursor: MessageHistoryCursor | undefined
		const seen: string[] = []
		for (const direction of ["up", "up", "up", "up", "down", "down", "down"] as const) {
			const step = stepMessageHistory(history, cursor, direction, "typing")
			expect(step).toBeDefined()
			cursor = step?.cursor
			seen.push(step?.text ?? "")
		}
		expect(seen).toEqual(["third", "second", "first", "first", "second", "third", "typing"])
		expect(cursor).toBeUndefined()
	})

	it("does nothing going down from the box, or with no history", () => {
		expect(stepMessageHistory(["one"], undefined, "down", "typing")).toBeUndefined()
		expect(stepMessageHistory([], undefined, "up", "typing")).toBeUndefined()
	})
})
