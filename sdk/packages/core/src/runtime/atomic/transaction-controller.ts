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
	snapshotChanges,
	snapshotIsClean,
	takeSnapshot,
} from "./snapshot";
import {
	describeUnparseableChange,
	looksLikeSyntaxError,
} from "./unparseable-change";

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
			/**
			 * Whether the work stayed on disk instead of being rolled back.
			 *
			 * See `carriedOn` on the controller. `restore` is empty when this is
			 * set -- nothing was put back, so there is nothing to report.
			 */
			carried?: boolean;
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
	/**
	 * The plan for this transaction, the first time one is seen.
	 *
	 * `from` says where it was found. A plan stated in the reply is already in
	 * front of the user; one found in the reasoning is not, and is the reason
	 * this event exists — the protocol asks for the plan in the reply and a 9B
	 * put it in its reasoning four times out of four, so nothing downstream
	 * ever saw it.
	 */
	| {
			type: "plan";
			transaction: number;
			plan: string;
			from: "reply" | "reasoning";
	  }
	| {
			type: "settled";
			transaction: number;
			kept: boolean;
			/** Not kept, and not rolled back either: the check's answer moved. */
			carried?: boolean;
			/**
			 * Who judged it. A consumer counting successes has to be able to
			 * separate "the check passed" from "nothing checked and nobody
			 * said" -- both arrive here as `kept: true`.
			 */
			source: TransactionVerdictSource;
			message: string;
			/**
			 * Wall-clock from `open()` to this settlement.
			 *
			 * The settlement line said what happened to the transaction and
			 * never how long it took, so a run that looped for forty minutes
			 * and one that landed first try read identically in the transcript
			 * -- and the completion message above it carries no time either, so
			 * there was nowhere else to look.
			 */
			elapsedMs?: number;
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
	/**
	 * Something for the last transaction's opening prompt, asked for once.
	 *
	 * The host's, and opaque here: this is where the escalation offer is said,
	 * and the protocol does not know what an expert is.
	 */
	describeLastTransaction?: () => string | undefined;
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
	/** What a rollback goes back to. Outlives a transaction that was carried. */
	private snapshot?: Snapshot;
	/**
	 * The tree as the open transaction found it.
	 *
	 * The same object as `snapshot` in the ordinary case, and older than it
	 * after a carry -- "has this transaction changed anything" and "what does a
	 * rollback undo" stop being the same question once work outlives the
	 * transaction that made it.
	 */
	private openedWith?: Snapshot;
	private current = 0;
	/** When the open transaction started, for the settlement line. */
	private openedAt: number | undefined;
	private adopted?: Oracle;
	/** Whether the adopted check has ever passed, on any files, since adoption. */
	private adoptedEverPassed = false;
	/** Attempts that changed something and were thrown away, since adoption. */
	private discardedSinceAdoption = 0;
	/** Open while the model may replace a check that has never passed. Once. */
	private reconsidering = false;
	/**
	 * Every distinct thing this run's check has said, and whether it has ever
	 * said the same thing twice.
	 *
	 * The repeat is what makes the novelty mean anything. A check that prints a
	 * duration, a timestamp or a seed says something new every single time it
	 * runs, and treating that as evidence the edits are landing would tell a
	 * model its work was progressing while nothing moved -- the same trap
	 * `describeStuckHostCheck` documents from the other direction. A check that
	 * has repeated itself once is demonstrably deterministic on the path it
	 * takes, and only then is "it has never said this before" a fact about the
	 * files rather than about the clock.
	 */
	private readonly checkOutputs = new Set<string>();
	private checkHasRepeated = false;
	/** Set by a carried settlement, so the next `open` keeps the older base. */
	private carrying = false;
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
	 * Record what the check just said, and answer whether it is new.
	 *
	 * One funnel for every run of the oracle in this controller, so the record
	 * covers the checks the model asked for as well as the ones that judged a
	 * transaction.
	 */
	private noteCheckOutput(output: string): boolean {
		const key = output.trim();
		if (this.checkOutputs.has(key)) {
			this.checkHasRepeated = true;
			return false;
		}
		this.checkOutputs.add(key);
		return true;
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
		this.noteCheckOutput(verdict.output);
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
		return this.openedWith
			? await snapshotIsClean(this.openedWith, this.options.snapshotLimits)
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
		this.openedAt = Date.now();
		this.reconsidering = this.shouldReconsiderCheck();
		// A carried transaction leaves its work on disk and its base behind it:
		// the rollback target stays where it was, so a later discard puts back
		// everything since the last verified state rather than only the last
		// attempt. Unverified work never accumulates past one discard.
		const carriedBase = this.carrying ? this.snapshot : undefined;
		this.carrying = false;
		this.openedWith = await takeSnapshot(
			this.options.workspaceRoot,
			this.options.snapshotLimits,
		);
		this.snapshot = carriedBase ?? this.openedWith;
		for (const skipped of this.openedWith.skipped) {
			this.uncoveredPaths.add(skipped);
		}
		this.emit({
			type: "opened",
			transaction: this.current,
			oracle: this.oracle,
		});
		const lastTransactionNotice =
			this.current >= this.options.maxTransactions
				? this.options.describeLastTransaction?.()
				: undefined;
		return buildProtocolPrompt({
			transaction: this.current,
			maxChanges: this.options.maxChanges,
			maxTransactions: this.options.maxTransactions,
			...(lastTransactionNotice ? { lastTransactionNotice } : {}),
			oracle: this.oracle,
			canProposeCheck:
				this.options.allowCheckProposal === true && this.canAdoptOracle,
			checkNeverPassed: this.adopted !== undefined && !this.adoptedEverPassed,
			// A check the host supplied rather than one the model proposed.
			// `checkNeverPassed` above cannot see this case at all -- `adopted`
			// is only set by `adoptOracle()` -- so a host check that failed every
			// attempt was reported as one that had never been questioned, and the
			// model was told its reading of the symptom was wrong once per
			// transaction while the check said the same thing each time.
			hostSuppliedCheck:
				this.adopted === undefined && this.options.oracle !== undefined,
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
		const openedWith = this.openedWith ?? snapshot;
		const transaction = this.current;
		const elapsedMs =
			this.openedAt === undefined ? undefined : Date.now() - this.openedAt;
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

		// Whether the check said something it has not said before in this run.
		// Read before the output is recorded, and only ever meaningful once the
		// check has repeated itself at least once -- see `checkOutputs`.
		let moved = false;

		if (this.oracle) {
			verdict = await runOracle(this.oracle, {
				timeoutMs: this.options.oracleTimeoutMs ?? DEFAULT_ORACLE_TIMEOUT_MS,
			});
			moved = this.noteCheckOutput(verdict.output);
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
			? await snapshotIsClean(openedWith, this.options.snapshotLimits)
			: false;

		if (kept) {
			const line = describeVerdict(
				transaction,
				kept,
				source,
				verdict,
				report.forced === true,
			);
			const message = untouched ? `${line} No files were changed.` : line;
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
				elapsedMs,
				verdict,
			});
			return { kept: true, message, verdict };
		}

		// Whether this may end as a carry rather than a rollback. Everything
		// here is cheap and none of it touches the disk, so the snapshot compare
		// below is still only taken where something needs the answer.
		//
		// Never forced: a settlement the guard or the user imposed is not the
		// model reaching a new reading, and the stalled-check guard fires
		// precisely when the check has stopped moving. Never the last
		// transaction either -- there is no next one to start from, and a run
		// that ended by leaving unverified work on disk would be worse than one
		// that put the files back.
		const mayCarry =
			moved &&
			this.checkHasRepeated &&
			report.forced !== true &&
			transaction < this.options.maxTransactions;

		// Only an attempt that changed something is evidence about the check.
		// Counting an empty transaction would let a model that edits nothing
		// buy its way back to a fresh proposal, which is the weakening this
		// protocol exists to prevent.
		const changedSomething =
			this.adopted !== undefined || mayCarry
				? !(await snapshotIsClean(openedWith, this.options.snapshotLimits))
				: false;
		if (this.adopted !== undefined && changedSomething) {
			this.discardedSinceAdoption += 1;
		}

		// A check whose answer moved is not a failed hypothesis. Measured on the
		// pandorum run of 2026-09-13: the fix needed three separate repairs on
		// three lines, each one found because the previous had changed what the
		// parser complained about. Under a plain rollback each of those would
		// have gone back and been re-derived from the same starting file, which
		// is what the protocol-armed runs of the same task spend their clock on
		// -- 189 and 177 edits against 33, and 26 and 35 rollbacks.
		const carried = mayCarry && changedSomething;
		this.carrying = carried;

		const line = describeVerdict(
			transaction,
			kept,
			source,
			verdict,
			report.forced === true,
			carried,
		);
		const message = untouched ? `${line} No files were changed.` : line;

		// Asked while the files are still on disk. One call later they are not,
		// and the answer -- that the check measured a file no engine would run
		// -- is the difference between a plan the model reconsiders and a typo
		// it retypes.
		const unparseable = looksLikeSyntaxError(evidence)
			? describeUnparseableChange(
					(await snapshotChanges(snapshot, this.options.snapshotLimits)).map(
						(change) => ({
							path: change.path,
							text: change.body.toString("utf8"),
						}),
					),
					snapshot.root,
				)
			: null;
		const discarded = unparseable ? `${message}\n\n${unparseable}` : message;

		const restore: RestoreReport = carried
			? { restored: [], removed: [], recreated: [], uncovered: [] }
			: await restoreSnapshot(snapshot, this.options.snapshotLimits);
		for (const filePath of restore.uncovered) {
			this.uncoveredPaths.add(filePath);
		}
		this.history.push({
			transaction,
			kept,
			carried,
			source,
			plan: report.plan,
			account: report.account,
			evidence,
		});
		this.emit({
			type: "settled",
			transaction,
			kept,
			carried,
			source,
			message: discarded,
			elapsedMs,
			verdict,
			restore,
		});

		if (transaction >= this.options.maxTransactions) {
			this.snapshot = undefined;
			this.openedWith = undefined;
			return { kept: false, message: discarded, verdict, restore };
		}
		return {
			kept: false,
			message: discarded,
			verdict,
			carried,
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
		this.openedWith = undefined;
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
