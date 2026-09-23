import type { AgentEvent } from "@cline/shared";

/**
 * What a delegated agent is doing, reported on the tool call that started it.
 *
 * A sub-agent's own events are deliberately kept out of the main chat -- one
 * agent's internals are already a conversation, and three at once is a flood.
 * The consequence was that nothing about a running sub-agent reached the user
 * at all: the UI reads `latestToolCall` off the spawn tool's progress, and no
 * spawn path had ever emitted any, so the field was declared, parsed, rendered
 * and always empty.
 *
 * Measured on pandorum 2026-09-22: three configured agents ran for between 80
 * and 148 seconds each, and for all of it the only thing on screen was the
 * lead's last tool call. Whether an agent was working, queued behind the
 * endpoint, or dead was not answerable without the extension log.
 *
 * This closes over one spawn call, so no identity has to be reconstructed --
 * the events it is given are its own agent's, and the update lands on its own
 * tool call.
 */
export interface SubagentProgress {
	/** Feed every event the delegated agent emits. */
	observe(event: AgentEvent): void;
}

/** How much of an agent's latest output the UI is given. */
export const SUBAGENT_OUTPUT_TAIL_CHARS = 400;

/**
 * How often output progress is reported, at most.
 *
 * Deltas arrive per token; fifty agents reporting each one would be thousands
 * of chat updates a second for a tail nobody reads that fast.
 */
export const SUBAGENT_OUTPUT_REPORT_MS = 2_000;

/**
 * The agent is waiting for a node: every node that could take it is full.
 *
 * Without this the UI had no way to tell a queued agent from a working one --
 * every agent was shown running from the moment it was spawned, so a fan-out
 * of seventy-five on nodes that take three looked like seventy-five at work.
 */
export function reportSubagentQueued(
	emitUpdate: ((update: unknown) => void) | undefined,
): void {
	emitUpdate?.({ queued: true });
}

/**
 * The agent has a node and starts now. Sent at placement, not at the end: the
 * node is what explains a slow agent while it is slow.
 */
export function reportSubagentPlaced(
	emitUpdate: ((update: unknown) => void) | undefined,
	placed: { nodeId?: string; nodeLabel?: string } | undefined,
): void {
	emitUpdate?.({
		queued: false,
		...(placed?.nodeId ? { nodeId: placed.nodeId } : {}),
		...(placed?.nodeLabel ? { nodeLabel: placed.nodeLabel } : {}),
	});
}

/**
 * What every delegating tool tells the model about launching many agents.
 *
 * Measured on pandorum 2026-09-23 (sx4bp): asked for 75 reports, the lead
 * spent its planning turn arguing with itself -- "that's 75 tool calls which
 * is a LOT", "I'll do this in waves", "can I really make 75 tool calls at
 * once?" -- five reversals before it launched them all together, which was
 * right all along: placement queues what does not fit. Nothing in any
 * description said so, so the model reasoned as if every call it made
 * started a process on the spot.
 */
export const DELEGATION_PACING_NOTE =
	"Launching many is safe: the harness paces them. Each agent starts when a node has room for it and waits in a queue until then, so asking for more than can run at once overloads nothing -- it only means some start later. A call returns when every agent in it has finished, and your next message is sent only after that -- so ask for the whole job at once: one `spawn_agent` call whose `agents` list holds every agent (a configured agent by `type`, several of one kind with `count`), or every call in the same message.";

export function createSubagentProgress(
	emitUpdate: ((update: unknown) => void) | undefined,
	forward?: (event: AgentEvent) => void,
	now: () => number = Date.now,
): SubagentProgress {
	let toolCalls = 0;
	// The tail of what it is writing, and separately of what it is thinking:
	// an agent deep in reasoning has written nothing, and "nothing" is not what
	// it is doing.
	let text = "";
	let reasoning = "";
	let lastReport = Number.NEGATIVE_INFINITY;
	// Generation speed, measured over each report window. A streamed delta is
	// one token as the engines here send them (llama.cpp and ollama stream per
	// token), so deltas per second is tokens per second, near enough to tell a
	// crawling agent from a working one -- which is what it is shown for.
	let deltas = 0;
	let windowStart = Number.NaN;
	let genTps: number | undefined;
	const tail = (value: string) =>
		value.length > SUBAGENT_OUTPUT_TAIL_CHARS
			? value.slice(value.length - SUBAGENT_OUTPUT_TAIL_CHARS)
			: value;
	const reportOutput = (force: boolean) => {
		const at = now();
		if (!force && at - lastReport < SUBAGENT_OUTPUT_REPORT_MS) {
			return;
		}
		lastReport = at;
		if (deltas > 0 && at > windowStart) {
			genTps = Math.round((deltas / ((at - windowStart) / 1000)) * 10) / 10;
		}
		deltas = 0;
		// A forced report ends a block: whatever comes next starts after a model
		// round trip, which is not generation time.
		windowStart = force ? Number.NaN : at;
		const latestOutput = text.trim() ? text : reasoning;
		if (latestOutput.trim()) {
			emitUpdate?.({
				latestOutput: latestOutput.trim(),
				latestOutputKind: text.trim() ? "text" : "reasoning",
				...(genTps !== undefined ? { genTps } : {}),
			});
		}
	};
	const countDelta = () => {
		if (Number.isNaN(windowStart)) {
			windowStart = now();
		}
		deltas += 1;
	};
	return {
		observe(event: AgentEvent): void {
			forward?.(event);
			if (!emitUpdate) {
				return;
			}
			if (event.type === "content_start" && event.contentType === "text") {
				countDelta();
				text = tail(text + (event.text ?? ""));
				reportOutput(false);
				return;
			}
			if (event.type === "content_start" && event.contentType === "reasoning") {
				countDelta();
				reasoning = tail(reasoning + (event.reasoning ?? event.text ?? ""));
				reportOutput(false);
				return;
			}
			if (
				event.type === "content_end" &&
				(event.contentType === "text" || event.contentType === "reasoning")
			) {
				reportOutput(true);
				return;
			}
			// Only the start of a tool. `content_end` would report what it has
			// just stopped doing, and a sub-agent between tools is thinking
			// rather than running the last one it finished.
			if (
				event.type !== "content_start" ||
				event.contentType !== "tool" ||
				!event.toolName
			) {
				return;
			}
			toolCalls += 1;
			// A new step: what it wrote before is the previous step's. So is the
			// speed window: time spent running a tool is not generation.
			text = "";
			reasoning = "";
			deltas = 0;
			windowStart = Number.NaN;
			emitUpdate({ latestToolCall: event.toolName, toolCalls });
		},
	};
}
