/**
 * Run the check that judges this run, on demand, without settling anything.
 *
 * Why it exists. The check reached the model from exactly one place — `settle`,
 * at the completion attempt — while the tool that proposes it told the model
 * the opposite: "it is run for you, unattended, every time your turn ends, and
 * its result comes back to you". So the model believed it had a feedback loop,
 * did not build one of its own, and got no verdict at all until the transaction
 * was over. Measured on pandorum 2026-09-05 under 4.100.68: TX-01 ran 341
 * messages and 65 edits with nothing judged, then one `SyntaxError: missing )
 * after argument list` at the end, then a full rollback — after which the model
 * copied the original file back over its work and started again.
 *
 * The arm that works has never had this problem, and not because its check is
 * better. There the check is a shell line named in the opening prompt, so the
 * model simply reruns it whenever it wants — 88 `run_commands` in one run that
 * ended FIXED. A check the model cannot type is a check it cannot consult, and
 * the only remedy is to hand it one.
 *
 * It settles nothing and rolls nothing back. A failing result here is
 * information, not a verdict: the transaction is still open and the files are
 * still the model's.
 */

import { type AgentTool, createTool } from "@cline/shared";
import type { Oracle, OracleVerdict } from "./oracle";

export const RUN_CHECK_TOOL_NAME = "run_check";

/**
 * Runs per transaction before the model is told to stop.
 *
 * Ten, which is deliberately generous next to the protocol's other budgets:
 * this is the one call that is *supposed* to be made repeatedly, and a model
 * that checks after every edit is doing exactly what the check is for. The
 * ceiling exists for the loop that checks without editing — measured on the
 * same class of run as `restore_file`'s — not to ration the loop that works.
 */
export const MAX_CHECKS_PER_TRANSACTION = 10;

export const RUN_CHECK_TOOL_DESCRIPTION = `Run the check that decides whether this task is done, right now, against the files as they currently stand.

This is your feedback loop. Nothing is settled and nothing is rolled back: the result is information, the transaction stays open, and your changes stay in place whatever it says.

Run it early, on the unmodified files, so you see the failure you are fixing in the check's own words rather than inferring it. Run it after each change. A change you have not run it against is a change you are guessing about, and your own reading of the code is the weakest evidence available to you.

Take no output as no output. If the check passes, say so and finish; the same check runs once more when you do.`;

export const RUN_CHECK_TOOL_INPUT_SCHEMA = {
	type: "object",
	properties: {},
	required: [],
} as const;

/** The part of the controller this tool drives. */
export interface CheckRunner {
	readonly oracle: Oracle | undefined;
	readonly transaction: number;
	runCheck(): Promise<OracleVerdict>;
}

export interface RunCheckToolOptions {
	controller: CheckRunner;
	/** Whether a check could still arrive, for the message when there is none. */
	canProposeCheck?: boolean;
	onRun?: (verdict: OracleVerdict, oracle: Oracle) => void;
	onError?: (message: string, error: unknown) => void;
}

/** What the model is told, so a passing and a failing run read differently. */
export function describeCheckRun(
	verdict: OracleVerdict,
	label: string,
): string {
	const output = verdict.output.trim();
	const head = verdict.passed
		? `The check passed: \`${label}\`.`
		: `The check failed: \`${label}\`.`;
	const tail = verdict.passed
		? "Nothing was settled — say so and finish, and it will be run once more when you do."
		: "Nothing was rolled back: the transaction is open and your changes are still there. Fix what it named and run it again.";
	return [head, output ? `\n${output}\n` : undefined, tail]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

export function createRunCheckTool(options: RunCheckToolOptions): AgentTool {
	// Per transaction, because a transaction is where the work is bounded. A
	// discarded one starts the count again: the next attempt has to be able to
	// see the failure the last one died on.
	let countedFor = 0;
	let runs = 0;

	return createTool({
		name: RUN_CHECK_TOOL_NAME,
		description: RUN_CHECK_TOOL_DESCRIPTION,
		inputSchema: RUN_CHECK_TOOL_INPUT_SCHEMA as unknown as Record<
			string,
			unknown
		>,
		execute: async (): Promise<string> => {
			const oracle = options.controller.oracle;
			if (!oracle) {
				return options.canProposeCheck
					? "There is no check yet. Propose one with `propose_check` and, once the user approves it, this runs it."
					: "There is no check to run in this workspace, so your own account of the work is the verdict. Say plainly whether the change worked and how you know.";
			}

			const transaction = options.controller.transaction;
			if (transaction !== countedFor) {
				countedFor = transaction;
				runs = 0;
			}
			if (runs >= MAX_CHECKS_PER_TRANSACTION) {
				return `The check has been run ${MAX_CHECKS_PER_TRANSACTION} times in this transaction without the task closing. Running it again will not tell you anything the last result did not. Either make a different change, or say plainly that you cannot get it to pass.`;
			}
			runs += 1;

			let verdict: OracleVerdict;
			try {
				verdict = await options.controller.runCheck();
			} catch (error) {
				options.onError?.("[Atomic] the check could not be run", error);
				return `The check could not be run: ${String(error)}. It will still be run when you finish, so this is not a reason to stop.`;
			}
			options.onRun?.(verdict, oracle);
			return describeCheckRun(verdict, oracle.label);
		},
	});
}
