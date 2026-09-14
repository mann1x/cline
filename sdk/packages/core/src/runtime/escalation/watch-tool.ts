/**
 * `wait_for_expert` — the base model's turn valve while it stands down.
 *
 * The escalation is not a blocking call any more: `escalate` hands over and
 * returns, and the base model is live for the whole exchange. That raises a
 * question the blocking call never had to answer -- what does a live base
 * model DO between the hand-over and the delivery? Left to itself it will burn
 * its whole turn budget re-reading files, or call `escalate` again to see if
 * anything has happened, which is the same busy-wait with a worse bill.
 *
 * So there is one call that means "wake me when there is something", and it
 * blocks until there is. One turn per batch, and the batching interval decides
 * how many batches there are. That is the entire turn economy of the
 * supervision, in one tool.
 *
 * It is deliberately not a poll that returns "nothing yet". A tool that can
 * return nothing is a tool a model will call in a loop.
 */

import { type AgentTool, createTool } from "@cline/shared";

export const WAIT_FOR_EXPERT_TOOL_NAME = "wait_for_expert";

export const WAIT_FOR_EXPERT_TOOL_DESCRIPTION = `Wait for the expert, and be told what it has been doing.

While the expert works you are standing down from changes, and this is how you follow it. The call returns when there is something for you: a batch of notes covering everything the expert has done since you last looked, or its delivery once it is finished. It costs you one turn each time, which is why the notes arrive in batches rather than one per action.

Each note names a tool the expert called, and where that call wrote a file it also gives the revision number holding what was written. Read the flow rather than auditing it — you are forming a view of whether the work is going somewhere, not checking receipts. Spot-check the parts that matter: \`read_files\` with \`revision: "#4"\` shows you the exact bytes a note is about, which is the only way to check a claim against what was actually written rather than against a file that has moved on since.

If what you see is the expert going round in circles — the same file rewritten again and again, a check failing the same way each time, nothing moving across several batches — say so. Call \`escalate\` with \`message\` to tell it what you see, or to tell it to stop. That judgement is yours, and nobody else is going to make it.`;

/** What waiting turned up. */
export interface ExpertWatchResult {
	kind: "batch" | "delivered" | "none";
	text: string;
}

export interface WaitForExpertToolOptions {
	/** Blocks until the next batch or the delivery. Owned by the session. */
	collect: () => Promise<ExpertWatchResult>;
	onError?: (message: string, error: unknown) => void;
}

export function createWaitForExpertTool(
	options: WaitForExpertToolOptions,
): AgentTool {
	return createTool({
		name: WAIT_FOR_EXPERT_TOOL_NAME,
		description: WAIT_FOR_EXPERT_TOOL_DESCRIPTION,
		inputSchema: { type: "object", properties: {}, required: [] },
		execute: async (): Promise<string> => {
			try {
				return (await options.collect()).text;
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				options.onError?.("[Escalation] waiting for the expert failed", error);
				return `Waiting for the expert failed: ${reason}\n\nThe expert may still be working. The task is yours either way — carry on with what you can do without changing files, and call \`escalate\` with \`finished: true\` if you want to take the workspace back.`;
			}
		},
	});
}

/** No expert is working, so there is nothing to wait for. */
export const NOTHING_TO_WAIT_FOR = `No expert is working right now, so there is nothing to wait for. The workspace is yours — carry on with the task.`;
