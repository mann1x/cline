/**
 * The one message that starts an escalation.
 *
 * The expert gets the brief, not the transcript. That is a decision, and worth
 * stating: handing over the conversation would be cheaper to write and worse in
 * both directions — it is the most expensive thing this feature can send, it
 * arrives as thousands of tokens of a stuck model's reasoning, and a fresh
 * model reading another model's dead ends adopts them. What the expert needs is
 * the task, the goal, the standard it will be held to, and the record of what
 * has already been tried and thrown away. Everything else it can read for
 * itself: it has the same tools.
 *
 * The record is the part that is not obvious. A discarded transaction leaves no
 * trace on disk — the files are byte-for-byte as they were before it — so an
 * expert told only "it is still broken" will re-derive the plan that was just
 * rolled back. The base model's own prompt carries this record for exactly that
 * reason; so does this.
 */
import { isPageOracle, type Oracle } from "../atomic/oracle";
import type { TransactionOutcome } from "../atomic/protocol";

/** What the open transaction looks like, when the change protocol is on. */
export interface EscalationTransactionState {
	/** One-based number of the open transaction. */
	transaction: number;
	maxTransactions: number;
	maxChanges: number;
	/** Changes already declared in it, when the host is counting them. */
	changesUsed?: number;
	/** The check the transaction will be judged by, when there is one. */
	oracle?: Oracle;
	/** What the base model said it would change in this transaction. */
	plan?: string;
	/** Transactions already tried and settled. */
	history: readonly TransactionOutcome[];
}

export interface EscalationBriefInput {
	/** What the base model wants done, in its own words. */
	goal: string;
	/** What it will accept as a correct delivery, in its own words. */
	expectation?: string;
	/** The task as the user stated it. */
	task?: string;
	workspaceRoot?: string;
	/** Files the base model has been working in, as workspace-relative paths. */
	filesInPlay?: readonly string[];
	transaction?: EscalationTransactionState;
	/**
	 * The harness's own reading of the code, when it has one.
	 *
	 * Attributed to the harness rather than folded into the goal, because it is
	 * the one piece of evidence here the base model did not write.
	 */
	assessment?: string;
	/** Which escalation this is, and how many this task gets. */
	escalation: { index: number; of: number };
	/** Follow-ups available after this delivery. */
	followUpsAllowed: number;
	/**
	 * Whether escalation took a snapshot of the workspace before handing over.
	 *
	 * Only with the change protocol off. With it on, the open transaction's own
	 * snapshot already covers the expert's edits and a second one would be a
	 * copy of a copy.
	 */
	snapshotTaken?: boolean;
}

function label(transaction: number): string {
	return `TX-${String(transaction).padStart(2, "0")}`;
}

function describeCheck(oracle: Oracle): string {
	if (isPageOracle(oracle)) {
		return `The check is: ${oracle.label}. It passes when the page loads, runs its frames and throws nothing.`;
	}
	return oracle.expect
		? `The check is \`${oracle.label}\`. It passes when it finishes cleanly AND its output matches /${oracle.expect}/.`
		: `The check is \`${oracle.label}\`. Its exit status is the verdict.`;
}

function describeTransaction(state: EscalationTransactionState): string[] {
	const lines = [
		`The work is inside ${label(state.transaction)}, of at most ${state.maxTransactions} transactions this task gets.`,
	];
	if (state.changesUsed === undefined) {
		lines.push(
			`A transaction carries at most ${state.maxChanges} changes. A change is an edit that lands; reading and running the check cost nothing.`,
		);
	} else {
		const left = Math.max(0, state.maxChanges - state.changesUsed);
		lines.push(
			`${state.changesUsed} of its ${state.maxChanges} changes have been used, so ${left} changes are left. A change is an edit that lands; reading and running the check cost nothing.`,
		);
	}
	if (state.oracle) {
		lines.push(describeCheck(state.oracle));
	}
	if (state.plan?.trim()) {
		lines.push(
			"",
			"It planned this, and it has not worked:",
			state.plan.trim(),
		);
	}
	return lines;
}

function describeHistory(history: readonly TransactionOutcome[]): string[] {
	const lines: string[] = [];
	for (const outcome of history) {
		lines.push(
			"",
			`${label(outcome.transaction)} — ${outcome.kept ? "kept" : "discarded"}`,
		);
		if (outcome.plan?.trim()) {
			lines.push(`plan: ${outcome.plan.trim()}`);
		}
		if (outcome.account?.trim()) {
			lines.push(`it said: ${outcome.account.trim()}`);
		}
		if (outcome.evidence.trim()) {
			lines.push(`result: ${outcome.evidence.trim()}`);
		}
	}
	lines.push(
		"",
		"Everything in a discarded transaction was put back: those files are as they were before it. Nothing of that work survives on disk, so do not read the code as evidence that it was never tried — and do not try it again.",
	);
	return lines;
}

/**
 * What happens to the expert's own edits, which depends on what is behind them.
 *
 * It has edit rights, so this is not background: an expert that does not know a
 * failing check throws its work away has no reason to run the check.
 */
function describeStakes(input: EscalationBriefInput): string[] {
	if (input.transaction) {
		return [
			`You can edit directly. Your changes go into ${label(input.transaction.transaction)} along with the base model's, they count against the same change budget, and they are judged together: if the check does not pass, every change in the transaction is rolled back — yours included — and the task gets the next transaction with a record of what this one tried.`,
			"So run the check before you hand back. A delivery that has not been run is a guess, and it costs the task a whole transaction to find that out.",
		];
	}
	if (input.snapshotTaken) {
		return [
			"You can edit directly. There is no transaction here: what you change stands, and the base model continues from the workspace you leave behind. A snapshot was taken of the workspace before this escalation, so the whole of it can be put back if your changes turn out to be wrong — but that is a rollback of everything, not of one edit.",
			"So verify what you change, and say plainly what you left in a state you are not sure about.",
		];
	}
	return [
		"You can edit directly. What you change stands, and the base model continues from the workspace you leave behind — there is no rollback behind you here, so verify what you change and say plainly what you left in a state you are not sure about.",
	];
}

function section(heading: string, body: readonly string[]): string[] {
	const kept = body.filter((line, index) => line.trim() || index > 0);
	if (!kept.some((line) => line.trim())) {
		return [];
	}
	return [`-- ${heading} --`, ...kept, ""];
}

export function buildEscalationBrief(input: EscalationBriefInput): string {
	const lines: string[] = [
		"== ESCALATION ==",
		"",
		`Another model is working on the task below and has handed it to you. It is not a user: it is a model with the same tools you have, in the same workspace, and it will read what you deliver and check it against what it asked for. Expect it to push back if the work does not hold up.`,
		"",
		`This is escalation ${input.escalation.index} of ${input.escalation.of} the task is allowed. After you deliver, it may come back to you at most ${input.followUpsAllowed} more times in this conversation, so a complete answer now is worth more than a fast one.`,
		"",
	];

	lines.push(...section("WHAT IT WANTS FROM YOU", [input.goal.trim()]));
	lines.push(
		...section(
			"WHAT IT WILL ACCEPT",
			input.expectation?.trim() ? [input.expectation.trim()] : [],
		),
	);
	lines.push(
		...section(
			"THE TASK, AS THE USER STATED IT",
			input.task?.trim() ? [input.task.trim()] : [],
		),
	);

	const whereLines: string[] = [];
	if (input.workspaceRoot?.trim()) {
		whereLines.push(`Workspace root: ${input.workspaceRoot.trim()}`);
	}
	if (input.filesInPlay?.length) {
		whereLines.push(
			"Files it has been working in (a starting point, not a boundary):",
			...input.filesInPlay.map((file) => `  ${file}`),
		);
	}
	lines.push(...section("WHERE THE WORK IS", whereLines));

	lines.push(
		...section(
			"WHAT THE HARNESS MEASURED",
			input.assessment?.trim()
				? [
						"Measured by the harness, not reported by the model that asked you:",
						input.assessment.trim(),
					]
				: [],
		),
	);

	if (input.transaction) {
		lines.push(
			...section(
				"THE OPEN TRANSACTION",
				describeTransaction(input.transaction),
			),
		);
		if (input.transaction.history.length > 0) {
			lines.push(
				...section(
					"WHAT EARLIER TRANSACTIONS TRIED",
					describeHistory(input.transaction.history),
				),
			);
		}
	}

	lines.push(...section("WHAT YOUR CHANGES ARE WORTH", describeStakes(input)));

	lines.push(
		...section("HOW TO DELIVER", [
			"Say what you changed, file by file, and why it is the fix rather than a way around the symptom.",
			"Say what you ran and what it printed. If you could not run anything, say that instead of implying you did.",
			"Say what you are unsure about. The model that asked you is going to check this; an honest reservation is worth more to it than a confident delivery it has to discover the hard way.",
		]),
	);

	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`;
}
