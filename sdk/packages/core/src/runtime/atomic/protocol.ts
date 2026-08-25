import type { Oracle, OracleVerdict } from "./oracle";

/**
 * How a transaction was judged, and by whom.
 *
 * `self-declared` is not a lesser flavour of the same thing and is never
 * presented as one. An oracle answers about the program; a model answers about
 * the edit it meant to make, and across the atomic campaign those disagreed
 * routinely — transactions that reported success and failed the oracle were
 * the normal case, because the model had fixed the error it was looking at and
 * not the one the program still had.
 */
export type TransactionVerdictSource = "oracle" | "self-declared";

export interface TransactionOutcome {
	/** One-based, in the order they were opened. */
	transaction: number;
	kept: boolean;
	source: TransactionVerdictSource;
	/** What the model said it would change, as it declared it. */
	plan?: string;
	/** What the model said about the change when it tried to end the turn. */
	account?: string;
	/** The oracle's output, or the model's own account when there was none. */
	evidence: string;
}

export interface ProtocolPromptInput {
	/** One-based number of the transaction about to open. */
	transaction: number;
	/** Hard limit on declared changes. Three, unless the host says otherwise. */
	maxChanges: number;
	/** Last transaction this task will get, so the model knows the budget. */
	maxTransactions: number;
	/** The check that will decide, when there is one. */
	oracle?: Oracle;
	/** What earlier transactions tried, in order. */
	history: readonly TransactionOutcome[];
}

/**
 * The rules, restated in full at the open of every transaction.
 *
 * Repeated rather than referred back to, the way the harness does it: a
 * transaction the model experiences as a continuation of a conversation still
 * has to be one it can see the rules of, and a rule that scrolled out of the
 * window is a rule that is not followed. The cost is a few hundred tokens per
 * transaction against a protocol that only works if it is understood.
 */
export function buildProtocolPrompt(input: ProtocolPromptInput): string {
	const label = `TX-${String(input.transaction).padStart(2, "0")}`;
	const lines: string[] = [
		"== CHANGE PROTOCOL ==",
		"",
		`You are working in transactions. This one is ${label} of at most ${input.maxTransactions}.`,
		"",
		`Before you edit anything, state your plan as a numbered list of AT MOST ${input.maxChanges} changes. For each one give three things:`,
		"  WHERE - the function, or the exact text you will match on",
		"  WHAT  - the single concrete edit you will make there",
		"  WHY   - the specific symptom it removes",
		"",
		"Then make exactly those changes, in that order, and nothing else. Do not fix anything you did not declare. Do not rewrite a whole function or a whole file: edit the smallest region that removes the symptom.",
		"",
	];

	if (input.oracle) {
		lines.push(
			`When you are done, run \`${input.oracle.label}\` and read what it says.`,
			"",
			`That command is what decides. It is run again when your turn ends, and ${describeOracleStandard(input.oracle)} — not your account of the change, and not the fact that the edit applied. ${describeOracleChoice(input.oracle)}`,
			"",
			`If it passes, ${label} is kept and the task is finished.`,
			"",
			`If it does not, every change in ${label} is discarded. The files go back to exactly what they were when ${label} opened, and you get a new transaction with a record of what this one tried. You will never be asked to undo an edit yourself — that is done for you, mechanically, before the next transaction starts.`,
		);
	} else {
		lines.push(
			"Nothing in this workspace can be run to check the change, so you are the check.",
			"",
			`When you are done, say plainly whether the change achieved what was asked, and how you know. Answering "yes" because the edit applied is not knowing. If you cannot tell, say that instead — ${label} is then discarded and you get another transaction rather than a change nobody verified.`,
			"",
			`If it worked, ${label} is kept. If it did not, every change in it is discarded and the files go back to exactly what they were when it opened.`,
		);
	}

	lines.push(
		"",
		`${input.maxChanges} is a hard limit and not a target. One change that removes one symptom is a better transaction than ${input.maxChanges} that might.`,
	);

	if (input.history.length > 0) {
		lines.push("", describeHistory(input.history));
	}

	return lines.join("\n");
}

/**
 * What the command has to do for the transaction to be kept.
 *
 * Said explicitly when a pattern is set, because the two standards lead to
 * different work: a model told only "make it exit zero" against a check that
 * always exits zero has been told nothing at all.
 */
function describeOracleStandard(oracle: Oracle): string {
	return oracle.expect
		? `the verdict is that it finishes cleanly AND its output matches /${oracle.expect}/`
		: "its exit status is the verdict";
}

function describeOracleChoice(oracle: Oracle): string {
	return oracle.reason === "named for this task"
		? "It was named for this task, so it is the standard the change is held to."
		: `It was chosen because ${oracle.reason}.`;
}

/**
 * What the earlier transactions tried, carried into this one.
 *
 * The record is the only thing that makes a second attempt different from a
 * first. Without it a rolled-back transaction is indistinguishable from never
 * having happened, and the model re-derives the same plan from the same
 * starting file — measured on the harness before the record was added.
 */
function describeHistory(history: readonly TransactionOutcome[]): string {
	const lines = ["== WHAT EARLIER TRANSACTIONS TRIED =="];
	for (const outcome of history) {
		const label = `TX-${String(outcome.transaction).padStart(2, "0")}`;
		lines.push(
			"",
			`${label} — ${outcome.kept ? "kept" : "discarded"}${
				outcome.source === "self-declared" ? " (no check available)" : ""
			}`,
		);
		if (outcome.plan?.trim()) {
			lines.push("plan:", outcome.plan.trim());
		}
		if (outcome.account?.trim()) {
			lines.push("you said:", outcome.account.trim());
		}
		if (outcome.evidence.trim()) {
			lines.push("result:", outcome.evidence.trim());
		}
	}
	lines.push(
		"",
		"Those changes are gone: the files are as they were before that transaction. Do not repeat a plan that has already been discarded — if the same symptom is still there, the previous reading of it was wrong.",
	);
	return lines.join("\n");
}

/**
 * What the model is told when it ends a transaction it never changed.
 *
 * Not the protocol rules again. The rules are already in the window — it read
 * them when the transaction opened and followed none of them — so restating
 * them buys another few hundred tokens of the same. What it has not been told
 * is the only thing that is new: that the submission was empty, that this cost
 * it nothing, and that giving up out loud is a better end than five more of
 * these.
 */
export function buildEmptyAttemptPrompt(input: {
	transaction: number;
	maxChanges: number;
}): string {
	const label = `TX-${String(input.transaction).padStart(2, "0")}`;
	return [
		"== NOTHING WAS CHANGED ==",
		"",
		`You ended ${label} without editing a single file, so there was nothing to judge. The transaction was not spent and is still open.`,
		"",
		`If you know what to change, state the plan as before — AT MOST ${input.maxChanges} changes, each with WHERE, WHAT and WHY — and then make it.`,
		"",
		"If you have run out of ideas, say so plainly in one sentence and stop. Ending the run and saying why is worth more than another empty transaction, and it is not counted against you.",
	].join("\n");
}

/**
 * The line an empty submission ends on, for the user and for the log.
 *
 * Worth a line of its own precisely because it is not a verdict: no check ran,
 * nothing was put back, and a run where this happened reads — from the
 * transcript alone — like a transaction that quietly went missing.
 */
export function describeEmptyAttempt(
	transaction: number,
	continued: boolean,
): string {
	const label = `TX-${String(transaction).padStart(2, "0")}`;
	return continued
		? `${label} was submitted with nothing changed, so it was not spent and is still open.`
		: `${label} was submitted with nothing changed again, so the run is stopping rather than spending the transactions it has left.`;
}

/**
 * The line a transaction ends on, for the user and for the log.
 *
 * Says which of the two things happened to their files, because "discarded" is
 * the word that matters and it has to be unmissable.
 */
export function describeVerdict(
	transaction: number,
	kept: boolean,
	source: TransactionVerdictSource,
	verdict?: OracleVerdict,
): string {
	const label = `TX-${String(transaction).padStart(2, "0")}`;
	if (kept) {
		return source === "oracle"
			? `${label} kept — the check passed.`
			: `${label} kept — self-declared, nothing here could check it.`;
	}
	if (source === "self-declared") {
		return `${label} discarded — the change was not verified. Your files are back as they were.`;
	}
	if (verdict?.timedOut) {
		return `${label} discarded — the check did not finish. Your files are back as they were.`;
	}
	// Named apart from a crash: "it ran and reported a problem" reads nothing
	// like "it fell over", and the model's next move differs between the two.
	if (verdict?.unmatched) {
		return `${label} discarded — the check ran, and what it reported is not what this task counts as working. Your files are back as they were.`;
	}
	if (verdict?.exitCode == null) {
		return `${label} discarded — the check could not be run at all, so nothing was verified. Your files are back as they were.`;
	}
	return `${label} discarded — the check failed (exit ${verdict.exitCode}). Your files are back as they were.`;
}
