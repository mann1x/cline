/**
 * Submit the open transaction, deliberately, when the model judges it done.
 *
 * Why it exists. Until now there was no way for a model to submit anything.
 * `onCompletionAttempt` — the only path that judges a transaction — is reached
 * from exactly one place in the runtime: a turn that called no tools. So the
 * submission was never a decision. The model would think a turn through, call
 * nothing, and be told "TX-01 was submitted", which is a report of something it
 * had not done.
 *
 * And it is told the opposite everywhere else. The no-tool-call nudge exists
 * precisely to stop a turn ending without a call; the protocol's only exit was
 * to do that on purpose. Measured on pandorum 2026-09-12 under 4.100.103: ten
 * turns, no tool calls, six boundary messages, and the model's own reasoning
 * reading "I keep failing to emit actual tool calls", "I have called none of
 * those yet", "this loop above shows exactly why things keep ending". It was
 * not confused about the task. It was reacting to being told it had submitted.
 *
 * With this, submission is a tool call like everything else: the model decides
 * when it is confident, the check runs, and the verdict comes back as the
 * result. The completion boundary stays, demoted to what it should always have
 * been — a guard for a run that has stopped calling anything at all.
 */

import { type AgentTool, createTool } from "@cline/shared";

export const SUBMIT_TRANSACTION_TOOL_NAME = "submit_transaction";

export const SUBMIT_TRANSACTION_TOOL_DESCRIPTION = `Submit this transaction for judging, when you have made the changes you planned and you are confident in them.

This is how a transaction ends. Nothing else submits it: finishing your turn without calling anything does not, and describing the work in your reply does not.

What happens when you call it: the check runs, and the answer comes straight back to you. If it passes the transaction is kept and the task is done. If it does not, every change in this transaction is rolled back for you, and you are given the next transaction with a record of what this one tried.

So call it when you believe the work is finished — not to ask whether it is. Use \`run_check\` for that, as often as you like; it settles nothing. Submitting is the commitment.`;

export const SUBMIT_TRANSACTION_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {
		account: {
			type: "string",
			description:
				"What you changed and why you believe it works. One or two sentences. This is recorded with the transaction and, where nothing here can run a check, it is what the verdict is based on.",
		},
	},
	required: [],
} as const;

export interface SubmitTransactionToolOptions {
	/**
	 * Settles the open transaction and returns what the model should be told:
	 * the verdict, and the next transaction's rules where there is one.
	 *
	 * Owned by the session rather than passed a controller, because settling
	 * touches per-session bookkeeping — whether the run has finished, how many
	 * empty submissions this transaction has absorbed — that does not live on
	 * the controller and would be bypassed by settling directly.
	 */
	submit: (account: string | undefined) => Promise<string>;
	onError?: (message: string, error: unknown) => void;
}

export function createSubmitTransactionTool(
	options: SubmitTransactionToolOptions,
): AgentTool {
	return createTool({
		name: SUBMIT_TRANSACTION_TOOL_NAME,
		description: SUBMIT_TRANSACTION_TOOL_DESCRIPTION,
		inputSchema: SUBMIT_TRANSACTION_TOOL_INPUT_SCHEMA as unknown as Record<
			string,
			unknown
		>,
		execute: async (input: unknown): Promise<string> => {
			const account =
				input && typeof input === "object" && "account" in input
					? typeof (input as { account?: unknown }).account === "string"
						? (input as { account: string }).account.trim() || undefined
						: undefined
					: undefined;
			try {
				return await options.submit(account);
			} catch (error) {
				options.onError?.(
					"[Atomic] the transaction could not be settled",
					error,
				);
				return `The transaction could not be settled: ${String(error)}. It is still open and your changes are still in place.`;
			}
		},
	});
}
