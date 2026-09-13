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
	/**
	 * Available, and the user engages it per task when they hit something worth
	 * judging. The oracle, the pattern and the propose-check switch are session
	 * settings under this mode, set in the chat's auto-approve panel next to the
	 * engage button, because they are decisions about the bug in front of you
	 * rather than about how you work.
	 */
	| "on"
	/**
	 * Engaged on every task from the moment it starts, configured once in
	 * Settings and unaffected by anything said in the conversation.
	 *
	 * The mode to measure a model in: a run must not depend on what a panel
	 * happened to be showing when it started.
	 */
	| "static"

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
 * Six changes and six transactions. Six transactions is the harness's number:
 * measured there, the fix landed in the first three or not at all.
 *
 * Changes was three, also from the harness, and it had to move for the same
 * reason the SDK's `DEFAULT_MAX_CHANGES` did — a 9B session that made 56 edits
 * against a ceiling of three, so the ceiling was not restraining the work, only
 * making the declaration a fiction.
 *
 * These two numbers must agree. This one is the one that wins: it is a stored
 * setting, and `vscode-session-host` passes it straight through, so an
 * extension default of three would override the SDK constant on every task the
 * extension runs — which is every task a user runs. `atomic-protocol-defaults.test.ts`
 * is what fails when they drift apart.
 */
/**
 * What the user decides per task, rather than once in Settings.
 *
 * Only read where the mode is `on`. Under `static` these three come from the
 * stored settings above and this is ignored entirely, which is the point of
 * `static`: a measured run cannot be perturbed from the chat panel.
 *
 * Stored at task scope, so `StateManager.getGlobalSettingsKey` resolves it over
 * the global value without anything here having to merge the two. A new task
 * starts with none of it, which is what makes engaging a per-task decision.
 */
export interface AtomicProtocolSessionSettings {
	/**
	 * Whether the protocol is running for this task right now.
	 *
	 * Not a setting so much as a switch position. Under `static` it is implied
	 * and cannot be changed; under `on` it starts false on every new task.
	 */
	engaged: boolean
	/** This task's own check. See `oracleCommand` above. */
	oracleCommand: string
	/** What that check's output must say. See `oracleExpect` above. */
	oracleExpect: string
	/** Whether the model may propose a check for this task. */
	proposeCheck: boolean
}

/**
 * Not engaged, and nothing named. A task that has never touched the protocol.
 */
export const DEFAULT_ATOMIC_PROTOCOL_SESSION: AtomicProtocolSessionSettings = {
	engaged: false,
	oracleCommand: "",
	oracleExpect: "",
	proposeCheck: true,
}

export const DEFAULT_ATOMIC_PROTOCOL_SETTINGS: AtomicProtocolSettings = {
	mode: "off",
	oracleCommand: "",
	oracleExpect: "",
	maxChanges: 6,
	maxTransactions: 6,
	proposeCheck: true,
	maxCheckProposals: 2,
	checkReconsideredAfter: 2,
}

/**
 * Read a stored mode, including one written before the rename.
 *
 * `auto` and `always` were the old pair. Both engaged the protocol by
 * themselves and differed only in a workspace where nothing could judge a
 * change, so both become `static`: it is the mode that engages on its own, and
 * mapping them to `on` would leave the protocol switched on for everyone who
 * had it and never engaging, which reads exactly like it broke.
 *
 * Applied on read rather than as a one-off migration so that it also covers a
 * value arriving from remote config, and so that a stale write cannot
 * reintroduce a mode nothing else understands.
 */
export function readAtomicProtocolMode(value: unknown): AtomicProtocolMode | undefined {
	if (value === "on" || value === "static" || value === "off") {
		return value
	}
	if (value === "auto" || value === "always") {
		return "static"
	}
	return undefined
}

/**
 * The same, for a place that must end up with a mode.
 *
 * Kept apart from `readAtomicProtocolMode` because the two questions have
 * different right answers. Rendering a dropdown needs a value and `off` is the
 * safe one; *storing* a value does not, and defaulting there would let an
 * unrecognized string switch the protocol off for someone who had it on.
 */
export function normalizeAtomicProtocolMode(value: unknown): AtomicProtocolMode {
	return readAtomicProtocolMode(value) ?? DEFAULT_ATOMIC_PROTOCOL_SETTINGS.mode
}

/** What a session actually runs with, once the two halves are resolved. */
export interface ResolvedAtomicProtocol {
	/** Whether the protocol runs for this task at all. */
	engaged: boolean
	/** The check for this task, empty meaning "find something to run". */
	oracleCommand: string
	/** What that check's output must say. */
	oracleExpect: string
	/** Whether the model may propose a check. */
	proposeCheck: boolean
}

/**
 * Fold the stored settings and the task's own into what this session runs with.
 *
 * The split is the whole point of the rename, and it is one rule: `static`
 * reads Settings and ignores the task, `on` reads the task and ignores
 * Settings' check fields. Nothing is inherited across that line -- an `on`
 * session with no command of its own means "find something to run", not "use
 * the command someone last typed into Settings", because that command was
 * written for a different task and would judge this one by its standard.
 *
 * The limits are not here: `maxChanges`, `maxTransactions` and the two proposal
 * numbers stay in Settings in both modes. They are how you work, not what this
 * particular bug needs.
 */
export function resolveAtomicProtocol(
	settings: AtomicProtocolSettings | undefined,
	session: AtomicProtocolSessionSettings | undefined,
): ResolvedAtomicProtocol {
	const mode = normalizeAtomicProtocolMode(settings?.mode)
	if (mode === "static") {
		return {
			engaged: true,
			oracleCommand: settings?.oracleCommand ?? "",
			oracleExpect: settings?.oracleExpect ?? "",
			proposeCheck: settings?.proposeCheck !== false,
		}
	}
	if (mode === "on") {
		return {
			engaged: session?.engaged === true,
			oracleCommand: session?.oracleCommand ?? "",
			oracleExpect: session?.oracleExpect ?? "",
			proposeCheck: session?.proposeCheck !== false,
		}
	}
	// Off. Reported with the session's fields cleared rather than carried, so
	// nothing downstream can read a check off a protocol that is not running.
	return {
		engaged: false,
		oracleCommand: "",
		oracleExpect: "",
		proposeCheck: false,
	}
}
