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
	/** Ids of the agents running right now. For tests and diagnostics. */
	running(): string[];
}

const RUNNING = new Map<string, AbortController>();

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
): { signal: AbortSignal | undefined; release: () => void } {
	if (!id) {
		return { signal: parent, release: () => {} };
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
	RUNNING.get(id)?.abort();
	RUNNING.set(id, own);
	return {
		signal: own.signal,
		release: () => {
			parent?.removeEventListener("abort", onParentAbort);
			if (RUNNING.get(id) === own) {
				RUNNING.delete(id);
			}
		},
	};
}

export const subagentCancellation: SubagentCancellation = {
	cancel(id: string): boolean {
		const controller = RUNNING.get(id);
		if (!controller) {
			return false;
		}
		controller.abort(
			new DOMException("The sub-agent was stopped.", "AbortError"),
		);
		return true;
	},
	running(): string[] {
		return [...RUNNING.keys()];
	},
};

/** Test seam: no run outlives its `finally`, so this is only for isolation. */
export function __resetSubagentCancellations(): void {
	RUNNING.clear();
}
