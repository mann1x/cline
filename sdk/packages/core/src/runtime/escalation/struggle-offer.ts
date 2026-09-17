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
import { SPAWN_AGENT_TOOL_NAME } from "../../extensions/tools/team/spawn-agent-tool";
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

/**
 * The quieter message, one failure short of the offer above.
 *
 * Two things separate it from `describeEscalationOffer`. It states what was
 * measured and stops -- no paragraph about cost, no "the expert exists to be
 * used" -- because at this count the honest reading is usually "this is a
 * normal bad patch", and a full proposal every time one would arrive would
 * train the model to skip the one that matters. And it names the expert only
 * when the code it is working in is genuinely hard to read, which is the one
 * case where the extra help is worth raising before the trigger.
 *
 * The complexity lines arrive already worded, each carrying its own bound.
 * Nothing here restates the number as a prediction: it says the code is hard
 * to read, which is all it measures.
 */
export function describeEscalationNudge(input: {
	diagnosis: string;
	complexity: readonly string[];
	/**
	 * Whether the hardest function in any file in play lands in the top band.
	 *
	 * `extreme`, which is 60 and above -- 6.3% of files measured across
	 * TypeScript, C and C++. Rare enough that raising it means something.
	 */
	high: boolean;
	/** Whether a file in play no longer parses end to end. */
	broken?: boolean;
	/**
	 * Which measurement asked for this.
	 *
	 * `edit-streak` names the expert on its own, where the plain nudge names it
	 * only in dense code. Three refused edits in a row is not a bad patch --
	 * the model has tried the same thing three times and been told no three
	 * times -- and that is the point at which raising the expert is the useful
	 * thing to say rather than the premature one.
	 */
	reason?: "failures" | "edit-streak" | "transactions";
	/**
	 * Whether this session can hand a piece of the work to a subagent.
	 *
	 * The expert is named late because it costs money or a shared GPU. A
	 * subagent is this model on this endpoint, so naming it is nearly free --
	 * which is why it rides the nudge that was already being sent rather than
	 * earning a threshold of its own. The gate is the host's: `spawn_agent` off,
	 * or an endpoint that serves one request at a time, and there is nothing to
	 * suggest.
	 */
	canDelegate?: boolean;
	remaining: number;
}): string {
	const lines = [input.diagnosis];
	if (input.complexity.length > 0) {
		lines.push("", ...input.complexity);
	}
	if (input.canDelegate) {
		// Named on the nudge and not on the offer: by the time the expert is
		// worth proposing, splitting the work is the slower of the two answers.
		lines.push(
			"",
			input.reason === "transactions"
				? `Those attempts were spent on one reading of the problem. \`${SPAWN_AGENT_TOOL_NAME}\` gives a piece of it to a subagent that reads it from nothing — the part you are least sure of is the part worth handing over, and you keep the attempt you are in.`
				: `\`${SPAWN_AGENT_TOOL_NAME}\` hands a self-contained piece of this to a subagent that starts without what you have already assumed. It costs you no attempt and no budget; what comes back is a report, not an edit.`,
		);
	}
	const streak = input.reason === "edit-streak";
	if ((streak || input.high || input.broken) && input.remaining > 0) {
		const because = streak
			? "You have now been refused the same way three times over"
			: input.broken
				? "The file is broken end to end rather than in one place"
				: "This is dense code, and dense code is where a second reading is worth most";
		lines.push(
			"",
			`${because}. \`${ESCALATE_TOOL_NAME}\` hands this change to the expert — a second, stronger model that takes it over, edits, and hands back — and ${
				input.remaining === 1
					? "you have one left"
					: `you have ${input.remaining} left`
			}. Nothing is being taken away from you: keep going if you have something specific you have not tried yet, and take it if what you have is another attempt at what has already been refused.`,
		);
	}
	return lines.join("\n");
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
 * `escalate` and `spawn_agent` are excluded — a model that has just taken the
 * advice does not need to be given it again inside the answer. Neither call
 * consumes the suggestion, so it is still owed to whatever runs next.
 */
export function withStruggleSuggestion<T extends AgentToolDefinition>(
	tools: readonly T[],
	pending: PendingSuggestion,
): T[] {
	return tools.map((tool) => {
		if (
			tool.name === ESCALATE_TOOL_NAME ||
			tool.name === SPAWN_AGENT_TOOL_NAME
		) {
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
