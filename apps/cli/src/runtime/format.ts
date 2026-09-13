import { askQuestionInTerminal } from "../utils/approval";
import type { Config } from "../utils/types";

export function describeAbortSource(input: {
	abortRequested: boolean;
	timedOut: boolean;
	/** What the run said stopped it, when it said anything. */
	abortReason?: string;
}): string {
	if (input.timedOut) {
		return "aborted after timeout";
	}
	if (input.abortRequested) {
		return "aborted";
	}
	// Whatever the run itself reported beats a guess drawn from the two causes
	// this process happens to know about. Without it, a run stopped by its own
	// mistake limit was reported as "aborted by another client" — in a headless
	// run there is no other client, and the honest reason was sitting in the
	// runtime log while the machine-readable stream carried the invention.
	const reason = input.abortReason?.trim();
	if (reason) {
		return reason;
	}
	return "aborted by another client";
}

export async function resolveMistakeLimitDecision(
	config: Config,
	context: {
		iteration: number;
		consecutiveMistakes: number;
		maxConsecutiveMistakes: number;
		reason: "api_error" | "invalid_tool_call" | "tool_execution_failed";
		details?: string;
		/** The loop guard demanded the stop; the count did not reach the limit. */
		forced?: boolean;
	},
): Promise<
	| { action: "continue"; guidance?: string }
	| { action: "stop"; reason?: string }
> {
	const detail = context.details?.trim();
	const summary = detail
		? `${context.reason}: ${detail}`
		: `${context.reason} at iteration ${context.iteration}`;
	// Two different things end a run here and they used to read as one. A forced
	// stop is the loop guard: the count is whatever it happens to be, usually 1,
	// and reporting it as "max consecutive mistakes reached (6)" describes a
	// limit that was never approached. Measured: a run stopped by a repeated
	// `editor` call reported the mistake limit at one recorded mistake, and the
	// limit is where I went looking.
	const stopReason = context.forced
		? `repeated-call loop guard stopped the run at iteration ${context.iteration}${detail ? `: ${detail}` : ""}`
		: `max consecutive mistakes reached (${context.consecutiveMistakes}/${context.maxConsecutiveMistakes})`;
	const yoloEnabled = config.toolPolicies["*"]?.autoApprove !== false;
	if (yoloEnabled) {
		return {
			action: "stop",
			reason: context.forced ? stopReason : `${stopReason} in yolo mode`,
		};
	}
	if (context.forced) {
		// Not a question. The guard has already spent its warning and the model
		// sent the same call anyway; there is nothing for an answer to change.
		return { action: "stop", reason: stopReason };
	}
	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return {
			action: "stop",
			reason: `mistake_limit_reached: ${summary}`,
		};
	}
	const answer = await askQuestionInTerminal(
		`mistake_limit_reached (${context.consecutiveMistakes}/${context.maxConsecutiveMistakes})\nLatest: ${summary}\nHow should Cline continue?`,
		["Try a different approach", "Stop this run"],
	);
	const normalized = answer.trim().toLowerCase();
	if (
		normalized === "2" ||
		normalized === "stop this run" ||
		normalized === "stop" ||
		normalized === "n" ||
		normalized === "no"
	) {
		return {
			action: "stop",
			reason: "stopped after mistake_limit_reached prompt",
		};
	}
	if (
		normalized === "1" ||
		normalized === "try a different approach" ||
		normalized.length === 0
	) {
		return {
			action: "continue",
			guidance:
				"mistake_limit_reached: retry with a different approach, validate tool parameters before calls, and avoid repeating failed steps.",
		};
	}
	return {
		action: "continue",
		guidance: `mistake_limit_reached: ${answer.trim()}`,
	};
}
