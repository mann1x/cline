import type { Oracle } from "./oracle";
import type { TransactionOutcome } from "./protocol";
import type { Snapshot, SnapshotLimits } from "./snapshot";
import {
	type SelfReport,
	TransactionController,
	type TransactionEvent,
} from "./transaction-controller";

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
	/** What the model said about the change when its turn ended. */
	account?: string;
	/**
	 * The model's own verdict, where there is no oracle. `undefined` means it
	 * never gave one — which is not the same as saying it could not tell.
	 */
	selfReport?: SelfReport;
	/** The turn ended without the model finishing: cancelled, or out of budget. */
	aborted?: boolean;
}

/**
 * Run one transaction's worth of work and return when the turn ends.
 *
 * The turn ending IS the transaction boundary, and the host owns it. There is
 * deliberately no tool the model calls to close a transaction: one it forgot to
 * call would leave every change in that transaction unjudged, which turns a
 * forgotten tool call into silently discarded work.
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

export interface AtomicTaskResult {
	/** Whether a transaction was kept. */
	succeeded: boolean;
	/** Every transaction, in order, kept or not. */
	transactions: TransactionOutcome[];
	/** Why the task stopped. */
	stopped: "kept" | "exhausted" | "aborted";
	/**
	 * Set when the task was cut short mid-transaction. The changes are still on
	 * disk and this puts them back, so the host can offer that as a choice
	 * rather than the runner making it.
	 */
	pending?: Snapshot;
	/** Files no snapshot could cover, so nobody assumes they were protected. */
	uncovered: string[];
}

/**
 * Drive a whole task through the protocol, for a host that owns the loop.
 *
 * The CLI and the tests are such hosts. The extension is not: there the agent
 * runtime owns the loop and calls {@link TransactionController} at the boundary
 * instead. Both go through the same controller, so the rules a change is held
 * to do not depend on which host is running it.
 */
export async function runAtomicTask(
	options: AtomicTaskOptions,
	attempt: RunAttempt,
): Promise<AtomicTaskResult> {
	const controller = new TransactionController(options);
	let prompt = await controller.open();

	for (;;) {
		const transaction = controller.transaction;
		const result = await attempt({
			transaction,
			protocolPrompt: prompt,
			oracle: options.oracle,
		});

		// A cancelled turn is not a failed transaction. Rolling back here would
		// destroy work the user interrupted for their own reasons, so the changes
		// stay and the undo goes back to the host to offer as a choice.
		if (result.aborted) {
			return {
				succeeded: false,
				transactions: [...controller.outcomes],
				stopped: "aborted",
				pending: controller.pending,
				uncovered: controller.uncovered,
			};
		}

		const selfReport =
			options.oracle || result.selfReport !== undefined
				? result.selfReport
				: await options.confirm?.(transaction);

		const settlement = await controller.settle({
			plan: result.plan,
			account: result.account,
			selfReport,
		});

		if (settlement.kept) {
			return {
				succeeded: true,
				transactions: [...controller.outcomes],
				stopped: "kept",
				uncovered: controller.uncovered,
			};
		}
		if (!settlement.nextPrompt) {
			return {
				succeeded: false,
				transactions: [...controller.outcomes],
				stopped: "exhausted",
				uncovered: controller.uncovered,
			};
		}
		prompt = settlement.nextPrompt;
	}
}

export type { SelfReport, TransactionEvent };
export {
	judgeSelfReport,
	TransactionController,
} from "./transaction-controller";
