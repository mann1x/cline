/**
 * The harness's own reading of why the model says it is stuck.
 *
 * The model's account of its own difficulty is the one piece of evidence it
 * has an interest in. So this is computed beside it, from things that were
 * counted rather than described, and both are shown: to the user before an
 * approval, and to the expert in the brief, where a disagreement between the
 * two is itself worth reading.
 *
 * Every line here is a measurement with a known error rate, taken from the
 * replay of 360 harness runs that produced the trigger next door. What is
 * deliberately absent is a verdict: none of these separates a hard task from a
 * stuck model on its own, and a line that said "this model cannot do it" would
 * be claiming a precision nothing in the study supports.
 */

import type { StruggleSignals } from "../safety/struggle-detector";

export interface EscalationAssessmentInput {
	/** Where the run is, so the reader can weigh the rest. */
	iteration?: number;
	/** The struggle detector's window, whether or not it fired. */
	signals?: StruggleSignals;
	transactions?: {
		/** Transactions opened so far, including the one that is open. */
		opened: number;
		/** Judged and rolled back. */
		discarded: number;
		/** Judged, not kept, and left on disk because the check's answer moved. */
		carried?: number;
	};
	/** A terminal guard has already stood down once for this task. */
	guardStoodDown?: boolean;
	/**
	 * What the complexity walker made of the files in play, already worded.
	 *
	 * A tiebreaker and nothing more. It measures how hard the code is to read,
	 * not how likely this model is to fix it, and each line says so where it is
	 * read -- the same discipline `check_file` keeps about its own bound.
	 */
	complexity?: readonly string[];
	/**
	 * An outside scorer's reading of the task, already worded -- Jev's
	 * complexity and "stuck" scores, where the host configured it. Each line
	 * says whose reading it is and what it saw; it is not one of the counts.
	 */
	appraisal?: readonly string[];
}

/**
 * Render the assessment, or nothing when nothing was measured.
 *
 * Nothing is a real answer: an escalation on turn three has no window behind
 * it, and a section reading "0 failures, no transactions" would be presented
 * as evidence of health when it is evidence of a run that has not started.
 */
export function buildEscalationAssessment(
	input: EscalationAssessmentInput,
): string | undefined {
	const lines: string[] = [];
	const signals = input.signals;
	if (signals) {
		lines.push(
			`Failed or refused tool calls in the last 10 turns: ${signals.failedCalls}.`,
		);
		if (signals.distress > 0) {
			lines.push(
				`Distress language in the model's own reasoning over the same turns: ${signals.distress} occurrence${signals.distress === 1 ? "" : "s"}. Measured on its own this separates nothing — it fires on 46% of successful runs by strong models — so read it with the line above, not instead of it.`,
			);
		}
		if (signals.hedgingRatio !== undefined) {
			lines.push(
				signals.hedgingRatio >= 1
					? `Hedging is running at ${signals.hedgingRatio.toFixed(2)}× this run's own opening rate. A run that converges hedges less as it goes: over 317 replayed runs the ones that finished fell to 0.62×, and the ones that did not held at 0.86×.`
					: `Hedging has fallen to ${signals.hedgingRatio.toFixed(2)}× this run's opening rate, which is the shape of a run that is converging rather than one that is stuck.`,
			);
		}
	}
	if (input.transactions && input.transactions.opened > 0) {
		const { opened, discarded, carried } = input.transactions;
		lines.push(
			`Transactions: ${opened} opened, ${discarded} judged and rolled back${
				carried ? `, ${carried} carried forward unverified` : ""
			}.`,
		);
	}
	for (const line of input.complexity ?? []) {
		lines.push(line);
	}
	for (const line of input.appraisal ?? []) {
		lines.push(line);
	}
	if (input.guardStoodDown) {
		lines.push(
			"A terminal guard has already stood down once for this task: the run was going to end, and was held open instead.",
		);
	}
	if (lines.length === 0) {
		return undefined;
	}
	if (input.iteration !== undefined) {
		lines.unshift(`Turn ${input.iteration} of this task.`);
	}
	lines.push(
		"None of this is a verdict on whether the task is hard or the model is stuck — nothing measured here separates those two on its own. It is the evidence, so you can weigh it against what you were told.",
	);
	return lines.join("\n");
}
