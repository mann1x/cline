/**
 * Spending a terminal guard on an escalation instead of on a stop.
 *
 * The evidence is the strongest in the study behind this feature. Of the 88
 * runs that did not end FIXED, 40 were ended by the repeated-call loop guard --
 * 45% of all failures -- and that same guard ended 3 of 243 successful runs.
 * The consecutive-mistake limit accounts for 2 more failures and no successes,
 * and the reasoning-loop streak for a handful. Precision here is structural
 * rather than statistical: these runs were over. Handing the task to the expert
 * at that exact moment cannot cost anything that was not already lost.
 *
 * What it must not become is a way around the guard. Two properties hold:
 *
 * - **Once per task.** The second time a terminal guard fires, it fires.
 * - **Deferred, never removed.** Taking the offer means calling `escalate` on
 *   the very next turn. A model that is given the turn and spends it on
 *   something else is stopped at the end of it, with the guard's own words.
 *
 * The second property is the one that needs machinery. The mistake limit's
 * `continue` resets its counter, so without this the run would get a fresh six
 * mistakes out of a guard that was about to end it.
 */

import type { AgentEvent, TerminalGuardDecision } from "@cline/shared";
import { ESCALATE_TOOL_NAME } from "./escalate-tool";

export interface ForcedEscalationOptions {
	/** Escalations still available. Zero means the guard stands as it is. */
	remaining: () => number;
	/** End the run, the way the guard was about to. */
	stop: (message: string) => void;
	logger?: { log?: (message: string) => void };
}

export interface ForcedEscalation {
	/**
	 * Answer a terminal guard, or leave it standing.
	 *
	 * `undefined` means this has nothing to offer — spent, or no budget — and
	 * the guard does exactly what it did before.
	 */
	decide(input: {
		/** The guard, in the model's own terms. */
		guard: string;
		diagnosis?: string;
	}): TerminalGuardDecision | undefined;
	/** Fold in one agent event, so the deferral can see whether it was taken. */
	observe(event: AgentEvent): void;
	/** Whether the offer has been made. */
	readonly spent: boolean;
}

/** What the model is told when a guard stands down for it. */
export function describeForcedEscalation(input: {
	guard: string;
	diagnosis?: string;
	remaining: number;
}): string {
	return [
		`${input.guard} was about to end this run.${input.diagnosis ? ` ${input.diagnosis}` : ""}`,
		"",
		`Instead you get one turn, and one thing to do with it: call \`${ESCALATE_TOOL_NAME}\` and hand this to the expert. Write the brief properly — what you were trying, what you ruled out, and what a correct result looks like — because that is all it gets. You have ${input.remaining} escalation${input.remaining === 1 ? "" : "s"} left.`,
		"",
		"If this turn goes anywhere else, the run ends at the end of it. That is not a threat, it is the guard that was already firing: nothing here has been taken off the table, it has only been held open for one turn.",
	].join("\n");
}

/** What the run is stopped with when the turn was spent on something else. */
export function describeMissedEscalation(guard: string): string {
	return `${guard} ended this run. It stood down for one turn so the task could be handed to the expert, and that turn was spent on something else.`;
}

export function createForcedEscalation(
	options: ForcedEscalationOptions,
): ForcedEscalation {
	let spent = false;
	/** The iteration the offer was made in, or undefined when not armed. */
	let armedAt: number | undefined;
	let armedGuard = "";
	let iteration = 0;

	return {
		get spent() {
			return spent;
		},
		decide(input) {
			if (spent) {
				return undefined;
			}
			const remaining = options.remaining();
			if (remaining <= 0) {
				return undefined;
			}
			spent = true;
			armedAt = iteration;
			armedGuard = input.guard;
			options.logger?.log?.(
				`[Escalation] ${input.guard} stood down for one turn; the expert can be handed the task.`,
			);
			return {
				action: "continue",
				guidance: describeForcedEscalation({
					guard: input.guard,
					...(input.diagnosis ? { diagnosis: input.diagnosis } : {}),
					remaining,
				}),
			};
		},
		observe(event: AgentEvent): void {
			switch (event.type) {
				case "iteration_start":
					iteration = event.iteration;
					return;
				case "content_start":
					// The offer was taken. Whether the escalation then succeeds is
					// not this object's business -- it asked for the call, and the
					// call was made.
					if (
						event.contentType === "tool" &&
						event.toolName === ESCALATE_TOOL_NAME
					) {
						armedAt = undefined;
					}
					return;
				case "iteration_end": {
					// Strictly after the turn the offer was made in: the guard fires
					// mid-turn, so that turn's end arrives before the model has had
					// a chance to answer.
					if (armedAt === undefined || event.iteration <= armedAt) {
						return;
					}
					const guard = armedGuard;
					armedAt = undefined;
					options.stop(describeMissedEscalation(guard));
					return;
				}
				default:
					return;
			}
		},
	};
}
