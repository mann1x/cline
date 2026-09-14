/**
 * What the base model may do while the expert is editing its workspace.
 *
 * The escalation used to be a blocking call: the base model went into
 * `escalate`, the tool did not return until the expert had delivered, and the
 * question of what the base was allowed to do meanwhile did not arise because
 * it could do nothing at all. That cost the two things the user asked for
 * (2026-09-14): a base model that watches the expert and can call it off when
 * it starts going in circles, and a user steer that reaches the base while the
 * expert is still working rather than an hour later.
 *
 * Making the base live raises the problem the blocking call did not have. Two
 * models now hold write access to one workspace, and nothing arbitrates
 * between them: the base reads a file, the expert rewrites it, the base edits
 * the lines it read and destroys the expert's work -- or, worse, both of them
 * do, and neither delivery is what is on disk. That is not a rule the models
 * can be trusted to keep between themselves, because each of them is correct
 * about its own edit.
 *
 * So the base stands down. Not from the task and not from the turn: from
 * CHANGES. It reads, it greps, it runs the check, it reads the versions the
 * expert wrote and it messages the expert. What it cannot do is write, and
 * that is enforced here rather than asked for in a prompt, because a prompt is
 * a request and this is an invariant (user: "the base model should be
 * instructed to stand down from changes; all editing operations prohibited
 * until the expert is done").
 *
 * `run_commands` is the deliberate exception. The user allowed running --
 * checking the expert's work is most of what the base is there for, and a base
 * that cannot run anything is a base that can only take the expert's word --
 * and a command can write anything, so it is warned rather than refused.
 */

import type { AgentToolDefinition } from "@cline/shared";
import { CHECK_FILE_TOOL_NAME } from "../../extensions/tools/check-file";
import { DefaultToolNames } from "../../extensions/tools/constants";
import { RESTORE_FILE_TOOL_NAME } from "../atomic/restore-file-tool";
import { SUBMIT_TRANSACTION_TOOL_NAME } from "../atomic/submit-transaction-tool";

/**
 * Tools that put bytes on disk, and are refused outright.
 *
 * `restore_file` and `submit_transaction` are here for a second reason as well
 * as writing. Both act on the base model's open transaction, and the expert is
 * changing the files that transaction covers: a rollback now would put back a
 * version from before the expert started, and a submit would close a
 * transaction over work that is still being done.
 */
const REFUSED: readonly string[] = [
	DefaultToolNames.EDITOR,
	DefaultToolNames.APPLY_PATCH,
	DefaultToolNames.SED,
	RESTORE_FILE_TOOL_NAME,
	SUBMIT_TRANSACTION_TOOL_NAME,
];

/** Tools that can write but are needed to check, and are warned instead. */
const WARNED: readonly string[] = [DefaultToolNames.RUN_COMMANDS];

/**
 * What the base model is told when it hands over.
 *
 * The spot-check instruction is the load-bearing sentence. The notes name
 * every tool call the expert made, and a model told to verify them all will
 * spend the whole escalation reading -- which is the turn economy the batching
 * exists to protect (user: "instruct the base model to NOT do a systematic
 * check of all tools request but overview the flow and run spot checks").
 */
export const STAND_DOWN_NOTICE = `== YOU ARE STANDING DOWN WHILE THE EXPERT WORKS ==

The expert is editing this workspace now. You are not. Until it delivers, every tool that writes a file is refused — you cannot edit, patch, restore or submit, and there is no way to override that. This is not a judgement about your work; it is that two models writing to one workspace destroy each other's changes, and the expert has the pen.

What you do instead is watch. You will be given notes as the expert works: what it called, what it changed, what it said. Do not audit them. Read the flow, form a view of whether the work is going somewhere, and run spot checks on the parts that matter — the file the expert says it fixed, the check it says now passes, the claim you doubt. \`read_files\` with a \`revision\` from a note shows you the exact bytes that note was about, which is the only way to check a claim against what was actually written rather than against a file that has moved on since.

You may run commands, including the check. Do not run one that changes a file. A formatter, a build step that rewrites sources, a \`sed -i\` — any of those lands on top of what the expert is doing, and neither of you will be able to say what happened.

You may message the expert, and you should keep it rare: a message costs it a turn and pulls it off what it is doing. Send one when you have something it needs — an answer to a question, a correction the user gave you, or the judgement only you can make: that it is going in circles and should stop. You are authorised to call it off.

When the expert delivers, you have the pen back and the task is yours again.`;

/** The stand-down, as the session drives it. */
export interface StandDown {
	/** Whether the base model is standing down right now. */
	readonly engaged: boolean;
	/** The expert has the workspace. */
	engage(): void;
	/** The expert is done. The base model has the pen back. */
	release(): void;
}

export function createStandDown(): StandDown {
	let engaged = false;
	return {
		get engaged() {
			return engaged;
		},
		engage() {
			engaged = true;
		},
		release() {
			engaged = false;
		},
	};
}

function refusal(name: string): string {
	return `\`${name}\` is refused: you are standing down while the expert works on this workspace, and it writes.

The expert has the pen until it delivers. Changing a file now would land on top of work in progress, and the expert would go on editing the version it thinks is there. Read, grep, run the check, read the revisions the notes name — all of that is open to you. If what you were about to change cannot wait, message the expert and say so.`;
}

const RAN_BUT_WATCH = `\n\n[You are standing down while the expert works. Check that this did not change a file — if it did, say so to the expert now, because it is editing from what it believes is on disk.]`;

/**
 * Return the tool list with the writers gated on the stand-down.
 *
 * A decoration rather than a filter, and deliberately: a tool that vanishes
 * mid-task teaches the model that the tool does not exist, and it stops
 * planning with it for the rest of the run. A tool that answers "not now, and
 * here is why" leaves the capability where the model can find it again.
 */
export function withStandDown<T extends AgentToolDefinition>(
	tools: readonly T[],
	standDown: StandDown,
): T[] {
	return tools.map((tool) => {
		const refused = REFUSED.includes(tool.name);
		const warned = WARNED.includes(tool.name);
		if (!refused && !warned) {
			return tool;
		}
		const original = tool as unknown as {
			execute?: (input: unknown, context: unknown) => unknown;
		};
		return {
			...tool,
			execute: async (input: unknown, context: unknown) => {
				if (!standDown.engaged) {
					return original.execute?.(input, context);
				}
				if (refused) {
					return refusal(tool.name);
				}
				const result = await original.execute?.(input, context);
				return typeof result === "string" ? result + RAN_BUT_WATCH : result;
			},
		} as unknown as T;
	});
}

/** Names the stand-down refuses, for the prompt and for tests. */
export const STAND_DOWN_REFUSED_TOOLS: readonly string[] = REFUSED;

/** Names that stay open, stated so a reader does not have to infer them. */
export const STAND_DOWN_ALLOWED_TOOLS: readonly string[] = [
	DefaultToolNames.READ_FILES,
	DefaultToolNames.SEARCH_CODEBASE,
	DefaultToolNames.GREP,
	DefaultToolNames.AWK,
	CHECK_FILE_TOOL_NAME,
];
