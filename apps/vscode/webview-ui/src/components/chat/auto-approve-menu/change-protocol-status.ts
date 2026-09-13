import type { ClineMessage, ClineTransactionInfo } from "@shared/ExtensionMessage"

/**
 * Which transaction is open, worked out from the verdicts already in the chat.
 *
 * Derived rather than plumbed. Every settled transaction posts a `transaction`
 * row carrying its own number, so the open one is the highest of those plus
 * one, and the first is TX-01 before any has settled. That is the same count
 * the protocol keeps, without a second copy of it travelling to the webview to
 * disagree with the first.
 *
 * Returns nothing when the protocol is not engaged: there is no open
 * transaction then, and reporting TX-01 would claim one.
 */
export function openTransaction(messages: readonly ClineMessage[], engaged: boolean): number | undefined {
	if (!engaged) {
		return undefined
	}
	let highest = 0
	for (const message of messages) {
		if (message.type !== "say" || message.say !== "transaction" || !message.text) {
			continue
		}
		try {
			const info = JSON.parse(message.text) as ClineTransactionInfo
			if (typeof info.transaction === "number" && info.transaction > highest) {
				highest = info.transaction
			}
		} catch {
			// A row that will not parse is one transaction this cannot count.
			// Better a number one short than an exception in the panel.
		}
	}
	return highest + 1
}

/** `TX-01`, the way every other part of the protocol writes it. */
export function transactionLabel(transaction: number): string {
	return `TX-${String(transaction).padStart(2, "0")}`
}
