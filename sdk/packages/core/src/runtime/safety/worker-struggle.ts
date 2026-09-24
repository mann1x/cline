/**
 * Struggle supervision for a headless delegated worker.
 *
 * The lead session has had a struggle layer for a while: the {@link
 * StruggleDetector} scores a run, {@link createStruggleFeed} drives it from the
 * event stream, and {@link withStruggleSuggestion} lands the verdict on the
 * next tool result. A delegated worker had none of it, and it shows: on the
 * 75-agent swarm on pandorum, 25 of 75 workers ground to the token cap on
 * slightly-varying probes without ever emitting a digest, and the only backstop
 * was `maxIterations`.
 *
 * This wires that same layer onto a worker, with two differences the worker's
 * position forces:
 *
 *  - **A non-progress signal the lead does not need.** The detector catches the
 *    failing-edit grind (an unbroken run of refused edits) and the distress the
 *    model narrates. It cannot catch the *grep-grind*: a worker issuing
 *    successful-but-varying probes at one sub-problem, thinking large and varied
 *    each turn, that never converges. Nothing there fails and nothing repeats
 *    exactly, so the only thing separating it from a productive worker is the
 *    turn count. That is what {@link WorkerStruggleOptions.nudgeAfterIterations}
 *    reads.
 *
 *  - **A terminal action a headless worker can actually take.** The lead's
 *    verdict offers the expert or a subagent; a worker can do neither. So the
 *    action is *nudge once, then recover-and-stop*: the first trigger holds a
 *    worker-shaped nudge ("commit your best finding now as a SUMMARY") for the
 *    next tool result; a worker that keeps grinding past a grace window is
 *    stopped outright via the supervisor's abort signal. The stop is not data
 *    loss -- the swarm's digest recovery reads whatever the worker produced,
 *    including its reasoning tail, so a stopped worker still reports.
 *
 * The two triggers converge on one two-stage machine: `watching -> nudged ->
 * stopped`. Whichever fires first -- a detector verdict or the turn count --
 * moves the phase; the second stage waits out a grace window so the nudge it
 * just handed the worker has a chance to land before the stop.
 */

import type { AgentEvent, AgentToolDefinition } from "@cline/shared";
import {
	createPendingSuggestion,
	type PendingSuggestion,
	withStruggleSuggestion,
} from "../escalation/struggle-offer";
import {
	createStruggleFeed,
	StruggleDetector,
	type StruggleThresholds,
} from "./struggle-detector";

/**
 * Before this iteration the detector's window/distress path stays quiet.
 *
 * The lead floors this at 20 because a run stuck at iteration 12 is
 * indistinguishable from one still reading the problem. A worker's whole life
 * is shorter -- its `maxIterations` is ~40, not the lead's hundreds -- so the
 * same floor would gate the signal out of most of the run. Lowered here; the
 * edit-streak path fires outside this floor either way.
 */
export const WORKER_STRUGGLE_MIN_ITERATION = 8;

/** Tool-calling turns without a final answer before the one nudge. */
export const WORKER_NUDGE_AFTER_ITERATIONS = 20;

/** Turns before the worker is stopped for it. Sits below a worker's `maxIterations`. */
export const WORKER_STOP_AFTER_ITERATIONS = 30;

/** Turns the nudge is given to land before a stop can fire. */
export const WORKER_STRUGGLE_GRACE_ITERATIONS = 4;

/**
 * Worker-calibrated detector thresholds.
 *
 * Only the iteration floor moves; the failure/edit/transaction counts are the
 * lead's, calibrated over the harness corpus and no less true of a worker.
 */
export const WORKER_STRUGGLE_THRESHOLDS: StruggleThresholds = {
	minIteration: WORKER_STRUGGLE_MIN_ITERATION,
};

export type WorkerStrugglePhase = "watching" | "nudged" | "stopped";

/** Which of the two signals moved the phase. */
export type WorkerStruggleReason = "struggle" | "non-progress";

export interface WorkerStruggleOptions {
	/** Detector thresholds; defaults to {@link WORKER_STRUGGLE_THRESHOLDS}. */
	thresholds?: StruggleThresholds;
	/** Turns of tool-calling with no answer before the one nudge. */
	nudgeAfterIterations?: number;
	/** Turns before the supervisor stops the worker outright. */
	stopAfterIterations?: number;
	/** Turns the worker is given to heed the nudge before a stop can fire. */
	graceIterations?: number;
	/** The message held for the worker's next tool result. */
	nudgeMessage?: string;
	/** Called on every phase transition, for logging and telemetry. */
	onTransition?: (
		phase: WorkerStrugglePhase,
		reason: WorkerStruggleReason,
	) => void;
	/**
	 * The controller whose signal stops the worker.
	 *
	 * A spawn path that already owns the worker's abort controller passes it so
	 * one signal carries both the outer cancellation and this supervisor's stop.
	 * Omitted, the supervisor owns one of its own.
	 */
	abortController?: AbortController;
}

export interface WorkerStruggleSupervisor {
	/** Fold one agent event into the detector and the turn counter. */
	observe(event: AgentEvent): void;
	/** Wrap the worker's tools so the held nudge lands on the next result. */
	wrapTools<T extends AgentToolDefinition>(tools: readonly T[]): T[];
	/** Aborts when the worker is stopped. Pass to the delegated agent's runtime. */
	readonly stopSignal: AbortSignal;
	/** Which stage of the machine the supervisor is in. */
	readonly phase: WorkerStrugglePhase;
}

/**
 * The nudge a headless worker is handed, worded for what it can actually do.
 *
 * The lead's nudge names the expert and `spawn_agent`; a worker has neither, so
 * naming them would be telling it to reach for a tool it does not hold. What it
 * can do is stop grinding and report -- the swarm digest is a free-form
 * `SUMMARY:` text turn -- so that is the whole message. Observation and a single
 * instruction, no threat: the stop is the mechanism's, not the model's to fear.
 */
export function describeWorkerNudge(): string {
	return [
		"You have spent many turns on this without converging, and you are a background worker: you cannot hand this to an expert or split it further, and the turns left before this task is stopped for you are few.",
		"",
		"Commit what you have now. Write your final answer as a SUMMARY of what you found — what you are sure of, what you are not, and anything still open — rather than taking another probe at the same thing. A partial finding you report is worth more than a complete one the stop throws away.",
	].join("\n");
}

export function createWorkerStruggleSupervisor(
	options: WorkerStruggleOptions = {},
): WorkerStruggleSupervisor {
	const nudgeAfter =
		options.nudgeAfterIterations ?? WORKER_NUDGE_AFTER_ITERATIONS;
	const stopAfter = options.stopAfterIterations ?? WORKER_STOP_AFTER_ITERATIONS;
	const grace = options.graceIterations ?? WORKER_STRUGGLE_GRACE_ITERATIONS;
	const nudgeMessage = options.nudgeMessage ?? describeWorkerNudge();
	const controller = options.abortController ?? new AbortController();

	const detector = new StruggleDetector(
		options.thresholds ?? WORKER_STRUGGLE_THRESHOLDS,
	);
	const pending: PendingSuggestion = createPendingSuggestion();

	let phase: WorkerStrugglePhase = "watching";
	let iteration = 0;
	let nudgedAtIteration: number | undefined;

	const trigger = (reason: WorkerStruggleReason): void => {
		if (phase === "watching") {
			phase = "nudged";
			nudgedAtIteration = iteration;
			// Held, not appended to the conversation -- see `struggle-offer.ts`.
			pending.hold(nudgeMessage);
			options.onTransition?.("nudged", reason);
			return;
		}
		if (phase === "nudged") {
			// Wait out the grace window: a stop the turn after the nudge would
			// pull the worker before the nudge it was just handed reaches a tool
			// result.
			if (
				nudgedAtIteration !== undefined &&
				iteration - nudgedAtIteration < grace
			) {
				return;
			}
			phase = "stopped";
			options.onTransition?.("stopped", reason);
			controller.abort();
		}
	};

	// The detector's verdicts -- the failing-edit streak, distress, the window --
	// are all "the worker is struggling". A worker cannot escalate, so nudge and
	// suggest mean the same thing to the machine.
	const feed = createStruggleFeed(detector, () => {
		trigger("struggle");
	});

	return {
		observe(event: AgentEvent): void {
			if (event.type === "iteration_start" || event.type === "iteration_end") {
				iteration = event.iteration;
			}
			feed.observe(event);
			if (event.type !== "iteration_end") {
				return;
			}
			// The non-progress signal: turns elapsed with the run still going. A
			// worker that had converged would have answered and ended the run, so
			// reaching these counts is itself the evidence.
			if (phase === "watching" && iteration >= nudgeAfter) {
				trigger("non-progress");
			} else if (phase === "nudged" && iteration >= stopAfter) {
				trigger("non-progress");
			}
		},
		wrapTools<T extends AgentToolDefinition>(tools: readonly T[]): T[] {
			return withStruggleSuggestion(tools, pending);
		},
		get stopSignal(): AbortSignal {
			return controller.signal;
		},
		get phase(): WorkerStrugglePhase {
			return phase;
		},
	};
}
