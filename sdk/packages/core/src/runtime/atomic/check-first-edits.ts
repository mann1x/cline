/**
 * Hold the first edit of a transaction until the model has run the check.
 *
 * The protocol has said "before you edit anything, so you see the failure in
 * its own words" since it was written, and it is the sentence models skip.
 * Measured on a JackDelta 9B session, per transaction, counting from the first
 * tool call:
 *
 *   TX-01  first `run_check` at tool call #25, after ten edits
 *   TX-02  #3
 *   TX-03  #0
 *   TX-04  #7
 *   TX-05  #0
 *
 * TX-01 is the expensive one and the pattern is the same every time it
 * happens: the model reads the file, forms a theory from the source alone,
 * edits against that theory, and only then asks the program what was actually
 * wrong. In that run the first theory was a delimiter fault; the check, when
 * it was finally run, reported `ReferenceError: collide is not defined`. Two
 * dozen tool calls were spent before anything told it which of those it was
 * looking at.
 *
 * So the sentence is turned into a gate. Not a permanent one: it refuses one
 * edit, once per transaction, and only when the check has not been run in that
 * transaction yet. A model that opens by running the check -- TX-03 and TX-05
 * above -- never encounters it at all, which is the point. It is a nudge with
 * a mechanism, not a new rule.
 *
 * It also asks for the plan, because that is the other thing the same run did
 * not do: TX-01, TX-02 and TX-03 produced no plan text of any kind, the model
 * going straight from reading to editing. The two omissions have one cause and
 * one moment where saying so is useful, which is the moment before the first
 * edit lands.
 */

import type {
	AgentTool,
	AgentToolContext,
	AgentToolDefinition,
} from "@cline/shared";
import { DefaultToolNames } from "../../extensions/tools/constants";
import { RUN_CHECK_TOOL_NAME } from "./run-check-tool";

/** The tools that change a file, and so are the ones worth holding. */
const EDITING_TOOLS: readonly string[] = [
	DefaultToolNames.EDITOR,
	DefaultToolNames.APPLY_PATCH,
];

/** What the gate needs to know, and nothing more. */
export interface CheckFirstSource {
	/** Which transaction is open, so the gate can reset when it changes. */
	readonly transaction: number;
	/** How the check is named to the model, for a message it can act on. */
	readonly checkLabel: string;
}

/**
 * What the model is told instead of its first edit.
 *
 * Written as the two things to do next rather than as a rule it broke: a
 * refusal that argues is one a model answers, and the turn is worth more spent
 * on the check than on the disagreement. It says the edit did not happen, in
 * as many words, because a model that thinks the change landed will build the
 * next one on top of it.
 */
export function describeCheckFirst(checkLabel: string): string {
	return [
		"That edit was not made. Nothing has changed on disk.",
		"",
		`Run \`${RUN_CHECK_TOOL_NAME}\` first — it runs ${checkLabel} — and read what it reports. It is the failure this transaction is judged on, and reading the source is not a substitute for it: a file can look wrong in one place and fail in another, and the edit you were about to make would have been aimed at whichever one you happened to read.`,
		"",
		"Then state your plan before you edit: a numbered list, each entry naming WHERE, WHAT and WHY. State it in your reply, so it is on the record and the user can see it, not only in your reasoning.",
		"",
		"After that, make the edit. This is asked once per transaction and not again — the next edit goes through whatever you decide.",
	].join("\n");
}

/**
 * Wrap the editing tools so the first one waits for the check.
 *
 * Wrapping rather than asking the controller: whether the check has been run is
 * a fact about this transaction's tool calls, and the tool list is where those
 * are already passing. It also keeps the gate off entirely for a host with no
 * check to run, which is the case it must not fire in.
 */
export function withCheckFirstEdits<T extends AgentToolDefinition>(
	tools: readonly T[],
	source: CheckFirstSource,
): T[] {
	// Per-transaction state, reset by observing the number rather than by being
	// told: the gate has no place in the transaction lifecycle and should not
	// acquire one.
	let seenTransaction = source.transaction;
	let checkRun = false;
	let held = false;

	const syncTransaction = () => {
		if (source.transaction !== seenTransaction) {
			seenTransaction = source.transaction;
			checkRun = false;
			held = false;
		}
	};

	return tools.map((tool) => {
		if (tool.name === RUN_CHECK_TOOL_NAME) {
			const original = tool as unknown as AgentTool<unknown, unknown>;
			return {
				...original,
				execute: async (input: unknown, context: AgentToolContext) => {
					syncTransaction();
					// Marked before the run, not after: a check that throws still
					// showed the model the program's own answer, and holding the
					// next edit over a failed check would be the gate punishing
					// the model for the thing it asked it to do.
					checkRun = true;
					return original.execute(input, context);
				},
			} as unknown as T;
		}

		if (!EDITING_TOOLS.includes(tool.name)) {
			return tool;
		}

		const original = tool as unknown as AgentTool<unknown, unknown>;
		return {
			...original,
			execute: async (input: unknown, context: AgentToolContext) => {
				syncTransaction();
				if (checkRun || held) {
					return original.execute(input, context);
				}
				held = true;
				return describeCheckFirst(source.checkLabel);
			},
		} as unknown as T;
	});
}
