/**
 * Turning "this run is not going anywhere" into an offer of help.
 *
 * The detector next door measures; this words the consequence, and the split
 * is deliberate. What the measurement earns depends on things the detector
 * cannot see -- whether an expert is configured at all, how much of the
 * escalation budget is left, whether the user asked to approve each one.
 *
 * Delivered on a tool result rather than appended to the conversation. The
 * conversation store is snapshotted into `initialMessages` when a run starts
 * and overwritten from `runResult.messages` when it ends, so a message
 * appended to it mid-run reaches nothing: measured on a live session where a
 * guard counted six refusals and not one of the twenty-six requests on the
 * wire carried a word of the warning.
 */

import type {
	AgentTool,
	AgentToolContext,
	AgentToolDefinition,
} from "@cline/shared";
import { ESCALATE_TOOL_NAME } from "./escalate-tool";

/**
 * What the model is told when the detector has fired.
 *
 * Both halves matter, and the second one is the half that is easy to leave
 * out: the expert is there to be used. A model that refuses to escalate after
 * four failed attempts in ten turns wastes more than one that escalates early,
 * and a paragraph that only warned about cost would produce exactly that.
 *
 * It never says the model must. The forcing path is a different mechanism at a
 * different place, and a suggestion that reads like an order makes the run's
 * one real stop indistinguishable from a nudge.
 */
export function describeEscalationOffer(input: {
	diagnosis: string;
	remaining: number;
}): string {
	return [
		`This run does not look like it is converging. ${input.diagnosis}`,
		"",
		`You can hand this to the expert with \`${ESCALATE_TOOL_NAME}\` — a second, stronger model that takes the task over, edits, and hands back. ${
			input.remaining === 1
				? "You have one escalation left"
				: `You have ${input.remaining} escalations left`
		}, and each one costs real money or somebody else's hardware.`,
		"",
		"It is your call and nothing is being taken away from you: keep going if you have something specific you have not tried. But spending four more turns on what the last ten turns did costs more than the escalation would, and the expert exists to be used.",
	].join("\n");
}

/** A held suggestion, taken by whichever tool result comes next. */
export interface PendingSuggestion {
	hold(message: string): void;
	/** What is owed, without consuming it. */
	peek(): string | undefined;
	take(): string | undefined;
}

export function createPendingSuggestion(): PendingSuggestion {
	let held: string | undefined;
	return {
		hold(message: string) {
			held = message;
		},
		peek() {
			return held;
		},
		take() {
			const message = held;
			held = undefined;
			return message;
		},
	};
}

/**
 * Put the suggestion on a result, or say that this result cannot carry one.
 *
 * Two shapes reach here. A tool that answers with text is appended to. A tool
 * that answers with one entry per item -- `read_files` and its neighbours --
 * has it appended to the last entry that succeeded, because an entry that
 * failed is already carrying an explanation of its own and is the one the model
 * is least likely to read to the end.
 *
 * Anything else returns `undefined`, and the caller leaves the suggestion held.
 * That is the whole point of the split: consuming an offer that was never
 * delivered is how this went silent.
 */
function withSuggestionAttached(
	result: unknown,
	suggestion: string,
): unknown | undefined {
	if (typeof result === "string") {
		return `${result}\n\n${suggestion}`;
	}
	if (!Array.isArray(result)) {
		return undefined;
	}
	for (let index = result.length - 1; index >= 0; index -= 1) {
		const entry = result[index];
		if (
			!entry ||
			typeof entry !== "object" ||
			Array.isArray(entry) ||
			(entry as { success?: unknown }).success === false ||
			typeof (entry as { result?: unknown }).result !== "string"
		) {
			continue;
		}
		const copy = [...result];
		copy[index] = {
			...(entry as Record<string, unknown>),
			result: `${(entry as { result: string }).result}\n\n${suggestion}`,
		};
		return copy;
	}
	return undefined;
}

/**
 * Wrap every tool so the next result carries a held suggestion.
 *
 * Every tool, not a chosen few: the suggestion is about the run rather than
 * about any one call, and the model's next call is wherever it happens to go.
 * `escalate` itself is excluded — a model that has just taken the advice does
 * not need to be given it again inside the answer.
 */
export function withStruggleSuggestion<T extends AgentToolDefinition>(
	tools: readonly T[],
	pending: PendingSuggestion,
): T[] {
	return tools.map((tool) => {
		if (tool.name === ESCALATE_TOOL_NAME) {
			return tool;
		}
		const original = tool as unknown as AgentTool<unknown, unknown>;
		return {
			...original,
			execute: async (input: unknown, context: AgentToolContext) => {
				const result = await original.execute(input, context);
				// Peeked, not taken. `take()` used to run first and clear the
				// offer whatever happened next, so a result that could not carry
				// one swallowed it -- measured on run 0298, where the detector
				// fired at iteration 130 and the model was never told.
				const suggestion = pending.peek();
				if (!suggestion) {
					return result;
				}
				const delivered = withSuggestionAttached(result, suggestion);
				if (delivered === undefined) {
					return result;
				}
				pending.take();
				return delivered;
			},
		} as unknown as T;
	});
}
