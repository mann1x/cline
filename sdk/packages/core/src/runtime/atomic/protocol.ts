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
			`That command is what decides. It is run again when your turn ends, and its exit status is the verdict — not your account of the change, and not the fact that the edit applied. ${describeOracleChoice(input.oracle)}`,
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
	if (verdict?.exitCode == null) {
		return `${label} discarded — the check could not be run at all, so nothing was verified. Your files are back as they were.`;
	}
	return `${label} discarded — the check failed (exit ${verdict.exitCode}). Your files are back as they were.`;
}
