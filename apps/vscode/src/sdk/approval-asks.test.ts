import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/shared/services/Logger", () => ({
	Logger: { warn: vi.fn(), log: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const showMessage = vi.fn()
const showInputBox = vi.fn()
vi.mock("@/hosts/host-provider", () => ({
	HostProvider: {
		get window() {
			return { showMessage, showInputBox }
		},
	},
}))

import { createCheckApprover } from "./check-approval"
import { createEscalationApprover } from "./escalation-approval"

/**
 * Both of these were modal dialogs, and both were the wrong shape for what they
 * carry: a brief written in markdown arrived as literal asterisks, truncated at
 * 2,000 characters, and a refusal could only be a refusal. These cover what
 * moving them into the chat is for.
 */
describe("approvals asked in the chat", () => {
	beforeEach(() => {
		showMessage.mockReset()
		showInputBox.mockReset()
	})

	const brief = `== ESCALATION ==\n\n## What you are being asked to do\n\n${"x".repeat(5_000)}`

	it("sends the escalation brief whole, not truncated to a preview", async () => {
		const askUser = vi.fn(async () => "Hand it over")
		const approve = createEscalationApprover(askUser)

		const answer = await approve({ brief, index: 1, of: 3 })

		expect(answer).toEqual({ approved: true })
		const asked = askUser.mock.calls[0][0] as string
		expect(asked).toContain(brief)
		expect(asked).not.toContain("more characters")
		expect(askUser.mock.calls[0][1]).toEqual(["Hand it over", "No — keep going"])
	})

	it("carries what the user typed back to the model as a refusal with a reason", async () => {
		const approve = createEscalationApprover(async () => "don't escalate for syntax errors, run node --check first")

		const answer = await approve({ brief, index: 2, of: 3 })

		expect(answer).toEqual({
			approved: false,
			feedback: "don't escalate for syntax errors, run node --check first",
		})
	})

	it("reads the decline button as a plain no", async () => {
		const approve = createEscalationApprover(async () => "No — keep going")

		expect(await approve({ brief, index: 1, of: 3 })).toEqual({ approved: false })
	})

	// A host with no chat still has to be able to ask, and the setting it
	// serves can only refuse when nobody can be asked at all.
	it("falls back to the modal when there is no chat to ask in", async () => {
		showMessage.mockResolvedValue({ selectedOption: "Hand it over" })
		const approve = createEscalationApprover(undefined)

		expect(await approve({ brief, index: 1, of: 3 })).toEqual({ approved: true })
		expect(showMessage).toHaveBeenCalledTimes(1)
		// And there it is still previewed, because that surface cannot show it.
		expect(showMessage.mock.calls[0][0].message).toContain("more characters")
	})

	it("refuses when the ask throws rather than escalating anyway", async () => {
		const approve = createEscalationApprover(async () => {
			throw new Error("no window")
		})

		expect(await approve({ brief, index: 1, of: 3 })).toEqual({ approved: false })
	})

	it("approves a proposed check and names a command as one", async () => {
		const askUser = vi.fn(async () => "Use this check")
		const approve = createCheckApprover(askUser)

		const answer = await approve({ kind: "command" } as never, "`node run_game.js manic_miner.html`")

		expect(answer).toEqual({ approved: true })
		expect(askUser.mock.calls[0][0]).toContain("proposes running a command")
		expect(askUser.mock.calls[0][0]).toContain("node run_game.js")
	})

	// The dialog needed two steps for this -- decline, then a separate input
	// box that could itself be dismissed into a dead end. In the chat they are
	// one act.
	it("takes the decline and the replacement check in one step", async () => {
		const approve = createCheckApprover(async () => "run node --check on the file instead")

		const answer = await approve({ kind: "command" } as never, "`rm -rf build`")

		expect(answer).toEqual({
			approved: false,
			feedback: "run node --check on the file instead",
		})
		// No second prompt: the input box belongs to the modal path only.
		expect(showInputBox).not.toHaveBeenCalled()
	})
})
