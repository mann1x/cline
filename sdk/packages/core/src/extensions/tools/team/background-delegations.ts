/**
 * Delegations the user started and then went back to work.
 *
 * `delegateToConfiguredAgent` runs an agent and returns its answer, which is
 * the right shape for "run the QA agent on this and tell me". It is the wrong
 * shape for the reason people ask for it: the lead is blocked for as long as
 * the delegated run takes, and pressing stop on the lead takes the delegation
 * down with it. A run the user asked for should outlive the turn they asked in.
 *
 * So a background run is held here rather than on the turn. The registry owns
 * the three things such a run needs and a promise does not have: a way to be
 * paused, a way to be stopped, and a status somebody can render.
 *
 * Deliberately ignorant of how an agent runs. It is handed a `run` function and
 * gives it back the controls; the caller wires those into whatever it is
 * running. That keeps the delegation path -- provider resolution, the endpoint
 * slot gate, the per-agent tool filtering -- exactly the one the synchronous
 * path already uses, instead of a second copy of it that drifts.
 */

import type { AgentHooks } from "@cline/shared";
import type { ConfiguredAgentDelegationResult } from "./delegate-to-agent";

export type BackgroundDelegationStatus =
	| "running"
	| "paused"
	| "completed"
	| "failed"
	/** The user stopped it. Not a failure, and not to be reported as one. */
	| "stopped";

export interface BackgroundDelegationView {
	id: string;
	agentName: string;
	prompt: string;
	status: BackgroundDelegationStatus;
	startedAt: number;
	endedAt?: number;
	/** The last thing worth putting on a one-line row. */
	activity?: string;
	result?: ConfiguredAgentDelegationResult;
	error?: string;
}

export interface BackgroundDelegationControls {
	runId: string;
	/** Aborted when the user stops the run. */
	signal: AbortSignal;
	/**
	 * Hooks that suspend the run while it is paused.
	 *
	 * The barrier is in `beforeModel`, which the runtime awaits before every
	 * request, so a paused run stops between requests and never mid-stream.
	 * Pausing does not cancel the request already in flight -- that would throw
	 * away work the user has paid for and asked to keep.
	 */
	hooks: AgentHooks;
}

export interface StartBackgroundDelegationInput {
	agentName: string;
	prompt: string;
	run: (
		controls: BackgroundDelegationControls,
	) => Promise<ConfiguredAgentDelegationResult>;
	/**
	 * Called once when the run has finished, failed or been stopped.
	 *
	 * This is where a host delivers the answer back into the conversation. It
	 * runs outside the lead's turn by definition, so it must not assume there is
	 * one.
	 */
	onSettled?: (view: BackgroundDelegationView) => void;
}

export interface BackgroundDelegationRegistry {
	/** Starts the run and returns immediately. */
	start(input: StartBackgroundDelegationInput): BackgroundDelegationView;
	list(): BackgroundDelegationView[];
	get(id: string): BackgroundDelegationView | undefined;
	/** @returns whether there was a running run to pause. */
	pause(id: string): boolean;
	/** @returns whether there was a paused run to resume. */
	resume(id: string): boolean;
	/** @returns whether there was a live run to stop. */
	stop(id: string): boolean;
	/** Records what the run is doing, for the panel. */
	note(id: string, activity: string): void;
	/** Every change, for a panel that redraws. Returns an unsubscribe. */
	subscribe(listener: (runs: BackgroundDelegationView[]) => void): () => void;
	/** Stops everything. For a host tearing the session down for good. */
	stopAll(): void;
}

interface BackgroundRun {
	view: BackgroundDelegationView;
	controller: AbortController;
	/** Resolves when the run is let go again. Absent while it is not paused. */
	resume?: () => void;
}

/** Live means the user can still act on it. */
function isLive(status: BackgroundDelegationStatus): boolean {
	return status === "running" || status === "paused";
}

export function createBackgroundDelegationRegistry(options?: {
	now?: () => number;
	newId?: () => string;
}): BackgroundDelegationRegistry {
	const now = options?.now ?? (() => Date.now());
	const runs = new Map<string, BackgroundRun>();
	const listeners = new Set<(runs: BackgroundDelegationView[]) => void>();
	let counter = 0;
	const newId = options?.newId ?? (() => `bg_${++counter}`);

	const snapshot = (): BackgroundDelegationView[] =>
		[...runs.values()].map((run) => ({ ...run.view }));

	const announce = (): void => {
		const views = snapshot();
		for (const listener of listeners) {
			try {
				listener(views);
			} catch {
				// A panel that throws while redrawing must not take a run with it.
			}
		}
	};

	const settle = (
		run: BackgroundRun,
		patch: Partial<BackgroundDelegationView>,
		onSettled?: (view: BackgroundDelegationView) => void,
	): void => {
		// A run stopped by the user reports as stopped even though the agent it
		// was running threw an abort on the way out. The user knows why it
		// ended; calling it a failure would be the tool arguing with them.
		Object.assign(run.view, patch, { endedAt: now() });
		run.resume?.();
		run.resume = undefined;
		announce();
		if (onSettled) {
			try {
				onSettled({ ...run.view });
			} catch {
				// Delivery is the host's business and its failure is not the run's.
			}
		}
	};

	return {
		start(input) {
			const id = newId();
			const controller = new AbortController();
			const run: BackgroundRun = {
				view: {
					id,
					agentName: input.agentName,
					prompt: input.prompt,
					status: "running",
					startedAt: now(),
				},
				controller,
			};
			runs.set(id, run);

			const hooks: AgentHooks = {
				beforeModel: async () => {
					// A loop rather than a single await: a run can be paused again
					// while it is waking up from the last pause.
					while (run.view.status === "paused" && !controller.signal.aborted) {
						await new Promise<void>((resolve) => {
							run.resume = resolve;
						});
					}
					return undefined;
				},
			};

			input
				.run({ runId: id, signal: controller.signal, hooks })
				.then((result) => {
					if (!isLive(run.view.status)) {
						return;
					}
					settle(
						run,
						{ status: "completed", result, activity: undefined },
						input.onSettled,
					);
				})
				.catch((error: unknown) => {
					if (!isLive(run.view.status)) {
						return;
					}
					settle(
						run,
						controller.signal.aborted
							? { status: "stopped" }
							: {
									status: "failed",
									error: error instanceof Error ? error.message : String(error),
								},
						input.onSettled,
					);
				});

			announce();
			return { ...run.view };
		},

		list: snapshot,

		get(id) {
			const run = runs.get(id);
			return run ? { ...run.view } : undefined;
		},

		pause(id) {
			const run = runs.get(id);
			if (!run || run.view.status !== "running") {
				return false;
			}
			run.view.status = "paused";
			announce();
			return true;
		},

		resume(id) {
			const run = runs.get(id);
			if (!run || run.view.status !== "paused") {
				return false;
			}
			run.view.status = "running";
			run.resume?.();
			run.resume = undefined;
			announce();
			return true;
		},

		stop(id) {
			const run = runs.get(id);
			if (!run || !isLive(run.view.status)) {
				return false;
			}
			// Marked before the abort, so the rejection the abort causes is read
			// as the stop it is rather than as a failure of the agent.
			run.view.status = "stopped";
			run.view.endedAt = now();
			run.resume?.();
			run.resume = undefined;
			run.controller.abort();
			announce();
			return true;
		},

		note(id, activity) {
			const run = runs.get(id);
			if (!run || !isLive(run.view.status)) {
				return;
			}
			run.view.activity = activity;
			announce();
		},

		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		stopAll() {
			for (const run of runs.values()) {
				if (!isLive(run.view.status)) {
					continue;
				}
				run.view.status = "stopped";
				run.view.endedAt = now();
				run.resume?.();
				run.resume = undefined;
				run.controller.abort();
			}
			announce();
		},
	};
}
