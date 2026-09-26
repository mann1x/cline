/**
 * A struggle supervisor's stop, in words: what a delegated run's abort reason
 * carries when the supervisor ended it (`worker-struggle.ts`).
 *
 * Its own module, importing nothing, because the iteration cap reads it
 * (`agent-iteration-cap.ts`, which suspends such a run for the lead, as it
 * does the loop guard's) and sits under every spawn path, while the
 * supervisor itself reaches back into the tools through the struggle offer.
 */

/** Which signal moved a supervisor's phase. */
export type WorkerStruggleReason =
	| "struggle"
	| "non-progress"
	| "thinking-budget";

/**
 * How a supervisor stop begins, so the run's abort reason says whose stop it
 * was (swarm 0926b: four workers ended outright by it, their work discarded).
 */
const WORKER_STRUGGLE_STOP_PREFIX = "Stopped by the struggle supervisor";

/** Whether a run's abort reason is a supervisor stop. */
export function isWorkerStruggleStop(reason: string | undefined): boolean {
	return (reason ?? "").startsWith(WORKER_STRUGGLE_STOP_PREFIX);
}

/**
 * The supervisor's stop, in words the lead reads when it decides: what was
 * measured, and that the worker had been told to commit a SUMMARY first.
 */
export function describeWorkerStop(
	reason: WorkerStruggleReason,
	counts: { spentAfterNudge?: number } = {},
): string {
	const what =
		reason === "thinking-budget"
			? `its thinking ran out its whole budget on ${counts.spentAfterNudge ?? "several"} more turn${counts.spentAfterNudge === 1 ? "" : "s"} after it was told to commit a SUMMARY of what it had, and it went back for another probe each time`
			: reason === "struggle"
				? "its calls kept coming back refused or failing after it was told to commit a SUMMARY"
				: "it kept going without converging after it was told to commit a SUMMARY";
	return `${WORKER_STRUGGLE_STOP_PREFIX} (${reason}): ${what}.`;
}
