/**
 * Whether a task runs as judged, revertible transactions.
 *
 * A stronger claim than edit verification and a different one. Verification
 * asks that a changed file be checked; this decides what happens when the check
 * says no. A transaction that fails is not reported and left on disk — every
 * file it touched goes back to what it was, and the next attempt starts from
 * the same place this one did, carrying the record of what was already tried.
 *
 * Measured across the campaign this comes from: transactions that reported
 * success and failed the check were the normal case, not the exception. The
 * model had fixed the error it was looking at and not the one the program still
 * had, and without a rollback each of those attempts left its half-fix behind
 * for the next one to work on top of.
 */

export type AtomicProtocolMode =
	/** Off. What every build before this one did. */
	| "off"
	/** On where a change can actually be judged, and quiet where it cannot. */
	| "auto"
	/** On regardless, with the model as the check where nothing else is. */
	| "always"

export interface AtomicProtocolSettings {
	mode: AtomicProtocolMode
	/**
	 * What must be run for this task to count as done, as a shell line.
	 *
	 * The user's own check, and it outranks anything detection finds. Detection
	 * answers "does this workspace still hold together", which a model can leave
	 * green with the asked-for thing still broken — a typecheck passes over a
	 * game that no longer starts. A line written for the task at hand is the
	 * narrower question and the one worth judging on.
	 */
	oracleCommand: string
	/** Changes the model may declare per transaction. */
	maxChanges: number
	/** Attempts before the task stops. */
	maxTransactions: number
}

/**
 * Off by default. The protocol runs a check per attempt and holds a copy of the
 * workspace in memory, which is not a bargain for a one-line edit — and a
 * feature that silently reverts a user's files is not one to turn on for them.
 *
 * Three changes and six transactions are the harness's numbers: measured there,
 * the fix landed in the first three transactions or not at all, and the limit
 * of three is what stopped a transaction from becoming a rewrite nobody could
 * judge.
 */
export const DEFAULT_ATOMIC_PROTOCOL_SETTINGS: AtomicProtocolSettings = {
	mode: "off",
	oracleCommand: "",
	maxChanges: 3,
	maxTransactions: 6,
}
