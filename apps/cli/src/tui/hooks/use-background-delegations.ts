import type { BackgroundDelegationView } from "@cline/core";
import { useCallback, useEffect, useRef, useState } from "react";

/** Fast enough to feel live, slow enough to cost nothing. */
const POLL_MS = 1000;

/** Running or paused: the ones the user can still do anything about. */
function isLive(run: BackgroundDelegationView): boolean {
	return run.status === "running" || run.status === "paused";
}

/**
 * The background delegations this session is running, kept current.
 *
 * Polled rather than pushed. The registry does publish every change, but it
 * lives behind the session runtime and the events that move a row -- a turn
 * starting, a tool starting -- arrive several times a second per run; a poll
 * collapses those into one redraw and costs one call while anything is
 * running, and nothing at all while nothing is.
 *
 * Only live runs are kept. A finished one has already put its report into the
 * conversation, and leaving the row up would say the work is still going.
 */
export function useBackgroundDelegations(
	list: () => Promise<BackgroundDelegationView[]>,
): {
	runs: BackgroundDelegationView[];
	refresh: () => void;
} {
	const [runs, setRuns] = useState<BackgroundDelegationView[]>([]);
	// Read by the interval, which outlives the render that scheduled it.
	const hasLiveRef = useRef(false);
	const listRef = useRef(list);
	listRef.current = list;

	const refresh = useCallback(() => {
		void listRef
			.current()
			.then((next) => {
				const live = next.filter(isLive);
				hasLiveRef.current = live.length > 0;
				setRuns((previous) => (sameRows(previous, live) ? previous : live));
			})
			.catch(() => {
				// A session that cannot answer has nothing to show, and a panel
				// is not the place to report it.
			});
	}, []);

	useEffect(() => {
		const timer = setInterval(() => {
			if (hasLiveRef.current) {
				refresh();
			}
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [refresh]);

	return { runs, refresh };
}

/**
 * Whether a redraw would show anything different.
 *
 * A poll returns a fresh array every time, and handing React a new one on every
 * tick re-renders the whole panel a second for no reason.
 */
function sameRows(
	a: readonly BackgroundDelegationView[],
	b: readonly BackgroundDelegationView[],
): boolean {
	if (a.length !== b.length) {
		return false;
	}
	return a.every((run, index) => {
		const other = b[index];
		return (
			run.id === other.id &&
			run.status === other.status &&
			run.activity === other.activity &&
			run.iterations === other.iterations
		);
	});
}
