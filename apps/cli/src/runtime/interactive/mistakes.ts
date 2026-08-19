export interface MistakeLimitContext {
	iteration: number;
	consecutiveMistakes: number;
	maxConsecutiveMistakes: number;
	reason: "api_error" | "invalid_tool_call" | "tool_execution_failed";
	details?: string;
	/** The loop guard demanded the stop; the count did not reach the limit. */
	forced?: boolean;
}

export function createMistakeLimitDecisionResolver(input: {
	autoApproveAllRef: { current: boolean };
	askQuestionRef: {
		current: ((question: string, options: string[]) => Promise<string>) | null;
	};
}) {
	return async (context: MistakeLimitContext) => {
		const detail = context.details?.trim();
		const summary = detail
			? `${context.reason}: ${detail}`
			: `${context.reason} at iteration ${context.iteration}`;
		// The loop guard and the mistake limit end a run for different reasons and
		// have to say so. `consecutiveMistakes` on a forced stop is whatever it
		// happened to be, and naming the limit instead points at a threshold that
		// was never reached.
		if (context.forced) {
			return {
				action: "stop" as const,
				reason: `repeated-call loop guard stopped the run at iteration ${context.iteration}${detail ? `: ${detail}` : ""}`,
			};
		}
		if (input.autoApproveAllRef.current) {
			return {
				action: "stop" as const,
				reason: `max consecutive mistakes reached (${context.consecutiveMistakes}/${context.maxConsecutiveMistakes}) in yolo mode`,
			};
		}
		const questionText = `mistake_limit_reached (${context.consecutiveMistakes}/${context.maxConsecutiveMistakes})\nLatest: ${summary}\nHow should Cline continue?`;
		const questionOptions = ["Try a different approach", "Stop this run"];
		const answer = input.askQuestionRef.current
			? await input.askQuestionRef.current(questionText, questionOptions)
			: (questionOptions[0] ?? "");
		const normalized = answer.trim().toLowerCase();
		if (
			normalized === "2" ||
			normalized === "stop this run" ||
			normalized === "stop" ||
			normalized === "n" ||
			normalized === "no"
		) {
			return {
				action: "stop" as const,
				reason: "stopped after mistake_limit_reached prompt",
			};
		}
		if (
			normalized === "1" ||
			normalized === "try a different approach" ||
			normalized.length === 0
		) {
			return {
				action: "continue" as const,
				guidance:
					"mistake_limit_reached: retry with a different approach, validate tool parameters before calls, and avoid repeating failed steps.",
			};
		}
		return {
			action: "continue" as const,
			guidance: `mistake_limit_reached: ${answer.trim()}`,
		};
	};
}
