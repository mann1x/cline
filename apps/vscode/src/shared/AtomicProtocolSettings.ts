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
	/**
	 * A regular expression that command's output must match, on top of a clean
	 * exit.
	 *
	 * For the large class of checks that report a verdict and exit zero anyway.
	 * Without it such a check keeps every transaction it is pointed at.
	 */
	oracleExpect: string
	/** Changes the model may declare per transaction. */
	maxChanges: number
	/** Attempts before the task stops. */
	maxTransactions: number
	/**
	 * Whether the model may propose its own check where nothing can be run.
	 *
	 * On by default. Off returns the no-oracle case to the verdict that
	 * preceded it — the model's own account of its work, labelled as such.
	 * Measured on one workspace across a dozen runs, the proposed-check arm
	 * took four to six times the model time of the self-declared arm and closed
	 * nothing, so this exists to compare them on the same task rather than
	 * across releases. It does nothing when there is a check to run.
	 */
	proposeCheck: boolean
	/**
	 * Proposals put to you before the run gives up on having a check.
	 *
	 * Two, which is what it was before it could be changed. A run where every
	 * proposal is approved without asking wants a different number from one
	 * where you answer each time.
	 */
	maxCheckProposals: number
	/**
	 * Discarded attempts before a check that has never passed may be replaced.
	 *
	 * A check the model proposed is frozen once approved, and that is what
	 * stops it weakening the check until one passes. It also freezes a check
	 * that cannot pass at all, and measured over ten runs on one workspace that
	 * cost two of them outright — one keyed on a condition no correct fix
	 * produces, one whose command was not valid JavaScript and so failed on any
	 * files at all. The second worked that out and proposed the right check
	 * twice, and was refused both times.
	 *
	 * So: after this many attempts thrown away with the check never once
	 * passing, it may be replaced, once. Zero turns that off and restores the
	 * freeze exactly as it was. A check you wrote yourself, or one found in the
	 * workspace, is never reconsidered — it is the specification.
	 */
	checkReconsideredAfter: number
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
	oracleExpect: "",
	maxChanges: 3,
	maxTransactions: 6,
	proposeCheck: true,
	maxCheckProposals: 2,
	checkReconsideredAfter: 2,
}
