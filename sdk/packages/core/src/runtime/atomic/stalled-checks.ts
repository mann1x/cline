/**
 * Close a transaction whose check is being re-run over files nobody is changing.
 *
 * `run_check` settles nothing, by design: that is what makes it safe to run
 * after every edit, and the protocol asks the model to do exactly that. The
 * cost is that a model which never yields its turn never reaches
 * `onCompletionAttempt`, which is the only place `settle` is called from -- so
 * it never settles at all. That is the timeout signature: the three JackOD4-AC
 * 9B timeouts closed zero transactions between them, over 308-428 iterations
 * each.
 *
 * The trigger is deliberately *not* "three failed checks". Under the
 * one-edit-one-check rule a healthy transaction fails its check repeatedly on
 * the way to passing -- the check is the task's own oracle, so it keeps failing
 * until the last fix lands, and the model is told to run it on the unmodified
 * files first to see the failure in the check's own words. Three failures is
 * the opening of a transaction that is working, and counting those would
 * guillotine one that was an edit away from passing.
 *
 * What separates the two is whether anything changed between one check and the
 * next. Longest run of checks with no edit in between, over the JackOD4-AC arm:
 *
 *     0207  FIXED    481s   1 check    streak 1
 *     0208  FIXED   2649s  41 checks   streak 6
 *     0209  broken   862s  21 checks   streak 6
 *     0213  broken  2688s  49 checks   streak 4
 *     0214  broken   615s  22 checks   streak 10
 *     0215  broken  5014s  22 checks   streak 4
 *
 * The one run that fixed the task quickly never re-ran the check over untouched
 * files at all. Every other run did, four to ten times over. Three sits above
 * the working run and below all the rest, and it is defensible without the
 * measurement too: a check re-run over bytes that have not moved cannot return
 * anything the run before it did not.
 */

import type {
	AgentTool,
	AgentToolContext,
	AgentToolDefinition,
} from "@cline/shared";
import { DefaultToolNames } from "../../extensions/tools/constants";
import { RESTORE_FILE_TOOL_NAME } from "./restore-file-tool";

/** Checks over untouched files before the model is told the check has stopped moving. */
export const DEFAULT_MAX_CHECKS_WITHOUT_EDIT = 3;

/**
 * Checks over untouched files before the transaction is closed for the model.
 *
 * Two more after the nudge, and the gap is the point. Settling is a rollback --
 * every change in the transaction goes back -- which is the most expensive
 * possible answer to "that check told you nothing new", and the measured
 * evidence says a sentence is usually enough. On the pandorum run of
 * 2026-09-13, eleven of eighteen check runs returned the previous answer byte
 * for byte; what ended the loop was the non-convergence guard quoting the
 * model's own "I'm stuck in an infinite loop of edits that keep regressing"
 * back at it, after which it converged in three minutes and one edit. Nothing
 * was rolled back to achieve that.
 *
 * So the guard speaks first and cuts second. A model that ignores the sentence
 * still reaches the same settlement it did before, two checks later.
 */
export const DEFAULT_MAX_CHECKS_BEFORE_SETTLING = 5;

/** What the counter needs to know, and nothing more. */
export interface StalledCheckSource {
	/** Which transaction is open, so the count can reset when it changes. */
	readonly transaction: number;
	/** How many checks over untouched files earn the nudge. */
	readonly max?: number;
	/** How many end the transaction. Defaults to two more than the nudge. */
	readonly settleAt?: number;
}

/**
 * What a check over untouched files has earned.
 *
 * `nudge` is said once per transaction and judges nothing; `settle` closes the
 * transaction the way this guard always did.
 */
export type StalledCheckVerdict = "ok" | "nudge" | "settle";

export interface StalledChecks {
	/** Record a check that has just run, and say what it has earned. */
	checked(passed: boolean): StalledCheckVerdict;
	/** Record a change: whatever the next check says, it is judging new bytes. */
	changed(): void;
	/** The current run of checks over untouched files. */
	readonly streak: number;
}

export function createStalledChecks(source: StalledCheckSource): StalledChecks {
	const max = source.max ?? DEFAULT_MAX_CHECKS_WITHOUT_EDIT;
	// Two beyond the nudge, whatever the nudge point is, so a host that lowers
	// `max` gets a lower nudge and not an instant settlement.
	const settleAt =
		source.settleAt ??
		Math.max(
			max + 1,
			DEFAULT_MAX_CHECKS_BEFORE_SETTLING -
				DEFAULT_MAX_CHECKS_WITHOUT_EDIT +
				max,
		);
	// Reset by observing the number rather than by being told, like the
	// check-first gate next door: this counter has no place in the transaction
	// lifecycle and should not acquire one.
	let seenTransaction = source.transaction;
	let streak = 0;
	// Once per transaction. A guard that repeats itself every third check is
	// noise, and the model has already been told.
	let nudged = false;

	const syncTransaction = () => {
		if (source.transaction !== seenTransaction) {
			seenTransaction = source.transaction;
			streak = 0;
			nudged = false;
		}
	};

	return {
		get streak() {
			return streak;
		},
		changed() {
			syncTransaction();
			streak = 0;
		},
		checked(passed: boolean): StalledCheckVerdict {
			syncTransaction();
			// A passing check is never the stalled kind. The model has been told
			// to say so and finish, and the same check runs again when it does.
			if (passed) {
				streak = 0;
				return "ok";
			}
			streak += 1;
			if (streak >= settleAt) {
				return "settle";
			}
			if (streak >= max && !nudged) {
				nudged = true;
				return "nudge";
			}
			return "ok";
		},
	};
}

/** The tools that change a file, so the check after one judges new bytes. */
const CHANGING_TOOLS: readonly string[] = [
	DefaultToolNames.EDITOR,
	DefaultToolNames.APPLY_PATCH,
	RESTORE_FILE_TOOL_NAME,
];

/**
 * Wrap the changing tools so the counter hears about them.
 *
 * Wrap *inside* `withCheckFirstEdits`, never outside: an edit that gate refuses
 * never reaches the file, and letting a refused edit clear the count would hand
 * the model a way to hold a stalled transaction open with edits that do not
 * land.
 *
 * The signal is the call, not the write. A tool that reports a refusal of its
 * own -- a range that matched nothing, one edit of a batch held back -- still
 * clears the count, so the guard needs one more check than it strictly should
 * before it fires. That is the right way round: a check re-run after a change
 * that did land is the case this must never cut short.
 */
export function withChangeSignal<T extends AgentToolDefinition>(
	tools: readonly T[],
	onChange: () => void,
): T[] {
	return tools.map((tool) => {
		if (!CHANGING_TOOLS.includes(tool.name)) {
			return tool;
		}
		const original = tool as unknown as AgentTool<unknown, unknown>;
		return {
			...original,
			execute: async (input: unknown, context: AgentToolContext) => {
				// Before the call rather than after, because a tool that throws
				// may still have written.
				onChange();
				return original.execute(input, context);
			},
		} as unknown as T;
	});
}

/**
 * What the model is told the first time the check stops moving.
 *
 * It judges nothing and puts nothing back -- saying otherwise would have the
 * model report a transaction that is still open. What it adds is the thing the
 * re-run cannot give it: the check names where the parser gave up, and
 * `check_file` names the line that is actually wrong.
 */
export function describeStalledCheckNudge(runs: number, label: string): string {
	return [
		`That was \`${label}\` run ${runs} times in a row over files that have not changed since the run before it. It cannot tell you anything the first of them did not, and running it again will not either.`,
		"",
		`Change something or look somewhere else. \`check_file\` is the sharper instrument here: it lists every problem in the file rather than the first one, and where brackets cross it names the line that is wrong rather than the line the parser gave up on.`,
		"",
		"The transaction is still open, and this is not a verdict on it.",
	].join("\n");
}

/** What the model is told when the check is closed out from under it. */
export function describeStalledChecks(runs: number, label: string): string {
	return [
		`That was \`${label}\` run ${runs} times in a row over files that have not changed since the run before it, so it cannot tell you anything the first of them did not.`,
		"",
		"Re-reading the same failure is not progress, and the transaction is judged here rather than left open on it.",
	].join("\n");
}
