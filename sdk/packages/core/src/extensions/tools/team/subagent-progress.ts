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
		const latestOutput = text.trim() ? text : reasoning;
		if (latestOutput.trim()) {
			emitUpdate?.({
				latestOutput: latestOutput.trim(),
				latestOutputKind: text.trim() ? "text" : "reasoning",
			});
		}
	};
	return {
		observe(event: AgentEvent): void {
			forward?.(event);
			if (!emitUpdate) {
				return;
			}
			if (event.type === "content_start" && event.contentType === "text") {
				text = tail(text + (event.text ?? ""));
				reportOutput(false);
				return;
			}
			if (event.type === "content_start" && event.contentType === "reasoning") {
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
			// A new step: what it wrote before is the previous step's.
			text = "";
			reasoning = "";
			emitUpdate({ latestToolCall: event.toolName, toolCalls });
		},
	};
}
