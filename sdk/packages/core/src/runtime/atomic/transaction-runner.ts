import {
	DEFAULT_ORACLE_TIMEOUT_MS,
	type Oracle,
	type OracleVerdict,
	runOracle,
} from "./oracle";
import {
	buildProtocolPrompt,
	describeVerdict,
	type TransactionOutcome,
} from "./protocol";
import {
	type RestoreReport,
	restoreSnapshot,
	type Snapshot,
	type SnapshotLimits,
	snapshotIsClean,
	takeSnapshot,
} from "./snapshot";

/** What the model said about its own change, where nothing else could say it. */
export type SelfReport = "success" | "failure" | "unsure";

export interface AttemptContext {
	/** One-based number of the transaction being attempted. */
	transaction: number;
	/** The rules and the record of earlier transactions, to put to the model. */
	protocolPrompt: string;
	/** The check that will decide, when there is one. */
	oracle?: Oracle;
}

export interface AttemptResult {
	/** The plan as the model declared it, carried forward if this one fails. */
	plan?: string;
	/**
	 * The model's own verdict, where there is no oracle. `undefined` means it
	 * never gave one — which is different from saying it could not tell.
	 */
	selfReport?: SelfReport;
	/** The model's closing account, kept as the record when there is no oracle. */
	summary?: string;
	/** The turn ended without the model finishing: cancelled, or out of budget. */
	aborted?: boolean;
}

/**
 * Run one transaction's worth of work and return when the turn ends.
 *
 * The turn ending IS the transaction boundary. There is deliberately no tool
 * the model calls to close a transaction: a model that forgets to call it would
 * leave the transaction open and every change in it unjudged, which turns a
 * forgotten tool call into silently discarded work. A boundary the host owns
 * cannot be forgotten.
 */
export type RunAttempt = (context: AttemptContext) => Promise<AttemptResult>;

export interface AtomicTaskOptions {
	workspaceRoot: string;
	/** Hard limit on changes declared per transaction. */
	maxChanges: number;
	/** Transactions this task gets before it stops. */
	maxTransactions: number;
	/** The check that decides, or nothing when the workspace has none. */
	oracle?: Oracle;
	oracleTimeoutMs?: number;
	snapshotLimits?: SnapshotLimits;
	/**
	 * Asked once, and only when a model with no oracle ended its turn without
	 * saying whether the change worked. See `judgeSelfReport`.
	 */
	confirm?: (transaction: number) => Promise<SelfReport | undefined>;
	onEvent?: (event: TransactionEvent) => void;
}

export type TransactionEvent =
	| { type: "opened"; transaction: number; oracle?: Oracle }
	| { type: "judging"; transaction: number; oracle?: Oracle }
	| {
			type: "settled";
			transaction: number;
			kept: boolean;
			message: string;
			verdict?: OracleVerdict;
			restore?: RestoreReport;
	  };

export interface AtomicTaskResult {
	/** Whether a transaction was kept. */
	succeeded: boolean;
	/** Every transaction, in order, kept or not. */
	transactions: TransactionOutcome[];
	/** Why the task stopped. */
	stopped: "kept" | "exhausted" | "aborted";
	/**
	 * Set when the task was cut short mid-transaction. The changes are still on
	 * disk and this is what puts them back, so the host can offer that as a
	 * choice rather than the runner making it.
	 */
	pending?: Snapshot;
	/** Files no snapshot could cover, so nobody assumes they were protected. */
	uncovered: string[];
}

/**
 * The protocol: snapshot, change, judge, keep or put back — bounded.
 *
 * The rollback is the part that has to be right. Cline's checkpoints cannot
 * serve it (they require a git work tree and throw without one), so this uses
 * the copy-and-checksum snapshot next door, and no transaction is judged on
 * anything but a command's exit status wherever a command can be found.
 */
export async function runAtomicTask(
	options: AtomicTaskOptions,
	attempt: RunAttempt,
): Promise<AtomicTaskResult> {
	const history: TransactionOutcome[] = [];
	const uncovered = new Set<string>();
	const emit = options.onEvent ?? (() => {});

	for (
		let transaction = 1;
		transaction <= options.maxTransactions;
		transaction++
	) {
		const snapshot = await takeSnapshot(
			options.workspaceRoot,
			options.snapshotLimits,
		);
		for (const skipped of snapshot.skipped) {
			uncovered.add(skipped);
		}
		emit({ type: "opened", transaction, oracle: options.oracle });

		const result = await attempt({
			transaction,
			protocolPrompt: buildProtocolPrompt({
				transaction,
				maxChanges: options.maxChanges,
				maxTransactions: options.maxTransactions,
				oracle: options.oracle,
				history,
			}),
			oracle: options.oracle,
		});

		// A cancelled turn is not a failed transaction. Rolling back here would
		// destroy work the user interrupted for their own reasons, so the changes
		// stay and the snapshot goes back to the host to offer as a choice.
		if (result.aborted) {
			return {
				succeeded: false,
				transactions: history,
				stopped: "aborted",
				pending: snapshot,
				uncovered: [...uncovered],
			};
		}

		emit({ type: "judging", transaction, oracle: options.oracle });

		let kept: boolean;
		let verdict: OracleVerdict | undefined;
		let evidence: string;
		const source = options.oracle ? "oracle" : "self-declared";

		if (options.oracle) {
			verdict = await runOracle(options.oracle, {
				timeoutMs: options.oracleTimeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS,
			});
			kept = verdict.passed;
			evidence = verdict.output;
		} else {
			const report =
				result.selfReport ??
				(await options.confirm?.(transaction)) ??
				undefined;
			kept = judgeSelfReport(report);
			evidence =
				report === undefined
					? `${result.summary ?? ""}\n\nThe change was never stated to work or not, and nothing here could check it.`.trim()
					: (result.summary ?? "");
		}

		// Nothing changed and the check passes: the task was already done, or the
		// model did nothing. Either way it is kept, and the caller is told which.
		const untouched = kept ? await snapshotIsClean(snapshot) : false;

		let restore: RestoreReport | undefined;
		if (!kept) {
			restore = await restoreSnapshot(snapshot, options.snapshotLimits);
			for (const path of restore.uncovered) {
				uncovered.add(path);
			}
		}

		const outcome: TransactionOutcome = {
			transaction,
			kept,
			source,
			plan: result.plan,
			evidence,
		};
		history.push(outcome);

		emit({
			type: "settled",
			transaction,
			kept,
			message: untouched
				? `${describeVerdict(transaction, kept, source, verdict)} No files were changed.`
				: describeVerdict(transaction, kept, source, verdict),
			verdict,
			restore,
		});

		if (kept) {
			return {
				succeeded: true,
				transactions: history,
				stopped: "kept",
				uncovered: [...uncovered],
			};
		}
	}

	return {
		succeeded: false,
		transactions: history,
		stopped: "exhausted",
		uncovered: [...uncovered],
	};
}

/**
 * Whether a model's own account of its change is enough to keep it.
 *
 * The three answers are not symmetric. "It worked" keeps; "it did not" and "I
 * cannot tell" both discard, because a model that reports its own doubt has
 * given real evidence about the change.
 *
 * Saying nothing at all is a fourth thing and is treated as none of them. It is
 * a reporting failure, not a statement about the change, and discarding real
 * work over a line the model forgot to write is precisely the failure a host
 * owned boundary exists to avoid. So silence keeps the change and labels it
 * unverified, where the user can see the diff and decide.
 */
export function judgeSelfReport(report: SelfReport | undefined): boolean {
	if (report === undefined) return true;
	return report === "success";
}
