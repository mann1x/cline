/**
 * Thoughts the harness writes into the retrospective, in the model's voice.
 *
 * The retrospective is the model's own judgement of how the work went, and it
 * is blind to the events that cost the most, because those are exactly the
 * turns it never got to read: a reply discarded at the output limit takes its
 * reasoning with it, a looped block is removed, a call nothing could parse
 * never ran. The harness saw every one of them. So it says so, in the first
 * person and the present tense like the text it sits in, as something the
 * model has noticed about its own work -- and draws the one conclusion all of
 * them share: the unit of work is too large.
 *
 * Measured on the runs this was built from (pandorum, 2026-10-10, v9-agentic):
 * 13 replies discarded at the output limit, 21 unreadable calls and 4 looped
 * turns across 22 sessions, nearly all on a turn that thought at length and
 * then wrote one very large edit.
 */
import type { MessageWithMetadata } from "@cline/shared";
import { reasoningHitBudget } from "./capped-thinking";
import { findLatestSummaryIndex } from "./compaction-shared";

export interface CapEvents {
	/** Replies thrown away because they ended at the output limit. */
	outputLimit: number;
	/** Turns whose reasoning ended because the thinking budget ran out. */
	thinkingBudget: number;
	/** Turns whose reasoning collapsed into repetition. */
	loops: number;
	/** Tool calls that came back as text and never ran. */
	unreadableCalls: number;
}

function thinkingOf(message: MessageWithMetadata): string {
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.map((block) =>
			block.type === "thinking" && typeof block.thinking === "string"
				? block.thinking
				: "",
		)
		.join("");
}

/** Count the events since the last compaction, from what the messages carry. */
export function countCapEvents(
	messages: readonly MessageWithMetadata[],
	budgetMessage?: string,
): CapEvents {
	const events: CapEvents = {
		outputLimit: 0,
		thinkingBudget: 0,
		loops: 0,
		unreadableCalls: 0,
	};
	const from = findLatestSummaryIndex([...messages]) + 1;
	for (const message of messages.slice(from)) {
		const metadata = message.metadata as
			| {
					noticeKind?: unknown;
					reasoningLoop?: unknown;
					spoiledTurn?: { kinds?: unknown };
			  }
			| undefined;
		if (metadata?.noticeKind === "max_tokens_turn_recovery") {
			events.outputLimit += 1;
		}
		if (message.role !== "assistant") {
			continue;
		}
		const kinds = Array.isArray(metadata?.spoiledTurn?.kinds)
			? metadata.spoiledTurn.kinds
			: [];
		if (metadata?.reasoningLoop || kinds.includes("reasoning_loop")) {
			events.loops += 1;
		}
		if (kinds.includes("unreadable_tool_call")) {
			events.unreadableCalls += 1;
		}
		const thinking = thinkingOf(message);
		if (thinking && reasoningHitBudget(thinking, budgetMessage)) {
			events.thinkingBudget += 1;
		}
	}
	return events;
}

function times(count: number): string {
	return count === 1 ? "once" : count === 2 ? "twice" : `${count} times`;
}

/**
 * The thought, or nothing when there is nothing to have noticed.
 *
 * One paragraph. It names what happened with its count, says what it cost,
 * and ends on what to do instead -- smaller units, shorter reasoning, acting
 * in sequence. The advice is the same whichever event fired, because the
 * cause is.
 */
export function synthesizeCapThoughts(events: CapEvents): string | undefined {
	const noticed: string[] = [];
	if (events.outputLimit > 0) {
		noticed.push(
			`${times(events.outputLimit)} my reply runs into the output limit before I finish it, and it is thrown away with everything I worked out in it`,
		);
	}
	if (events.thinkingBudget > 0) {
		noticed.push(
			`${times(events.thinkingBudget)} my thinking runs out of budget before I get to act on it`,
		);
	}
	if (events.loops > 0) {
		noticed.push(
			`${times(events.loops)} I catch myself writing the same passage over and over instead of moving on`,
		);
	}
	if (events.unreadableCalls > 0) {
		noticed.push(
			`${times(events.unreadableCalls)} a tool call I write comes out unreadable at the end of a long text and never runs`,
		);
	}
	if (noticed.length === 0) {
		return undefined;
	}
	const list =
		noticed.length === 1
			? noticed[0]
			: `${noticed.slice(0, -1).join("; ")}; and ${noticed[noticed.length - 1]}`;
	return [
		`I am also noticing a pattern in how I work on this: ${list}.`,
		"Each of those is a turn that produces nothing, and they have one cause. I am trying to solve everything in one go: I reason for a long time about all the problems at once, and then write one very large change.",
		"So I am splitting the work into smaller units. I think briefly about one problem, make the one change it needs, look at what comes back, and only then think about the next. Shorter reasoning, and acting more often, one step after another rather than all the problems at once.",
	].join(" ");
}
