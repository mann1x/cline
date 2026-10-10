import { describe, expect, it } from "vitest"
import {
	clampMessageHistoryLimit,
	MAX_MESSAGE_HISTORY_ENTRY_CHARS,
	type MessageHistoryCursor,
	messageHistoryDirection,
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

	it("takes Ctrl with the arrows on every platform, and nothing with Shift or Alt", () => {
		const box = { mac: false, walking: false, selectionStart: 3, selectionEnd: 3, length: 9 }
		const key = { key: "ArrowUp", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }
		expect(messageHistoryDirection(key, box)).toBe("up")
		expect(messageHistoryDirection({ ...key, key: "ArrowDown" }, { ...box, mac: true })).toBe("down")
		expect(messageHistoryDirection({ ...key, shiftKey: true }, box)).toBeUndefined()
		expect(messageHistoryDirection({ ...key, altKey: true }, box)).toBeUndefined()
		expect(messageHistoryDirection({ ...key, ctrlKey: false }, box)).toBeUndefined()
		expect(messageHistoryDirection({ ...key, key: "a" }, box)).toBeUndefined()
	})

	it("takes Cmd on macOS only where the caret jump has nowhere to go", () => {
		const up = { key: "ArrowUp", ctrlKey: false, metaKey: true, shiftKey: false, altKey: false }
		const down = { ...up, key: "ArrowDown" }
		const box = { mac: true, walking: false, selectionStart: 4, selectionEnd: 4, length: 9 }
		// Mid-text: the caret jumps, as in any text box.
		expect(messageHistoryDirection(up, box)).toBeUndefined()
		expect(messageHistoryDirection(down, box)).toBeUndefined()
		expect(messageHistoryDirection(up, { ...box, selectionStart: 0, selectionEnd: 0 })).toBe("up")
		expect(messageHistoryDirection(down, { ...box, selectionStart: 9, selectionEnd: 9 })).toBe("down")
		// A selection reaching the edge is still a selection.
		expect(messageHistoryDirection(up, { ...box, selectionStart: 0, selectionEnd: 4 })).toBeUndefined()
		// An empty box is at both edges.
		expect(messageHistoryDirection(up, { ...box, selectionStart: 0, selectionEnd: 0, length: 0 })).toBe("up")
		// Walking: every press continues the walk.
		expect(messageHistoryDirection(up, { ...box, walking: true })).toBe("up")
		expect(messageHistoryDirection(down, { ...box, walking: true })).toBe("down")
		// Not on other platforms, where the key is the Windows or Super key.
		expect(messageHistoryDirection(up, { ...box, mac: false, selectionStart: 0, selectionEnd: 0 })).toBeUndefined()
	})

	it("does nothing going down from the box, or with no history", () => {
		expect(stepMessageHistory(["one"], undefined, "down", "typing")).toBeUndefined()
		expect(stepMessageHistory([], undefined, "up", "typing")).toBeUndefined()
	})
})
