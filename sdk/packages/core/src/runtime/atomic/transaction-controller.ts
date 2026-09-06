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
	/** A check was proposed, approved and taken on for the rest of the run. */
	| { type: "adopted"; transaction: number; oracle: Oracle }
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
	/**
	 * Whether the model may name its own check while there is none.
	 *
	 * Set by the host that has somewhere to ask the user. It stops mattering
	 * the moment a check exists, since one is frozen once taken on.
	 */
	allowCheckProposal?: boolean;
	/**
	 * Discarded attempts before a check that has never passed may be replaced.
	 *
	 * Zero, or absent, is the freeze as it was. See `checkIsUnderReconsideration`
	 * for the condition and why it is scoped the way it is.
	 */
	checkReconsideredAfter?: number;
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
	private adopted?: Oracle;
	/** Whether the adopted check has ever passed, on any files, since adoption. */
	private adoptedEverPassed = false;
	/** Attempts that changed something and were thrown away, since adoption. */
	private discardedSinceAdoption = 0;
	/** Open while the model may replace a check that has never passed. Once. */
	private reconsidering = false;
	private reconsiderationsUsed = 0;

	constructor(private readonly options: TransactionControllerOptions) {}

	/** One-based number of the open transaction, or 0 before the first opens. */
	get transaction(): number {
		return this.current;
	}

	/** The check that judges this run, however it came by one. */
	get oracle(): Oracle | undefined {
		return this.adopted ?? this.options.oracle;
	}

	/**
	 * Whether a check can still be taken on — which is only ever while there is
	 * none. See `adoptOracle`.
	 */
	get canAdoptOracle(): boolean {
		return this.oracle === undefined || this.reconsidering;
	}

	/**
	 * Whether the check the model named is currently up for replacement.
	 *
	 * Scoped to a check the model proposed and nothing else: `adopted` is set
	 * only by `adoptOracle`, and `options.oracle` being absent is what says
	 * discovery found nothing to run. A check the user wrote, or one detected
	 * in the tree, is the specification and is never reconsidered — it is not
	 * the model's to disagree with.
	 *
	 * The condition is "it has never passed once, across attempts that really
	 * changed something". That is the only observable separating a check that
	 * cannot pass from a task that is hard, and measured over ten runs the two
	 * that died looked like this from the first transaction onward.
	 */
	get checkIsUnderReconsideration(): boolean {
		return this.reconsidering;
	}

	/**
	 * Take a check for the rest of the run, once.
	 *
	 * For a check the model proposed and the user approved, in a workspace
	 * where discovery found nothing. It can only ever be set while there is no
	 * check at all, and that is the freeze: a model allowed to re-propose after
	 * a transaction fails will weaken the check until one passes, which is an
	 * elaborate way of arriving back at `self-declared`. Replacing it costs a
	 * new session, not a tool call.
	 */
	adoptOracle(oracle: Oracle): void {
		if (!this.canAdoptOracle) {
			throw new Error(
				"This run already has a check, and it is frozen for the rest of the run.",
			);
		}
		this.adopted = oracle;
		// A replacement starts its own record. Carrying the old check's failures
		// forward would arm reconsideration again immediately, and it gets one.
		this.adoptedEverPassed = false;
		this.discardedSinceAdoption = 0;
		if (this.reconsidering) {
			this.reconsidering = false;
			this.reconsiderationsUsed += 1;
		}
		this.emit({ type: "adopted", transaction: this.current, oracle });
	}

	/**
	 * Run a candidate check against the files as this transaction found them.
	 *
	 * The question a proposed check has to answer before it is trusted: does it
	 * fail on the unmodified files? A check that already passes there is not a
	 * check of anything — `echo ok`, `node --version`, a test that never
	 * touches the bug — and approving one produces `self-declared` with a
	 * ceremony around it. Failing first and passing after is the definition of
	 * a regression test, and it is the property this enforces.
	 *
	 * Where nothing has been edited yet, the working tree *is* the base and it
	 * is simply run. Where something has, the base is put back for the length
	 * of the run and the edits are put back after it — the same restore the
	 * protocol performs on a discarded transaction, in both directions, with
	 * the return leg in a `finally` so a check that throws cannot cost the
	 * model its work.
	 */
	async judgeAgainstBase(oracle: Oracle): Promise<OracleVerdict> {
		const base = this.snapshot;
		if (!base) {
			throw new Error(
				"judgeAgainstBase() was called before a transaction was opened",
			);
		}
		const timeoutMs = this.options.oracleTimeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS;
		if (await snapshotIsClean(base, this.options.snapshotLimits)) {
			return await runOracle(oracle, { timeoutMs });
		}

		const edited = await takeSnapshot(
			this.options.workspaceRoot,
			this.options.snapshotLimits,
		);
		await restoreSnapshot(base, this.options.snapshotLimits);
		try {
			return await runOracle(oracle, { timeoutMs });
		} finally {
			await restoreSnapshot(edited, this.options.snapshotLimits);
		}
	}

	/**
	 * Run the check against the working tree, and settle nothing.
	 *
	 * The check the transaction is judged by was reachable from exactly one
	 * place -- `settle`, at the completion attempt -- so a model working under
	 * it got no verdict until the transaction was over, and a failing one threw
	 * the whole transaction away. Measured on a live run: 341 messages and 65
	 * edits with no check result, then one `SyntaxError` and a full rollback,
	 * after which the model restored the original file and started again.
	 *
	 * The arm that works never had this problem, because there the check is a
	 * shell line named in the prompt and the model simply reruns it -- 88 times
	 * in one successful run. This is that, for a check the model cannot type.
	 */
	async runCheck(): Promise<OracleVerdict> {
		if (!this.snapshot) {
			throw new Error("runCheck() was called before a transaction was opened");
		}
		const oracle = this.oracle;
		if (!oracle) {
			throw new Error("runCheck() was called with no check to run");
		}
		const verdict = await runOracle(oracle, {
			timeoutMs: this.options.oracleTimeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS,
		});
		// A pass here is the whole answer to "can this check ever pass", and it
		// counts wherever it happened -- a check the model satisfied once and
		// then broke again is not a check that cannot be satisfied.
		if (verdict.passed) {
			this.adoptedEverPassed = true;
		}
		return verdict;
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
	/**
	 * Whether this transaction should offer the model its check back.
	 *
	 * Every clause earns its place. The check must be the model's own; it must
	 * never have passed; enough attempts must have really been thrown away to
	 * rule out an unlucky one; it can happen once; and there has to be a
	 * transaction left after this one, or a replacement judges nothing.
	 *
	 * The threshold is bounded by `maxTransactions` because that is a setting:
	 * a fixed two would fire on the last attempt of a three-attempt task and be
	 * useless there.
	 */
	private shouldReconsiderCheck(): boolean {
		const after = this.options.checkReconsideredAfter ?? 0;
		if (after <= 0) {
			return false;
		}
		if (this.adopted === undefined || this.options.oracle !== undefined) {
			return false;
		}
		if (this.adoptedEverPassed || this.reconsiderationsUsed > 0) {
			return false;
		}
		if (this.current >= this.options.maxTransactions) {
			return false;
		}
		const threshold = Math.max(
			1,
			Math.min(after, this.options.maxTransactions - 1),
		);
		return this.discardedSinceAdoption >= threshold;
	}

	async open(): Promise<string> {
		this.current += 1;
		this.reconsidering = this.shouldReconsiderCheck();
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
			oracle: this.oracle,
		});
		return buildProtocolPrompt({
			transaction: this.current,
			maxChanges: this.options.maxChanges,
			maxTransactions: this.options.maxTransactions,
			oracle: this.oracle,
			canProposeCheck:
				this.options.allowCheckProposal === true && this.canAdoptOracle,
			checkNeverPassed: this.adopted !== undefined && !this.adoptedEverPassed,
			canReplaceCheck:
				this.options.allowCheckProposal === true && this.reconsidering,
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
		this.emit({ type: "judging", transaction, oracle: this.oracle });

		// Three sources, not two. Silence still keeps the files -- see
		// judgeSelfReport -- but it is not a judgement, and reporting it as one
		// is what sends a user hunting the transcript for a claim nobody made.
		//
		// "Declared" is having said anything at all, not having said a phrase
		// this recognises. readSelfReport only looks for *doubt*, on the
		// grounds that a model ending a run is already asserting it is done, so
		// a confident closing line comes back as `undefined` exactly like
		// silence does. Reading those two the same way is what made a run that
		// ended "Task is finished - the file loads with zero errors" report
		// itself as never having said whether the change worked.
		const declared =
			report.selfReport !== undefined || Boolean(report.account?.trim());
		const source: TransactionVerdictSource = this.oracle
			? "oracle"
			: declared
				? "self-declared"
				: "undeclared";
		let kept: boolean;
		let verdict: OracleVerdict | undefined;
		let evidence: string;

		if (this.oracle) {
			verdict = await runOracle(this.oracle, {
				timeoutMs: this.options.oracleTimeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS,
			});
			kept = verdict.passed;
			evidence = verdict.output;
			if (verdict.passed) {
				this.adoptedEverPassed = true;
			}
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

		// Only an attempt that changed something is evidence about the check.
		// Counting an empty transaction would let a model that edits nothing
		// buy its way back to a fresh proposal, which is the weakening this
		// protocol exists to prevent.
		if (
			this.adopted !== undefined &&
			!(await snapshotIsClean(snapshot, this.options.snapshotLimits))
		) {
			this.discardedSinceAdoption += 1;
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
