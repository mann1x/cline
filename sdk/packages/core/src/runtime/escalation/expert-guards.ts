/**
 * The same guards that decide the base model is stuck, run on the expert.
 *
 * The escalation path has always had one direction. A guard notices the base
 * model going round in circles and offers it an expert; nothing then watches
 * the expert, and the measured failure that motivated this is an expert doing
 * exactly what the base was doing -- the nemotron 3 nano run the user named,
 * which rewrote the same file over and over while the base sat blocked inside
 * a tool call with no way to see it or stop it.
 *
 * So the guards run in both directions (user, 2026-09-14: "the same that
 * triggered an escalation can be used on the expert to trigger deescalation").
 * What comes out is NOT a decision. These verdicts do not end the expert's run,
 * do not cancel the escalation and do not roll anything back: they become a
 * note, the note wakes the base model, and the base model -- which can read the
 * files, run the check and see what the expert actually delivered -- decides.
 * That is deliberate. A guard that ended an expert's run would be the same
 * automation the base model is there to replace, and every threshold here has a
 * known false-positive rate that is fine for a nudge and not fine for a kill.
 *
 * THE WORDING IS FOR THE READER, NOT THE SUBJECT. Both detectors write their
 * messages at the model being measured -- "this call was refused, move on to
 * the next thing". Handed to the base model unchanged, that reads as an
 * instruction to the base about its own work, which it is not doing. Each
 * verdict is re-framed here as an observation about somebody else.
 */

import type { AgentEvent } from "@cline/shared";
import { LoopDetectionTracker } from "../safety/loop-detection";
import {
	createStruggleFeed,
	StruggleDetector,
	type StruggleThresholds,
} from "../safety/struggle-detector";

export interface ExpertGuardVerdict {
	/** Which guard spoke. */
	kind: "loop" | "struggle";
	/** Worded for the base model, as an observation about the expert. */
	text: string;
}

export interface ExpertGuardOptions {
	onVerdict: (verdict: ExpertGuardVerdict) => void;
	/** The struggle detector's operating point, where the host sets one. */
	thresholds?: Partial<StruggleThresholds>;
}

export interface ExpertGuards {
	/** Fold one of the expert's events in. */
	observe(event: AgentEvent): void;
	/** A new escalation is a new question. Forget the last one's evidence. */
	reset(): void;
}

/**
 * What the base model is told, and what it is told to do about it.
 *
 * The second half matters more than the first. A base model handed "the expert
 * has called `editor` five times with the same arguments" and nothing else has
 * a fact and no authority; it is the smaller model, it is being supervised by
 * the bigger one in every other respect, and left to itself it waits. It is
 * told here, every time, that stopping the expert is its call to make.
 */
const YOURS_TO_JUDGE =
	"This is evidence, not a verdict — a hard task looks like this too. Look at what the expert has actually changed before you act on it. If you decide it is going nowhere, `escalate` with `message` and say so, or tell it to stop.";

function loopText(message: string): string {
	return `The expert is repeating itself. ${message}\n\n${YOURS_TO_JUDGE}`;
}

function struggleText(message: string): string {
	return `The expert's run has the shape of a stuck one. ${message}\n\n${YOURS_TO_JUDGE}`;
}

export function createExpertGuards(options: ExpertGuardOptions): ExpertGuards {
	/**
	 * Repetition only, and knowingly so.
	 *
	 * The tracker's sharpest verdicts -- "this call was already refused as a
	 * no-op", "this call already succeeded" -- come from the tool RESULTS,
	 * which the session that owns the expert sees and this does not. Driven
	 * from the event stream it degrades to what the signature alone supports:
	 * the same call, with the same arguments, again. That is exactly the
	 * observation the base model needs, and the expert's own runtime still runs
	 * a complete tracker of its own over the results.
	 */
	let loops = new LoopDetectionTracker();
	let detector = new StruggleDetector(options.thresholds);
	let feed = createStruggleFeed(detector, (verdict) => {
		if (verdict.message) {
			options.onVerdict({
				kind: "struggle",
				text: struggleText(verdict.message),
			});
		}
	});
	/** Loop verdicts already passed on, so the same one is said once. */
	let said = new Set<string>();

	return {
		observe(event: AgentEvent): void {
			feed.observe(event);
			if (
				event.type !== "content_start" ||
				event.contentType !== "tool" ||
				!event.toolName
			) {
				return;
			}
			const verdict = loops.inspect({
				name: event.toolName,
				input: event.input,
			});
			if (verdict.kind === "ok" || !verdict.message) {
				return;
			}
			const key = `${verdict.kind}:${event.toolName}`;
			if (said.has(key)) {
				return;
			}
			said.add(key);
			options.onVerdict({ kind: "loop", text: loopText(verdict.message) });
		},
		reset(): void {
			loops = new LoopDetectionTracker();
			detector = new StruggleDetector(options.thresholds);
			feed = createStruggleFeed(detector, (verdict) => {
				if (verdict.message) {
					options.onVerdict({
						kind: "struggle",
						text: struggleText(verdict.message),
					});
				}
			});
			said = new Set<string>();
		},
	};
}
