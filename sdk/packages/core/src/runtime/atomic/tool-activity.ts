import type {
	AgentTool,
	AgentToolContext,
	AgentToolDefinition,
} from "@cline/shared";

/**
 * Signal every tool call, whatever the tool and whatever it returns.
 *
 * `withChangeSignal` answers "did a file change in this transaction". This
 * answers the question before it — "was this transaction ever attempted" — and
 * the two are not the same. A transaction the model worked in for twenty turns
 * and left with no net change was attempted and failed. A transaction it spent
 * thinking, calling nothing, was not attempted at all, and the difference
 * decides whether it is fair to spend it.
 *
 * Wrapped outermost, so it counts calls the check-first gate refuses. A refused
 * edit is still the model reaching for a tool: it began.
 */
export function withAnyToolSignal<T extends AgentToolDefinition>(
	tools: readonly T[],
	onCall: (name: string) => void,
): T[] {
	return tools.map((tool) => {
		const original = tool as unknown as AgentTool<unknown, unknown>;
		return {
			...original,
			execute: async (input: unknown, context: AgentToolContext) => {
				// Before the call, for the same reason `withChangeSignal` does it
				// before: a tool that throws was still called.
				onCall(tool.name);
				return original.execute(input, context);
			},
		} as unknown as T;
	});
}
