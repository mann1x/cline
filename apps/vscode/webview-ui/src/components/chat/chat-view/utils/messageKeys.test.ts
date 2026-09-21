import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { computeMessageRowKeys } from "./messageKeys"

const say = (ts: number, text = ""): ClineMessage => ({ ts, type: "say", say: "text", text }) as ClineMessage

describe("computeMessageRowKeys", () => {
	it("keeps a message's key when rows are inserted above it", () => {
		// This is the whole point. Virtuoso keys by index unless told otherwise,
		// so the row that held message B before an insert holds message A after
		// it -- one component instance, two unrelated messages, with the hooks
		// and state of the first applied to the second.
		const before = computeMessageRowKeys([say(2), say(3)])
		const after = computeMessageRowKeys([say(1), say(2), say(3)])

		expect(after.slice(1)).toEqual(before)
	})

	it("gives two messages sharing a timestamp different keys", () => {
		// ts is Date.now() at the moment the message is made, so a collision is
		// rare rather than impossible -- and a duplicate key is a broken list,
		// not a cosmetic warning.
		const keys = computeMessageRowKeys([say(7), say(7), say(7)])

		expect(new Set(keys).size).toBe(3)
	})

	it("keys a grouped row from the message it starts with", () => {
		const keys = computeMessageRowKeys([[say(4), say(5), say(6)], say(9)])

		expect(keys).toEqual(computeMessageRowKeys([say(4), say(9)]))
	})

	it("falls back to the position for a row with no timestamp, without colliding", () => {
		const keys = computeMessageRowKeys([{} as ClineMessage, say(0), [] as ClineMessage[]])

		expect(new Set(keys).size).toBe(3)
	})
})
