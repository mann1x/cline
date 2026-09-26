/**
 * Stopping one sub-agent without stopping the session.
 *
 * A delegated agent used to run on the parent's abort signal alone, so the
 * only way to stop a runaway one was to cancel the whole task -- losing the
 * lead's context and every sibling agent that was working correctly. A fan-out
 * of five where one grinds is the case: four reports are already written, and
 * the only control on screen cancels all of them.
 *
 * So each spawned agent gets a signal of its own, and it is registered here
 * while it runs. The registry is the process's, keyed by session and tool
 * call: the id is what the chat row is already keyed by, so a row can name the
 * agent it is showing without inventing an identity for it.
 *
 * Deliberately plain. It holds only live runs -- registration is released in
 * the spawn tool's `finally`, on every path -- so nothing here outlives the
 * agent it refers to, and a stop for an agent that has already finished is a
 * no-op rather than an error.
 */

/** Who stopped an agent, for the reason its report gives. */
export type SubagentStopActor = "user" | "lead";

/** What a requeue carries into the agent's next placement. */
export interface SubagentRequeueOptions {
	/** Why the lead moved it, in its words or one of the named reasons. */
	reason?: string;
	/** The node to place it anywhere but, when another has room. */
	avoidNodeId?: string;
}

/**
 * An agent's run that was stopped at a boundary to be placed again: its
 * transcript, and where not to put it.
 */
export interface SubagentRequeueCarry {
	messages: readonly unknown[];
	reason?: string;
	avoidNodeId?: string;
}

/** The live control state of one agent, for the lead's status tool. */
export interface SubagentControlState {
	label: string;
	/** A requeue was asked for and has not yet happened. */
	requeuePending: boolean;
	/** Waiting on infrastructure right now (a refusal, a server gone). */
	waitingInfra: boolean;
}

export interface SubagentCancellation {
	/**
	 * Stop this agent. `false` when nothing by that id is running. `by` says
	 * who, for its report: the row's stop is the user's, `stop_agents` the
	 * lead's.
	 */
	cancel(id: string, by?: SubagentStopActor): boolean;
	/**
	 * Abandon this agent's current attempt and start it again from its task,
	 * in the same place in the round. `false` when nothing by that id is
	 * running.
	 *
	 * The case it is for: an agent stuck on a stream the server dropped (a
	 * restart under it), or one looping in its output. Stop was the only
	 * control, and a stopped agent is a lost task -- the lead gets "stopped"
	 * and the round is short one report.
	 */
	restart(id: string, options?: { instructions?: string }): boolean;
	/**
	 * Stop this agent at its next turn boundary -- or at once, if it is only
	 * waiting on infrastructure -- and put it back in the placement queue with
	 * its transcript: it continues, it does not start over. `false` when
	 * nothing by that id is running.
	 */
	requeue(id: string, options?: SubagentRequeueOptions): boolean;
	/** What a live agent's controls are doing, or undefined when not running. */
	inspect(id: string): SubagentControlState | undefined;
	/**
	 * Who stopped the agent last registered under `id`, if anyone did. Kept
	 * past its release, so a report written after the run can say.
	 */
	stoppedBy(id: string): SubagentStopActor | undefined;
	/**
	 * Leave a message for this agent, read at its next turn boundary. `false`
	 * when nothing by that id is running.
	 *
	 * How the lead's side turn reaches the round it is waiting on: a message
	 * from the user while the lead sat inside its delegation call was queued
	 * for a turn the lead would not take until every agent had finished.
	 */
	message(id: string, text: string): boolean;
	/** The agents running for this session, with the names they were given. */
	runningIn(
		sessionId: string | undefined,
	): Array<{ id: string; label: string }>;
	/** Ids of the agents running right now. For tests and diagnostics. */
	running(): string[];
}

interface RunningAgent {
	/** Aborted by Stop and by the parent: the end of the agent. */
	own: AbortController;
	/** The attempt in progress, aborted by Restart as well. A child of `own`. */
	attempt?: AbortController;
	/** Set by Restart, read by the attempt that it aborted. */
	restartRequested: boolean;
	/** What the round calls it, for the lead's side turn. */
	label: string;
	/** Messages left for it, read one per turn boundary. */
	inbox: string[];
	/** What the lead added to its task when it restarted it. */
	instructions?: string;
	/** The current segment of the attempt, aborted by a requeue. */
	segment?: AbortController;
	/** Set by requeue, read by the segment it ends. */
	requeue?: SubagentRequeueOptions;
	/** The agent the current segment runs, for its transcript. */
	tracked?: { getMessages(): readonly unknown[] };
	/** Waiting on infrastructure: a requeue need not wait for a boundary. */
	waitingInfra: boolean;
}

/** Who stopped each agent, kept past release for its report. */
const STOPPED_BY = new Map<string, SubagentStopActor>();

const RUNNING = new Map<string, RunningAgent>();

export interface SubagentCancellationRegistration {
	/** What it is registered under: its row's id and the controls'. */
	readonly id: string | undefined;
	/**
	 * The signal to run under: the current attempt's, once `restartable` has
	 * started one. Read it when the agent is built, not once up front, or a
	 * restarted attempt runs on the signal of the one it replaced.
	 */
	readonly signal: AbortSignal | undefined;
	/**
	 * Run `run`, and run it again for as long as an attempt ends because it was
	 * restarted. `onRestart` goes between attempts: whatever the abandoned one
	 * held -- its engine session -- is given back there.
	 */
	restartable<T>(
		run: () => Promise<T>,
		onRestart?: () => void | Promise<void>,
	): Promise<T>;
	/**
	 * Run `run` for as long as it ends because the agent was requeued: each
	 * time with the transcript the requeued segment left, so the agent carries
	 * on where it stopped. `onRequeue` goes between segments -- the engine
	 * session the stopped one held is given back there. Nested inside
	 * {@link restartable}: a restart still starts from the task.
	 */
	continuable<T>(
		run: (carry: SubagentRequeueCarry | undefined) => Promise<T>,
		onRequeue?: (carry: SubagentRequeueCarry) => void | Promise<void>,
	): Promise<T>;
	/** The agent the current segment runs, so a requeue can take its transcript. */
	track(agent: { getMessages(): readonly unknown[] }): void;
	/** Waiting on infrastructure, or not: a requeue then stops it at once. */
	setWaitingInfra(waiting: boolean): void;
	/** What the lead added to the task when it last restarted this agent. */
	readonly instructions: string | undefined;
	/** The next message left for this agent, for its `consumePendingUserMessage`. */
	takeMessage: () => string | undefined;
	release: () => void;
}

/**
 * How a running sub-agent is named from outside.
 *
 * Session first, because a tool call id comes from the model and is only
 * unique within the conversation that produced it -- two windows on two tasks
 * can mint the same one, and stopping the wrong window's agent would be the
 * worst possible bug in a stop button.
 */
export function subagentCancelId(
	sessionId: string | undefined,
	toolCallId: string | undefined,
): string | undefined {
	return toolCallId ? `${sessionId ?? ""}::${toolCallId}` : undefined;
}

/**
 * A signal for one sub-agent, aborted by its own stop or by the parent's.
 *
 * Returns the signal to run under and a release to call when the run ends,
 * however it ends. `undefined` id means the caller could not name this agent
 * -- no tool call id -- in which case it simply runs on the parent's signal as
 * it always did, rather than being registered under a name nothing can send.
 */
export function registerSubagentCancellation(
	id: string | undefined,
	parent: AbortSignal | undefined,
	label?: string,
): SubagentCancellationRegistration {
	if (!id) {
		return {
			id: undefined,
			signal: parent,
			restartable: (run) => run(),
			continuable: (run) => run(undefined),
			track: () => {},
			setWaitingInfra: () => {},
			instructions: undefined,
			takeMessage: () => undefined,
			release: () => {},
		};
	}
	const own = new AbortController();
	const onParentAbort = () => own.abort(parent?.reason);
	if (parent?.aborted) {
		own.abort(parent.reason);
	} else {
		parent?.addEventListener("abort", onParentAbort, { once: true });
	}
	// Last registration wins, and the one it replaces is aborted rather than
	// left running unreachable: two agents under one id would mean a stop that
	// hits whichever was registered first and no way to reach the other.
	RUNNING.get(id)?.own.abort();
	STOPPED_BY.delete(id);
	const entry: RunningAgent = {
		own,
		restartRequested: false,
		label: label?.trim() || id.slice(id.indexOf("::") + 2),
		inbox: [],
		waitingInfra: false,
	};
	RUNNING.set(id, entry);
	return {
		id,
		get signal() {
			return entry.segment?.signal ?? entry.attempt?.signal ?? own.signal;
		},
		get instructions() {
			return entry.instructions;
		},
		restartable: async (run, onRestart) => {
			for (;;) {
				const attempt = new AbortController();
				const onStop = () => attempt.abort(own.signal.reason);
				if (own.signal.aborted) {
					attempt.abort(own.signal.reason);
				} else {
					own.signal.addEventListener("abort", onStop, { once: true });
				}
				entry.attempt = attempt;
				entry.restartRequested = false;
				let outcome:
					| { value: Awaited<ReturnType<typeof run>> }
					| { error: unknown };
				try {
					outcome = { value: await run() };
				} catch (error) {
					outcome = { error };
				} finally {
					own.signal.removeEventListener("abort", onStop);
				}
				// A restart that was asked for and not overtaken by a stop: the
				// abandoned attempt's result or failure is not the agent's.
				if (entry.restartRequested && !own.signal.aborted) {
					await onRestart?.();
					continue;
				}
				if ("error" in outcome) {
					throw outcome.error;
				}
				return outcome.value;
			}
		},
		continuable: async (run, onRequeue) => {
			let carry: SubagentRequeueCarry | undefined;
			for (;;) {
				const parentSignal = entry.attempt?.signal ?? own.signal;
				const segment = new AbortController();
				const onStop = () => segment.abort(parentSignal.reason);
				if (parentSignal.aborted) {
					segment.abort(parentSignal.reason);
				} else {
					parentSignal.addEventListener("abort", onStop, { once: true });
				}
				entry.segment = segment;
				entry.tracked = undefined;
				entry.waitingInfra = false;
				let outcome:
					| { value: Awaited<ReturnType<typeof run>> }
					| { error: unknown };
				try {
					outcome = { value: await run(carry) };
				} catch (error) {
					outcome = { error };
				} finally {
					parentSignal.removeEventListener("abort", onStop);
				}
				const requeue = entry.requeue;
				entry.requeue = undefined;
				// Requeued, and not overtaken by a stop or a restart: the segment's
				// result is not the agent's. Its transcript goes to the next one.
				if (
					requeue &&
					segment.signal.aborted &&
					!parentSignal.aborted &&
					!entry.restartRequested
				) {
					carry = {
						messages: [
							...((entry.tracked as RunningAgent["tracked"])?.getMessages() ??
								carry?.messages ??
								[]),
						],
						...(requeue.reason ? { reason: requeue.reason } : {}),
						...(requeue.avoidNodeId
							? { avoidNodeId: requeue.avoidNodeId }
							: {}),
					};
					entry.segment = undefined;
					await onRequeue?.(carry);
					continue;
				}
				entry.segment = undefined;
				if ("error" in outcome) {
					throw outcome.error;
				}
				return outcome.value;
			}
		},
		track: (agent) => {
			entry.tracked = agent;
		},
		setWaitingInfra: (waiting) => {
			entry.waitingInfra = waiting;
			// A requeue asked for while it was working, landing on a wait: there
			// is no turn in flight to lose, so it need not wait for a boundary.
			if (waiting && entry.requeue) {
				entry.segment?.abort(requeueAbort());
			}
		},
		takeMessage: () => {
			// The boundary: no tool call open, no request in flight. A requeue
			// the lead asked for stops the segment here, with a whole
			// transcript behind it.
			if (entry.requeue && entry.segment && !entry.segment.signal.aborted) {
				entry.segment.abort(requeueAbort());
				return undefined;
			}
			return entry.inbox.shift();
		},
		release: () => {
			parent?.removeEventListener("abort", onParentAbort);
			if (RUNNING.get(id) === entry) {
				RUNNING.delete(id);
			}
		},
	};
}

function requeueAbort(): DOMException {
	return new DOMException("The sub-agent was requeued.", "AbortError");
}

export const subagentCancellation: SubagentCancellation = {
	cancel(id: string, by: SubagentStopActor = "user"): boolean {
		const entry = RUNNING.get(id);
		if (!entry) {
			return false;
		}
		if (!entry.own.signal.aborted) {
			STOPPED_BY.set(id, by);
			// Bounded: a report reads it once, right after the stop.
			if (STOPPED_BY.size > 2_000) {
				const oldest = STOPPED_BY.keys().next().value;
				if (oldest !== undefined) {
					STOPPED_BY.delete(oldest);
				}
			}
		}
		entry.own.abort(
			new DOMException(
				by === "lead"
					? "The sub-agent was stopped by the lead."
					: "The sub-agent was stopped.",
				"AbortError",
			),
		);
		return true;
	},
	restart(id: string, options?: { instructions?: string }): boolean {
		const entry = RUNNING.get(id);
		if (!entry || entry.own.signal.aborted) {
			return false;
		}
		if (options?.instructions?.trim()) {
			entry.instructions = options.instructions.trim();
		}
		entry.restartRequested = true;
		entry.requeue = undefined;
		// Before its first attempt there is nothing to abandon: it will start
		// clean anyway, so the request is simply spent on that attempt.
		entry.attempt?.abort(
			new DOMException("The sub-agent was restarted.", "AbortError"),
		);
		return true;
	},
	requeue(id: string, options?: SubagentRequeueOptions): boolean {
		const entry = RUNNING.get(id);
		// No segment: this path runs its agent outside a continuable loop, so
		// nothing would pick the transcript up -- the requeue would only stop it.
		if (!entry || entry.own.signal.aborted || !entry.segment) {
			return false;
		}
		entry.requeue = { ...(options ?? {}) };
		// Nothing in flight to lose while it only waits on the server or the
		// queue: stop the segment now rather than at a boundary that is not
		// coming until the wait ends.
		if (entry.waitingInfra) {
			entry.segment?.abort(requeueAbort());
		}
		return true;
	},
	inspect(id: string): SubagentControlState | undefined {
		const entry = RUNNING.get(id);
		if (!entry || entry.own.signal.aborted) {
			return undefined;
		}
		return {
			label: entry.label,
			requeuePending: Boolean(entry.requeue),
			waitingInfra: entry.waitingInfra,
		};
	},
	stoppedBy(id: string): SubagentStopActor | undefined {
		return STOPPED_BY.get(id);
	},
	message(id: string, text: string): boolean {
		const entry = RUNNING.get(id);
		if (!entry || entry.own.signal.aborted || !text.trim()) {
			return false;
		}
		entry.inbox.push(text.trim());
		return true;
	},
	runningIn(sessionId: string | undefined) {
		const prefix = `${sessionId ?? ""}::`;
		return [...RUNNING.entries()]
			.filter(
				([id, entry]) => id.startsWith(prefix) && !entry.own.signal.aborted,
			)
			.map(([id, entry]) => ({ id, label: entry.label }));
	},
	running(): string[] {
		return [...RUNNING.keys()];
	},
};

/** Test seam: no run outlives its `finally`, so this is only for isolation. */
export function __resetSubagentCancellations(): void {
	RUNNING.clear();
	STOPPED_BY.clear();
}
