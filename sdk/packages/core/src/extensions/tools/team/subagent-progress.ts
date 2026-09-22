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

export function createSubagentProgress(
	emitUpdate: ((update: unknown) => void) | undefined,
	forward?: (event: AgentEvent) => void,
): SubagentProgress {
	let toolCalls = 0;
	return {
		observe(event: AgentEvent): void {
			forward?.(event);
			if (!emitUpdate) {
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
			emitUpdate({ latestToolCall: event.toolName, toolCalls });
		},
	};
}
