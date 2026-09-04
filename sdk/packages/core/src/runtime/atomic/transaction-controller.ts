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
	type TransactionVerdictSource,
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

export interface TransactionReport {
	/** The plan as the model declared it, carried forward if this one fails. */
	plan?: string;
	/** What the model said when it tried to end the turn. */
	account?: string;
	/**
	 * The model's own verdict, where there is no oracle. `undefined` means it
	 * never gave one — which is not the same as saying it could not tell.
	 */
	selfReport?: SelfReport;
	/**
	 * The run is ending because the no-tool-call nudges ran out, not because the
	 * model chose to stop. It changes what silence means: a model cut off
	 * mid-work has not declined to report, it never got to.
	 */
	forced?: boolean;
}

export type TransactionSettlement =
	| { kept: true; message: string; verdict?: OracleVerdict }
	| {
			kept: false;
			message: string;
			verdict?: OracleVerdict;
			restore: RestoreReport;
			/** The next transaction's rules and record, or nothing when out of them. */
			nextPrompt?: string;
	  };

export type TransactionEvent =
	| { type: "opened"; transaction: number; oracle?: Oracle }
	| { type: "judging"; transaction: number; oracle?: Oracle }
	/**
	 * A transaction the model tried to end without changing anything.
	 *
	 * Not a settlement: nothing was judged and nothing was put back, so it
	 * carries no verdict. `continued` says which of the two things happened —
	 * the transaction was handed back to the model, or the run was let go.
	 */
	| {
			type: "empty";
			transaction: number;
			message: string;
			continued: boolean;
	  }
	| {
			type: "settled";
			transaction: number;
			kept: boolean;
			/**
			 * Who judged it. A consumer counting successes has to be able to
			 * separate "the check passed" from "nothing checked and nobody
			 * said" -- both arrive here as `kept: true`.
			 */
			source: TransactionVerdictSource;
			message: string;
			verdict?: OracleVerdict;
			restore?: RestoreReport;
	  };

export interface TransactionControllerOptions {
	workspaceRoot: string;
	/** Hard limit on changes declared per transaction. */
	maxChanges: number;
	/** Transactions this task gets before it stops. */
	maxTransactions: number;
	/** The check that decides, or nothing when the workspace has none. */
	oracle?: Oracle;
	oracleTimeoutMs?: number;
	snapshotLimits?: SnapshotLimits;
	onEvent?: (event: TransactionEvent) => void;
}

/**
 * The protocol as a state machine the host drives: snapshot, change, judge,
 * keep or put back — bounded.
 *
 * Written this way round because the boundary belongs to the host. The model
 * gets no tool to close a transaction with: one it forgot to call would leave
 * every change in that transaction unjudged, so a forgotten call would become
 * silently discarded work. A boundary the host owns cannot be forgotten — the
 * agent runtime asks this object at the moment the model tries to end its
 * turn, and the answer either lets it end or puts the files back and hands it
 * the next transaction.
 *
 * The rollback is the part that has to be right. Cline's checkpoints cannot
 * serve it — they require a git work tree and throw without one — so this uses
 * the copy-and-checksum snapshot next door instead.
 */
export class TransactionController {
	private readonly history: TransactionOutcome[] = [];
	private readonly uncoveredPaths = new Set<string>();
	private snapshot?: Snapshot;
	private current = 0;

	constructor(private readonly options: TransactionControllerOptions) {}

	/** One-based number of the open transaction, or 0 before the first opens. */
	get transaction(): number {
		return this.current;
	}

	/** Every transaction so far, in order, kept or not. */
	get outcomes(): readonly TransactionOutcome[] {
		return this.history;
	}

	/** Files no snapshot could hold, so nobody assumes they were protected. */
	get uncovered(): string[] {
		return [...this.uncoveredPaths];
	}

	/**
	 * The base the open transaction would roll back to, or nothing when none is
	 * open. What a host hands the user when a run is cut short mid-transaction.
	 */
	get pending(): Snapshot | undefined {
		return this.snapshot;
	}

	/** Whether the open transaction has changed anything on disk. */
	async isUntouched(): Promise<boolean> {
		return this.snapshot
			? await snapshotIsClean(this.snapshot, this.options.snapshotLimits)
			: true;
	}

	/**
	 * Take the base this transaction rolls back to, and return the rules to put
	 * to the model.
	 *
	 * Taken at the open of every transaction rather than once per task: a kept
	 * transaction becomes the base the next one rolls back to, which is what
	 * makes a sequence of them additive rather than a single undo point.
	 */
	async open(): Promise<string> {
		this.current += 1;
		this.snapshot = await takeSnapshot(
			this.options.workspaceRoot,
			this.options.snapshotLimits,
		);
		for (const skipped of this.snapshot.skipped) {
			this.uncoveredPaths.add(skipped);
		}
		this.emit({
			type: "opened",
			transaction: this.current,
			oracle: this.options.oracle,
		});
		return buildProtocolPrompt({
			transaction: this.current,
			maxChanges: this.options.maxChanges,
			maxTransactions: this.options.maxTransactions,
			oracle: this.options.oracle,
			history: this.history,
		});
	}

	/**
	 * Judge the open transaction, and keep it or put every file back.
	 *
	 * Called at the boundary — the model calling a completion tool, or ending a
	 * turn with nothing left to call. Both are the same event to this: the model
	 * believes it is done, which is exactly when its belief is worth checking.
	 */
	async settle(report: TransactionReport = {}): Promise<TransactionSettlement> {
		const snapshot = this.snapshot;
		if (!snapshot) {
			throw new Error("settle() was called before a transaction was opened");
		}
		const transaction = this.current;
		this.emit({ type: "judging", transaction, oracle: this.options.oracle });

		// Three sources, not two. Silence still keeps the files -- see
		// judgeSelfReport -- but it is not a judgement, and reporting it as one
		// is what sends a user hunting the transcript for a claim nobody made.
		const source: TransactionVerdictSource = this.options.oracle
			? "oracle"
			: report.selfReport === undefined
				? "undeclared"
				: "self-declared";
		let kept: boolean;
		let verdict: OracleVerdict | undefined;
		let evidence: string;

		if (this.options.oracle) {
			verdict = await runOracle(this.options.oracle, {
				timeoutMs: this.options.oracleTimeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS,
			});
			kept = verdict.passed;
			evidence = verdict.output;
		} else {
			kept = judgeSelfReport(report.selfReport);
			evidence =
				report.selfReport === undefined
					? "The change was never stated to work or not, and nothing here could check it."
					: "";
		}

		const untouched = kept
			? await snapshotIsClean(snapshot, this.options.snapshotLimits)
			: false;
		const line = describeVerdict(
			transaction,
			kept,
			source,
			verdict,
			report.forced === true,
		);
		const message = untouched ? `${line} No files were changed.` : line;

		if (kept) {
			this.history.push({
				transaction,
				kept,
				source,
				plan: report.plan,
				account: report.account,
				evidence,
			});
			this.emit({
				type: "settled",
				transaction,
				kept,
				source,
				message,
				verdict,
			});
			return { kept: true, message, verdict };
		}

		const restore = await restoreSnapshot(
			snapshot,
			this.options.snapshotLimits,
		);
		for (const filePath of restore.uncovered) {
			this.uncoveredPaths.add(filePath);
		}
		this.history.push({
			transaction,
			kept,
			source,
			plan: report.plan,
			account: report.account,
			evidence,
		});
		this.emit({
			type: "settled",
			transaction,
			kept,
			source,
			message,
			verdict,
			restore,
		});

		if (transaction >= this.options.maxTransactions) {
			this.snapshot = undefined;
			return { kept: false, message, verdict, restore };
		}
		return {
			kept: false,
			message,
			verdict,
			restore,
			nextPrompt: await this.open(),
		};
	}

	/**
	 * Put back what the open transaction changed, without judging it.
	 *
	 * For a run the user cut short. Offered rather than done: rolling back on a
	 * cancel would destroy work the user interrupted for their own reasons, so
	 * the host decides and this carries it out.
	 */
	async discard(): Promise<RestoreReport | undefined> {
		if (!this.snapshot) return undefined;
		const restore = await restoreSnapshot(
			this.snapshot,
			this.options.snapshotLimits,
		);
		this.snapshot = undefined;
		return restore;
	}

	private emit(event: TransactionEvent): void {
		this.options.onEvent?.(event);
	}
}

/**
 * Whether a model's own account of its change is enough to keep it.
 *
 * The three answers are not symmetric. "It worked" keeps; "it did not" and "I
 * cannot tell" both discard, because a model reporting its own doubt is real
 * evidence about the change.
 *
 * Saying nothing at all is a fourth thing and is treated as none of them. It is
 * a reporting failure, not a statement about the change, and discarding real
 * work over a line the model forgot to write is precisely the failure a
 * host-owned boundary exists to avoid. So silence keeps the change and labels
 * it unverified, where the user can see the diff and decide.
 */
export function judgeSelfReport(report: SelfReport | undefined): boolean {
	if (report === undefined) return true;
	return report === "success";
}
