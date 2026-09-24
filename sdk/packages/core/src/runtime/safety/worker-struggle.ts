/**
 * Struggle supervision for a headless delegated worker.
 *
 * The lead session has had a struggle layer for a while: the {@link
 * StruggleDetector} scores a run, {@link createStruggleFeed} drives it from the
 * event stream, and {@link withStruggleSuggestion} lands the verdict on the
 * next tool result. A delegated worker had none of it.
 *
 * What the worker layer does was set by replaying the two 75-agent swarms from
 * pandorum (sessions yglnz and ysde8, 150 workers) through it, not by reasoning
 * about what a stuck worker looks like. The replay overturned the first guess:
 *
 *  - **The loop is thinking that runs out its budget, turn after turn.** The
 *    one worker that looped (`k76ar4`) spent its whole thinking budget on 9 of
 *    18 turns -- each ending on the engine's "I have used my thinking budget"
 *    -- while telling itself "I have enough evidence to write the report" and
 *    probing once more. That is not exact repetition (the repeat guards stay
 *    quiet) and not a long run (it died at turn 18). Across the other 149
 *    workers only one hit the budget more than twice, and it answered.
 *
 *  - **Long is not stuck.** The longest workers (29, 36, 43 turns) all
 *    answered in the end; they spent their tokens on edits, not on thought. A
 *    turn-count stop, and a stop on the detector's refused-edit streak, would
 *    have ended three of them before they reported. So both are nudge-only
 *    here. A nudge costs a paragraph on a tool result; a stop costs a report.
 *
 * The terminal action a headless worker can take is *nudge once, then
 * recover-and-stop*: the first trigger holds a worker-shaped nudge ("commit
 * your best finding now as a SUMMARY") for the next tool result; only the
 * budget loop carrying on after it -- past a grace window, so the nudge has a
 * chance to land -- stops the worker, through the supervisor's abort signal.
 * The stop is not data loss: the swarm's digest recovery reads whatever the
 * worker produced, its reasoning tail included, so a stopped worker still
 * reports. On the replay: `k76ar4` is nudged at turn 6 and stopped at turn 13,
 * and no worker that answered is stopped.
 */

import type { AgentEvent, AgentToolDefinition } from "@cline/shared";
import { reasoningHitBudget } from "../../extensions/context/capped-thinking";
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

/** Turns the budget loop is looked for over. */
export const WORKER_BUDGET_WINDOW = 6;

/** Budget-exhausted turns inside the window that earn the nudge. */
export const WORKER_BUDGET_TURNS_TO_NUDGE = 3;

/** Budget-exhausted turns after the grace window that stop the worker. */
export const WORKER_BUDGET_TURNS_TO_STOP = 2;

/** Turns the nudge is given to land before anything counts toward a stop. */
export const WORKER_STRUGGLE_GRACE_ITERATIONS = 2;

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

/** Which signal moved the phase. */
export type WorkerStruggleReason =
	| "struggle"
	| "non-progress"
	| "thinking-budget";

export interface WorkerStruggleOptions {
	/** Detector thresholds; defaults to {@link WORKER_STRUGGLE_THRESHOLDS}. */
	thresholds?: StruggleThresholds;
	/** Turns of tool-calling with no answer before the one nudge. */
	nudgeAfterIterations?: number;
	/**
	 * The server's thinking-budget message, when the session knows it.
	 *
	 * Without it, a turn counts as budget-exhausted when its reasoning ends on
	 * the generic admission -- see `reasoningHitBudget`.
	 */
	thinkingBudgetMessage?: string;
	/** See {@link WORKER_BUDGET_WINDOW}. */
	budgetWindow?: number;
	/** See {@link WORKER_BUDGET_TURNS_TO_NUDGE}. */
	budgetTurnsToNudge?: number;
	/** See {@link WORKER_BUDGET_TURNS_TO_STOP}. */
	budgetTurnsToStop?: number;
	/** Turns the worker is given to heed the nudge before a stop can count. */
	graceIterations?: number;
	/** Overrides the nudge text; by default it is worded for what fired it. */
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
 * can do is stop and report -- the swarm digest is a free-form `SUMMARY:` text
 * turn -- so that is the instruction. The opening line says what was measured,
 * because "you keep running out of thinking" is actionable in a way "you have
 * been going a while" is not.
 */
export function describeWorkerNudge(reason?: WorkerStruggleReason): string {
	const measured =
		reason === "thinking-budget"
			? "Your thinking has run out its whole budget on turn after turn, and each time you have gone back for one more probe instead of answering."
			: reason === "struggle"
				? "Your recent calls keep coming back refused or failing."
				: "You have spent many turns on this without converging.";
	return [
		`${measured} You are a background worker: you cannot hand this to an expert or split it further, and the turns left before this task is stopped for you are few.`,
		"",
		"Commit what you have now. Write your final answer as a SUMMARY of what you found — what you are sure of, what you are not, and anything still open — rather than taking another probe at the same thing. A partial finding you report is worth more than a complete one the stop throws away.",
	].join("\n");
}

export function createWorkerStruggleSupervisor(
	options: WorkerStruggleOptions = {},
): WorkerStruggleSupervisor {
	const nudgeAfter =
		options.nudgeAfterIterations ?? WORKER_NUDGE_AFTER_ITERATIONS;
	const window = options.budgetWindow ?? WORKER_BUDGET_WINDOW;
	const toNudge = options.budgetTurnsToNudge ?? WORKER_BUDGET_TURNS_TO_NUDGE;
	const toStop = options.budgetTurnsToStop ?? WORKER_BUDGET_TURNS_TO_STOP;
	const grace = options.graceIterations ?? WORKER_STRUGGLE_GRACE_ITERATIONS;
	const controller = options.abortController ?? new AbortController();

	const detector = new StruggleDetector(
		options.thresholds ?? WORKER_STRUGGLE_THRESHOLDS,
	);
	const pending: PendingSuggestion = createPendingSuggestion();

	let phase: WorkerStrugglePhase = "watching";
	let iteration = 0;
	let nudgedAtIteration: number | undefined;
	/** Whether the current iteration's reasoning ran out its budget. */
	let spentThisIteration = false;
	/** Iterations whose reasoning ran out its budget, oldest first. */
	const spentIterations: number[] = [];

	const nudge = (reason: WorkerStruggleReason): void => {
		if (phase !== "watching") {
			return;
		}
		phase = "nudged";
		nudgedAtIteration = iteration;
		// Held, not appended to the conversation -- see `struggle-offer.ts`.
		pending.hold(options.nudgeMessage ?? describeWorkerNudge(reason));
		options.onTransition?.("nudged", reason);
	};

	const stop = (reason: WorkerStruggleReason): void => {
		if (phase !== "nudged") {
			return;
		}
		phase = "stopped";
		options.onTransition?.("stopped", reason);
		controller.abort();
	};

	// Every detector verdict -- the refused-edit streak, distress, the window --
	// says "the worker is struggling", and none of them stops it: on the replay
	// the workers they fired on went on to answer.
	const feed = createStruggleFeed(detector, () => {
		nudge("struggle");
	});

	const closeIteration = (): void => {
		if (spentThisIteration) {
			spentIterations.push(iteration);
		}
		spentThisIteration = false;
		if (phase === "watching") {
			const recent = spentIterations.filter(
				(spent) => spent > iteration - window,
			).length;
			if (recent >= toNudge) {
				nudge("thinking-budget");
			} else if (iteration >= nudgeAfter) {
				// A worker that had converged would have answered and ended the
				// run; reaching this count is itself the evidence. Nudge only.
				nudge("non-progress");
			}
			return;
		}
		if (phase === "nudged" && nudgedAtIteration !== undefined) {
			const countsFrom = nudgedAtIteration + grace;
			const after = spentIterations.filter(
				(spent) => spent > countsFrom,
			).length;
			if (after >= toStop) {
				stop("thinking-budget");
			}
		}
	};

	return {
		observe(event: AgentEvent): void {
			if (event.type === "iteration_start") {
				iteration = event.iteration;
				spentThisIteration = false;
			} else if (
				event.type === "content_end" &&
				event.contentType === "reasoning" &&
				reasoningHitBudget(
					event.reasoning ?? event.text ?? "",
					options.thinkingBudgetMessage,
				)
			) {
				spentThisIteration = true;
			}
			feed.observe(event);
			if (event.type === "iteration_end") {
				iteration = event.iteration;
				closeIteration();
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
