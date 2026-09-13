import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { openTransaction, transactionLabel } from "./change-protocol-status"

const verdict = (transaction: number, kept: boolean): ClineMessage =>
	({
		type: "say",
		say: "transaction",
		ts: transaction,
		text: JSON.stringify({ transaction, kept, message: "..." }),
	}) as ClineMessage

describe("which transaction is open", () => {
	it("is the first one before any has settled", () => {
		expect(openTransaction([], true)).toBe(1)
	})

	it("is one past the highest that has settled", () => {
		expect(openTransaction([verdict(1, false), verdict(2, false)], true)).toBe(3)
	})

	// Rows arrive in whatever order the chat holds them, and a discarded
	// transaction is followed by more messages than a kept one.
	it("takes the highest rather than the last", () => {
		expect(openTransaction([verdict(3, false), verdict(1, false)], true)).toBe(4)
	})

	// Claiming TX-01 while nothing is running would be reporting a transaction
	// that does not exist.
	it("is nothing at all when the protocol is not engaged", () => {
		expect(openTransaction([verdict(1, false)], false)).toBeUndefined()
	})

	it("counts past a row that will not parse rather than throwing", () => {
		const broken = { type: "say", say: "transaction", ts: 9, text: "{not json" } as ClineMessage
		expect(openTransaction([verdict(2, false), broken], true)).toBe(3)
	})

	it("ignores messages that are not transaction verdicts", () => {
		const chatter = { type: "say", say: "text", ts: 1, text: "hello" } as ClineMessage
		expect(openTransaction([chatter], true)).toBe(1)
	})

	it("writes the label the way the rest of the protocol does", () => {
		expect(transactionLabel(1)).toBe("TX-01")
		expect(transactionLabel(12)).toBe("TX-12")
	})
})
