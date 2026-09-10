import { DEFAULT_MAX_CHANGES, DEFAULT_MAX_TRANSACTIONS } from "@cline/core"
import { describe, expect, it } from "vitest"
import { DEFAULT_ATOMIC_PROTOCOL_SETTINGS } from "./AtomicProtocolSettings"

/**
 * The extension keeps its own copy of the protocol's budgets, and its copy is
 * the one that wins: it is a stored setting, and `vscode-session-host` passes
 * it to the SDK unconditionally, so the SDK's own default is never consulted
 * for a task the extension runs.
 *
 * That is how raising `DEFAULT_MAX_CHANGES` to six changed nothing on the host
 * it was raised for. The bundle was built, the constant was six inside it, and
 * the number the model was actually told was still three — from here. This
 * test is what notices next time.
 */
describe("the extension's protocol defaults", () => {
	it("matches the SDK's, because it overrides them", () => {
		expect(DEFAULT_ATOMIC_PROTOCOL_SETTINGS.maxChanges).toBe(DEFAULT_MAX_CHANGES)
		expect(DEFAULT_ATOMIC_PROTOCOL_SETTINGS.maxTransactions).toBe(DEFAULT_MAX_TRANSACTIONS)
	})
})
