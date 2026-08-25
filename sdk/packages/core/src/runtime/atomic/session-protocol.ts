import type { CoreAtomicProtocolConfig } from "../../types/config";
import { discoverOracle, type Oracle } from "./oracle";
import { buildEmptyAttemptPrompt, describeEmptyAttempt } from "./protocol";
import {
	type SelfReport,
	TransactionController,
	type TransactionEvent,
} from "./transaction-controller";

/** Changes a transaction may declare, unless the user says otherwise. */
export const DEFAULT_MAX_CHANGES = 3;

/**
 * Attempts a task gets. Six, as the harness this comes from runs it: measured
 * across that campaign the fix landed in the first three transactions or not at
 * all, and the later ones bought re-readings of the same symptom.
 */
export const DEFAULT_MAX_TRANSACTIONS = 6;

/**
 * Empty submissions a transaction absorbs before the run is let go.
 *
 * One, and bounded for the same reason the runtime bounds its no-tool-call
 * nudge: asking a model that has stopped working to carry on is worth a turn,
 * and asking a third time is a spin with a wall clock on it.
 *
 * Measured on the harness this protocol comes from. A run whose first
 * transaction was discarded closed the remaining five in about nine minutes
 * without a single edit between them — one iteration each, no tool calls, and
 * the work file byte-identical to the seeded source at the end. It read as six
 * failed attempts and it was one.
 */
export const DEFAULT_MAX_EMPTY_ATTEMPTS = 1;

export interface AtomicProtocolSessionOptions {
	workspaceRoot: string;
	config: CoreAtomicProtocolConfig | undefined;
	onEvent?: (event: TransactionEvent) => void;
	/**
	 * `log`, not `debug`. Which check a change will be judged by — and whether
	 * there is one at all — is operational rather than diagnostic, and on the
	 * CLI a debug line is below the default level: the first live check of this
	 * feature read as "the config never arrived" for exactly that reason.
	 */
	logger?: { log?: (message: string) => void };
	/**
	 * Said to the user, not to the log: whether the protocol engaged, and why.
	 *
	 * A log line is the wrong place for this. Measured on the first live use:
	 * the mode was set to auto, the workspace held one HTML file and nothing
	 * that could be run, so the protocol stood down exactly as designed — and
	 * from the chat that is indistinguishable from a feature that is broken, or
	 * from one that is running and has had nothing to judge yet. The user's
	 * report was "I don't see any engagement of the atomic transaction even if
	 * it's enabled", which is the only thing they could have concluded.
	 */
	onStatus?: (status: { armed: boolean; message: string }) => void;
}

export interface AtomicProtocolSession {
	readonly controller: TransactionController;
	/** The check this task is judged by, or nothing when it has none. */
	readonly oracle: Oracle | undefined;
	/**
	 * The first transaction's rules, to go out with the task itself, once.
	 *
	 * In the user's message rather than the system prompt, which is where this
	 * started. The harness this protocol comes from puts the identical text in
	 * the opening message, and this matches the arm the campaign was measured
	 * on; it is not a demonstrated improvement, and nothing here should be read
	 * as one.
	 *
	 * A warning for anyone measuring this, learned by getting it wrong: count
	 * applied edits, not editor calls. Two system-prompt runs looked like eight
	 * and twenty-six changes against a limit of three, which reads as a limit
	 * nobody honours. Read against the tool results, they applied seven and
	 * three: the twenty-six was twenty-three failed calls -- no-match, read
	 * before edit, wrong insert mode -- around three changes that landed, which
	 * is the limit exactly.
	 *
	 * Returns the text once and nothing after. Every later transaction's rules
	 * arrive the same way, on the message that reopens it.
	 */
	takeOpeningRules(): string | undefined;
	/** The boundary. Judges the open transaction and keeps it or puts it back. */
	onCompletionAttempt(context: { text?: string }): Promise<string | undefined>;
}

/**
 * Arm the protocol for a session, or decline and say why.
 *
 * `auto` engages only where a change can actually be judged — an oracle the
 * user named, or something in the workspace that can be run. Without one the
 * verdict would come from the model's own account of its work, and the whole
 * reason the protocol exists is that this account and the program disagree.
 * `always` engages anyway, and is honest in the prompt about what is judging.
 */
export async function createAtomicProtocolSession(
	options: AtomicProtocolSessionOptions,
): Promise<AtomicProtocolSession | undefined> {
	const mode = options.config?.mode ?? "off";
	if (mode === "off") {
		return undefined;
	}

	const oracle = await discoverOracle(options.workspaceRoot, {
		manual: options.config?.oracleCommand,
		expect: options.config?.oracleExpect,
	});
	if (!oracle && mode === "auto") {
		// Said out loud, and to the user rather than to a log file. A feature
		// that silently does nothing looks exactly like one that is working and
		// has nothing to do, and there is no other line to tell them apart.
		const message =
			"Change protocol stood down: nothing in this workspace can be run to judge a change, and the mode is Auto. Name your own check in Settings → Features → Change Protocol, or set the mode to Always to have the model judge its own work.";
		options.logger?.log?.(`[Atomic] ${message}`);
		options.onStatus?.({ armed: false, message });
		return undefined;
	}
	const armedMessage = oracle
		? `Change protocol armed: each attempt is judged by \`${oracle.label}\` (${oracle.reason}), and an attempt that fails it is put back.`
		: "Change protocol armed with no check to run: the model judges its own work, which is the weaker of the two and is labelled as such on every attempt.";
	options.logger?.log?.(`[Atomic] ${armedMessage}`);
	options.onStatus?.({ armed: true, message: armedMessage });

	const controller = new TransactionController({
		workspaceRoot: options.workspaceRoot,
		maxChanges: options.config?.maxChanges ?? DEFAULT_MAX_CHANGES,
		maxTransactions:
			options.config?.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS,
		oracle,
		oracleTimeoutMs: options.config?.oracleTimeoutMs,
		onEvent: options.onEvent,
	});

	let rules: string | undefined = await controller.open();
	let finished = false;
	let emptyAttempts = 0;

	return {
		controller,
		oracle,
		takeOpeningRules: () => {
			const opening = rules;
			rules = undefined;
			return opening;
		},
		async onCompletionAttempt({ text }) {
			// Once the transactions are spent there is nothing left to judge with,
			// and asking again would settle a transaction that was never opened.
			if (finished) {
				return undefined;
			}

			const untouched = await controller.isUntouched();

			// A task that changed nothing is not a transaction. Answering a
			// question about the code is a legitimate way for a run to end, and
			// running a typecheck to confirm that nobody edited anything is a cost
			// with no verdict in it.
			if (controller.outcomes.length === 0 && untouched) {
				finished = true;
				return undefined;
			}

			// Once a transaction has been judged, an empty submission means
			// something else: the model has given up, and settling this would
			// spend a transaction on nothing. So it is not settled. The
			// transaction stays open, the model is told what it just did, and the
			// budget is spent only on attempts that contained an attempt.
			if (untouched) {
				emptyAttempts += 1;
				const continued = emptyAttempts <= DEFAULT_MAX_EMPTY_ATTEMPTS;
				const notice = describeEmptyAttempt(controller.transaction, continued);
				options.logger?.log?.(`[Atomic] ${notice}`);
				options.onEvent?.({
					type: "empty",
					transaction: controller.transaction,
					message: notice,
					continued,
				});
				if (!continued) {
					finished = true;
					return undefined;
				}
				return [
					notice,
					buildEmptyAttemptPrompt({
						transaction: controller.transaction,
						maxChanges: options.config?.maxChanges ?? DEFAULT_MAX_CHANGES,
					}),
				].join("\n\n");
			}

			// Each transaction gets its own budget: a model that submitted nothing,
			// was asked again and then made a real change has recovered, and the
			// next transaction should not start one strike down.
			emptyAttempts = 0;

			const settlement = await controller.settle({
				account: text,
				selfReport: oracle ? undefined : readSelfReport(text),
			});
			if (settlement.kept) {
				finished = true;
				return undefined;
			}
			if (!settlement.nextPrompt) {
				finished = true;
				return undefined;
			}
			// The whole of the next transaction's rules, not a pointer to them.
			// This message is the only thing that opens TX-02, exactly as a fresh
			// session's opening prompt is in the harness this comes from: the
			// rules, the limit and the record of what was already tried, restated
			// in full rather than referred back to.
			return [
				settlement.message,
				settlement.verdict?.output
					? `The check said:\n${settlement.verdict.output}`
					: undefined,
				settlement.nextPrompt,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n\n");
		},
	};
}

/**
 * What a model's closing message says about whether its change worked.
 *
 * A heuristic, and only reached where there is no oracle. It looks for doubt
 * rather than for confidence: a model that ends a run is already asserting that
 * it is done, so the thing worth finding is the sentence where it says it is
 * not sure, and returning `undefined` means "it did not say otherwise" rather
 * than "it said yes".
 */
export function readSelfReport(
	text: string | undefined,
): SelfReport | undefined {
	if (!text) return undefined;
	const lowered = text.toLowerCase();
	const doubted = [
		"could not verify",
		"couldn't verify",
		"unable to verify",
		"cannot verify",
		"can't verify",
		"could not test",
		"unable to test",
		"not able to test",
		"i cannot tell",
		"i can't tell",
		"unverified",
		"not verified",
	].some((phrase) => lowered.includes(phrase));
	if (doubted) return "unsure";
	const failed = [
		"still fails",
		"still failing",
		"still broken",
		"did not work",
		"didn't work",
		"does not work",
		"doesn't work",
		"was not able to fix",
		"could not fix",
		"couldn't fix",
	].some((phrase) => lowered.includes(phrase));
	return failed ? "failure" : undefined;
}
