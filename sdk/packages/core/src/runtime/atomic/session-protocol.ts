import type { ContextPipelinePrepareTurn } from "../../extensions/context/compaction";
import type { CoreAtomicProtocolConfig } from "../../types/config";
import { discoverOracle, type Oracle } from "./oracle";
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
}

export interface AtomicProtocolSession {
	readonly controller: TransactionController;
	/** The check this task is judged by, or nothing when it has none. */
	readonly oracle: Oracle | undefined;
	/**
	 * The open transaction's rules, to append to the system prompt.
	 *
	 * Read on every request rather than fixed at session start: the rules carry
	 * the record of what earlier transactions tried, and that record is the only
	 * thing that makes a second attempt different from a first. In the system
	 * prompt rather than in a message so it cannot scroll out of the window — a
	 * rule the model can no longer see is a rule it does not follow.
	 */
	rules(): string;
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
		// Said out loud. A feature that silently does nothing looks exactly like
		// one that is working and has nothing to do, and there is no other line
		// to tell them apart.
		options.logger?.log?.(
			"[Atomic] Stood down: nothing in this workspace can judge a change, and the mode is auto. Name a check in settings, or set the mode to always to have the model judge its own work.",
		);
		return undefined;
	}
	options.logger?.log?.(
		oracle
			? `[Atomic] Armed: transactions are judged by \`${oracle.label}\` (${oracle.reason})`
			: "[Atomic] Armed with no check to run: the model judges its own work, which is the weaker of the two and is labelled as such",
	);

	const controller = new TransactionController({
		workspaceRoot: options.workspaceRoot,
		maxChanges: options.config?.maxChanges ?? DEFAULT_MAX_CHANGES,
		maxTransactions:
			options.config?.maxTransactions ?? DEFAULT_MAX_TRANSACTIONS,
		oracle,
		oracleTimeoutMs: options.config?.oracleTimeoutMs,
		onEvent: options.onEvent,
	});

	let rules = await controller.open();
	let finished = false;

	return {
		controller,
		oracle,
		rules: () => rules,
		async onCompletionAttempt({ text }) {
			// Once the transactions are spent there is nothing left to judge with,
			// and asking again would settle a transaction that was never opened.
			if (finished) {
				return undefined;
			}

			// A task that changed nothing is not a transaction. Answering a
			// question about the code is a legitimate way for a run to end, and
			// running a typecheck to confirm that nobody edited anything is a cost
			// with no verdict in it.
			if (
				controller.outcomes.length === 0 &&
				(await controller.isUntouched())
			) {
				finished = true;
				return undefined;
			}

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
			rules = settlement.nextPrompt;
			return [
				settlement.message,
				settlement.verdict?.output
					? `The check said:\n${settlement.verdict.output}`
					: undefined,
				`TX-${String(controller.transaction).padStart(2, "0")} is now open. Read the record in the change protocol before you plan: what that transaction tried is there, and it did not work.`,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n\n");
		},
	};
}

/**
 * Put the open transaction's rules in the system prompt of every request.
 *
 * Last in the pipeline, after compaction has decided what the transcript is:
 * the rules are not part of the conversation and must survive a compaction that
 * throws most of it away. A model working to rules it can no longer see is the
 * failure this exists to prevent — measured on the harness, a transaction whose
 * rules had scrolled out declared eleven changes against a limit of three.
 */
export function withAtomicProtocolRules(
	inner: ContextPipelinePrepareTurn | undefined,
	session: AtomicProtocolSession | undefined,
): ContextPipelinePrepareTurn | undefined {
	if (!session) {
		return inner;
	}
	return async (context) => {
		const result = await inner?.(context);
		const systemPrompt = result?.systemPrompt ?? context.systemPrompt;
		return {
			messages: result?.messages ?? context.messages,
			systemPrompt: `${systemPrompt}\n\n${session.rules()}`,
		};
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
