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

export interface SubagentCancellation {
	/** Stop this agent. `false` when nothing by that id is running. */
	cancel(id: string): boolean;
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
	restart(id: string): boolean;
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
}

const RUNNING = new Map<string, RunningAgent>();

export interface SubagentCancellationRegistration {
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
			signal: parent,
			restartable: (run) => run(),
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
	const entry: RunningAgent = {
		own,
		restartRequested: false,
		label: label?.trim() || id.slice(id.indexOf("::") + 2),
		inbox: [],
	};
	RUNNING.set(id, entry);
	return {
		get signal() {
			return entry.attempt?.signal ?? own.signal;
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
		takeMessage: () => entry.inbox.shift(),
		release: () => {
			parent?.removeEventListener("abort", onParentAbort);
			if (RUNNING.get(id) === entry) {
				RUNNING.delete(id);
			}
		},
	};
}

export const subagentCancellation: SubagentCancellation = {
	cancel(id: string): boolean {
		const entry = RUNNING.get(id);
		if (!entry) {
			return false;
		}
		entry.own.abort(
			new DOMException("The sub-agent was stopped.", "AbortError"),
		);
		return true;
	},
	restart(id: string): boolean {
		const entry = RUNNING.get(id);
		if (!entry || entry.own.signal.aborted) {
			return false;
		}
		entry.restartRequested = true;
		// Before its first attempt there is nothing to abandon: it will start
		// clean anyway, so the request is simply spent on that attempt.
		entry.attempt?.abort(
			new DOMException("The sub-agent was restarted.", "AbortError"),
		);
		return true;
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
}
