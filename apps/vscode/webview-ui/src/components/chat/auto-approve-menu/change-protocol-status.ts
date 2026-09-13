import type { ClineMessage, ClineSayTool, ClineTransactionInfo } from "@shared/ExtensionMessage"

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

/**
 * The plan the model filed through the `plan` tool, or nothing if it has not.
 *
 * Read back out of the transcript rather than plumbed separately. Every `plan`
 * call renders a tool row carrying the whole plan -- the tool returns all of it
 * on every call by design, so the last row is the current state -- and a second
 * copy travelling to the webview could only ever disagree with the one already
 * on screen.
 *
 * The distinction the panel needs is "has it filed one at all", which is why
 * this returns undefined rather than an empty string: a model that never called
 * the tool and one that filed an empty plan are different, and only the first
 * is worth telling the user about.
 */
export function latestPlan(messages: readonly ClineMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message.type !== "say" || message.say !== "tool" || !message.text) {
			continue
		}
		try {
			const tool = JSON.parse(message.text) as ClineSayTool
			if (tool.tool !== ("plan" as ClineSayTool["tool"])) {
				continue
			}
			const content = tool.content?.trim()
			return content ? content : undefined
		} catch {
			// A row that will not parse is not a plan this can read. Keep looking:
			// an older call still describes the plan better than nothing does.
		}
	}
	return undefined
}
