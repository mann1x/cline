/**
 * How much of a team's event log its store keeps.
 *
 * Every team event was appended -- a row in `team_events`, a line in
 * `task-history.jsonl` -- for as long as the team lived, and none was ever
 * deleted. What reads the log (`readHistory`) reads the newest 200. So each
 * team keeps its newest {@link TEAM_EVENTS_KEPT}, cut back once every
 * {@link TEAM_EVENTS_PRUNE_EVERY} appends rather than on each one.
 */
export const TEAM_EVENTS_KEPT = 1_000;

export const TEAM_EVENTS_PRUNE_EVERY = 100;

/** A store's retention, as its options may set it (tests keep it small). */
export interface TeamEventsRetention {
	eventsKept?: number;
	eventsPruneEvery?: number;
}

/**
 * Counts a store's appends per team, and says when one is due a prune: on
 * its first append since the store opened (a log left long by an older
 * build is cut then), and every `eventsPruneEvery` after.
 */
export function createPruneSchedule(retention: TeamEventsRetention = {}): {
	kept: number;
	due(teamName: string): boolean;
} {
	const kept = Math.max(1, retention.eventsKept ?? TEAM_EVENTS_KEPT);
	const every = Math.max(
		1,
		retention.eventsPruneEvery ?? TEAM_EVENTS_PRUNE_EVERY,
	);
	const sincePrune = new Map<string, number>();
	return {
		kept,
		due: (teamName) => {
			const count = sincePrune.get(teamName) ?? every;
			if (count >= every) {
				sincePrune.set(teamName, 1);
				return true;
			}
			sincePrune.set(teamName, count + 1);
			return false;
		},
	};
}
