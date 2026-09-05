/**
 * Whether a command's empty output means the capture failed.
 *
 * When shell integration yields nothing, Cline can fall back to reading the
 * terminal's visible contents. That snapshot is the *terminal's*, not the
 * command's: it holds whatever is on screen, which is mostly earlier commands.
 * Handing it back as "the command's output" is worse than returning nothing,
 * because a wrong answer is acted on and a missing one is not.
 *
 * Measured on pandorum (session `j2eim`): five of nine `run_commands` calls
 * fell back. One was `Copy-Item 'manic_miner_1TESTSOURCE.html' ... -Force`,
 * which succeeds silently and prints nothing at all. The snapshot returned the
 * tail of an earlier failed `git diff --stat HEAD`, and the model concluded
 * "The file has been restored from backup" — from another command's output.
 *
 * The mistake was equating "produced no output" with "we failed to read the
 * output". A silent success is the single most common shape of a shell
 * command: `Copy-Item`, `Set-Content`, `mkdir`, `cd`, `git add`. Shell
 * integration reported those perfectly; there was simply nothing to report.
 */
export interface TerminalCaptureState {
	/** Anything at all arrived on the command's own output stream. */
	readonly capturedOutput: boolean
	/** Shell integration reported the command started (OSC 633 `C`). */
	readonly sawCommandExecuted: boolean
	/** Shell integration reported the command finished. */
	readonly sawExecutionEnd: boolean
	/** The terminal closed before the command completed. */
	readonly terminalClosed: boolean
}

export function shouldFallBackToTerminalSnapshot(state: TerminalCaptureState): boolean {
	// There is output; there is nothing to substitute for.
	if (state.capturedOutput) {
		return false
	}
	// The snapshot reads the *active* terminal, so it is meaningless — and
	// misleading — once this one has gone.
	if (state.terminalClosed) {
		return false
	}
	// Both ends observed: shell integration watched the command from start to
	// finish and saw no output. That is the command's answer, not a failure to
	// hear it.
	if (state.sawCommandExecuted && state.sawExecutionEnd) {
		return false
	}
	return true
}

/**
 * What to say when the snapshot is genuinely all there is.
 *
 * Named as the terminal's contents rather than the command's, and up front:
 * the previous wording buried "may include" mid-sentence, and a model that
 * skims took the text that followed as its result.
 */
export function terminalSnapshotFallbackMessage(snapshot: string): string {
	return (
		"The command's output could not be captured. What follows is the terminal's visible contents, " +
		"which belongs to this terminal rather than to this command — it may be output from earlier " +
		"commands, and it may not contain this command's output at all. Do not treat it as the result " +
		"of the command you just ran; if you need that result, run something that reports it explicitly.\n\n" +
		snapshot
	)
}
