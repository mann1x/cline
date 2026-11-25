/**
 * How many Cerebriline terminals a window may hold at once (mann1x/cline#56).
 *
 * Kept free of `vscode` imports so `run_commands` can recognise the error
 * without pulling the terminal manager into its module graph.
 */

/** The default for the "Maximum terminals" setting. `0` means no limit. */
export const DEFAULT_MAX_TERMINALS = 5

/** A stored or typed limit as the manager uses it: a whole number, `0` for none. */
export function normalizeMaxTerminals(value: unknown): number {
	const n = typeof value === "number" ? value : Number(value)
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * Every Cerebriline terminal is open and busy, and opening another would pass
 * the limit. Thrown by the acquisition so `run_commands` can run the command
 * without a terminal instead of opening one more window.
 */
export class TerminalLimitReachedError extends Error {
	constructor(
		readonly limit: number,
		readonly open: number,
	) {
		super(`All ${open} Cerebriline terminals are busy, and the limit is ${limit}`)
		this.name = "TerminalLimitReachedError"
	}
}

/** The line put in front of the output of a command that ran without a terminal. */
export function describeTerminalLimitFallback(error: TerminalLimitReachedError): string {
	return `[Ran without a terminal window: all ${error.open} Cerebriline terminals are busy with other commands, and the limit is ${error.limit} (Settings > Terminal > Maximum terminals).]`
}
