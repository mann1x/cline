/**
 * Notice the plan the moment it is written, wherever it was written.
 *
 * The protocol asks for the plan in the reply. A 9B put it in its reasoning
 * four times out of four (session 1789032320523_q29ta, assistant messages 7,
 * 61, 77 and 79 — one of them a WHERE/WHAT/WHY table — every one of them with
 * a reply of zero characters). The instruction was followed; the clause about
 * where to put it was not, and nothing downstream reads reasoning, so the plan
 * reached neither the user nor the transaction record.
 *
 * Rather than ask again in stronger words, read it. The assistant message for
 * the current turn is already in `context.snapshot.messages` by the time its
 * tool calls execute -- the runtime pushes it before running them -- so any
 * tool call is a place to look, and the first one of the turn is the earliest
 * moment the plan can be surfaced.
 *
 * Every tool is wrapped, not only the editing ones: a turn that states a plan
 * and then reads a file before editing is stating a plan just as much as one
 * that edits immediately, and the gate that asked for it fires on edits alone.
 *
 * Reported once per transaction. A plan is what opens a transaction; repeating
 * it on every later tool call would turn one message into forty.
 */

import type {
	AgentMessage,
	AgentMessagePart,
	AgentTool,
	AgentToolContext,
	AgentToolDefinition,
} from "@cline/shared";
import { readPlan } from "./plan-text";

/** Where the plan was found, which decides whether the user needs telling. */
export type PlanSource = "reply" | "reasoning";

export interface PlanCaptureSource {
	/** Which transaction is open, so a new one can be given its own plan. */
	readonly transaction: number;
	/** Called at most once per transaction, with the plan as the model wrote it. */
	readonly onPlan: (plan: string, from: PlanSource) => void;
}

/** The joined text of one kind of part, or "". */
function partsText(
	message: AgentMessage | undefined,
	type: "text" | "reasoning",
): string {
	if (!message) {
		return "";
	}
	return message.content
		.filter(
			(part: AgentMessagePart): part is AgentMessagePart & { text: string } =>
				part.type === type &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n")
		.trim();
}

/** The turn being executed: the runtime pushes it before running its tools. */
function currentAssistantMessage(
	messages: readonly AgentMessage[] | undefined,
): AgentMessage | undefined {
	if (!messages) {
		return undefined;
	}
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		if (messages[index].role === "assistant") {
			return messages[index];
		}
	}
	return undefined;
}

/**
 * Wrap every tool so the first plan of each transaction is reported once.
 *
 * The reply is preferred over the reasoning, and the source is passed on:
 * a plan the model already put in its reply is on screen, and repeating it
 * back to the user would be noise.
 */
export function withPlanCapture<T extends AgentToolDefinition>(
	tools: readonly T[],
	source: PlanCaptureSource,
): T[] {
	let seenTransaction = source.transaction;
	let reported = false;

	const note = (context: AgentToolContext) => {
		if (source.transaction !== seenTransaction) {
			seenTransaction = source.transaction;
			reported = false;
		}
		if (reported) {
			return;
		}
		const message = currentAssistantMessage(context.snapshot?.messages);
		const fromReply = readPlan(partsText(message, "text"));
		if (fromReply) {
			reported = true;
			source.onPlan(fromReply, "reply");
			return;
		}
		const fromReasoning = readPlan(partsText(message, "reasoning"));
		if (fromReasoning) {
			reported = true;
			source.onPlan(fromReasoning, "reasoning");
		}
	};

	return tools.map((tool) => {
		const original = tool as unknown as AgentTool<unknown, unknown>;
		return {
			...original,
			execute: async (input: unknown, context: AgentToolContext) => {
				// Never let looking for a plan cost a tool call. Nothing here is
				// required for the tool to run, and a throw would turn a
				// presentation feature into a failed edit.
				try {
					note(context);
				} catch {
					// Deliberately ignored.
				}
				return original.execute(input, context);
			},
		} as unknown as T;
	});
}
