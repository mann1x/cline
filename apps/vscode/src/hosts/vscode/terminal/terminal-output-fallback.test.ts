import { describe, expect, it } from "vitest"
import { shouldFallBackToTerminalSnapshot, terminalSnapshotFallbackMessage } from "./terminal-output-fallback"

const observed = {
	capturedOutput: false,
	sawCommandExecuted: true,
	sawExecutionEnd: true,
	terminalClosed: false,
}

describe("shouldFallBackToTerminalSnapshot", () => {
	// The measured failure: `Copy-Item ... -Force` succeeds and prints nothing.
	// Shell integration saw it start and finish, so there is nothing wrong with
	// the capture — the command simply had nothing to say.
	it("does not substitute the terminal for a command that succeeded silently", () => {
		expect(shouldFallBackToTerminalSnapshot(observed)).toBe(false)
	})

	it("falls back when the command was never seen to start", () => {
		// No OSC 633 `C`: shell integration is attached but not reporting, so
		// the output stream is not the command's and the snapshot is all there is.
		expect(shouldFallBackToTerminalSnapshot({ ...observed, sawCommandExecuted: false })).toBe(true)
	})

	it("falls back when the command was never seen to finish", () => {
		expect(shouldFallBackToTerminalSnapshot({ ...observed, sawExecutionEnd: false })).toBe(true)
	})

	it("does not substitute anything once the terminal has closed", () => {
		// The snapshot reads the *active* terminal, which by then is a different
		// one — that content has nothing to do with this command at all.
		expect(
			shouldFallBackToTerminalSnapshot({
				...observed,
				sawCommandExecuted: false,
				terminalClosed: true,
			}),
		).toBe(false)
	})

	it("has nothing to substitute for when output was captured", () => {
		expect(
			shouldFallBackToTerminalSnapshot({
				capturedOutput: true,
				sawCommandExecuted: false,
				sawExecutionEnd: false,
				terminalClosed: false,
			}),
		).toBe(false)
	})
})

describe("terminalSnapshotFallbackMessage", () => {
	it("says whose output it is before showing any of it", () => {
		const message = terminalSnapshotFallbackMessage("$ git diff\nfatal: not a repository")

		// The warning has to land before the text, because the failure being
		// prevented is a model reading the content and taking it as its result.
		expect(message.indexOf("belongs to this terminal rather than to this command")).toBeLessThan(
			message.indexOf("fatal: not a repository"),
		)
		expect(message).toContain("Do not treat it as the result")
		expect(message).toContain("fatal: not a repository")
	})
})
