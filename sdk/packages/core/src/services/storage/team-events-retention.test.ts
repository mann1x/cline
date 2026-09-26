import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TeamEvent } from "../../extensions/tools/team";
import { FileTeamStore } from "./file-team-store";
import { SqliteTeamStore } from "./sqlite-team-store";

/**
 * A team's event log keeps a bounded tail. It grew by a row per event for as
 * long as the team lived, and nothing ever deleted one: the store's history
 * reader only ever reads the newest few hundred.
 */

// Under the package, not the system temp dir: a scratch dir this test owns.
const root = join(__dirname, `.team-events-retention-${process.pid}`);

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

// Small, so the test appends a few dozen events rather than a thousand.
const retention = { eventsKept: 20, eventsPruneEvery: 5 };

function event(n: number): TeamEvent {
	return {
		type: "team_mission_log",
		entry: { id: `log_${n}`, summary: `entry ${n}` },
	} as unknown as TeamEvent;
}

const summaries = (history: unknown[]) =>
	history.map(
		(row) =>
			(row as { payload: { entry: { summary: string } } }).payload.entry
				.summary,
	);

type Retention = { eventsKept: number; eventsPruneEvery: number };

describe.each([
	[
		"sqlite",
		(dir: string, kept: Retention = retention) =>
			new SqliteTeamStore({ teamDir: dir, ...kept }),
	],
	[
		"file",
		(dir: string, kept: Retention = retention) =>
			new FileTeamStore({ teamDir: dir, ...kept }),
	],
])("the %s team store's event log", (name, open) => {
	it("keeps each team's newest events, and drops its oldest", () => {
		const dir = join(root, name);
		mkdirSync(dir, { recursive: true });
		const store = open(dir);
		store.init();
		const total = 3 * retention.eventsKept + 3;
		for (let n = 1; n <= total; n++) {
			store.handleTeamEvent("busy", event(n));
		}
		store.handleTeamEvent("quiet", event(1));

		const kept = summaries(store.readHistory("busy", total));
		expect(kept.length).toBeGreaterThanOrEqual(retention.eventsKept);
		expect(kept.length).toBeLessThanOrEqual(
			retention.eventsKept + retention.eventsPruneEvery,
		);
		expect(kept[0]).toBe(`entry ${total}`);
		expect(kept).not.toContain("entry 1");
		// Per team: another team's log is not cut by this one's.
		expect(summaries(store.readHistory("quiet"))).toEqual(["entry 1"]);
	});

	it("cuts a log an older build left long on its first append", () => {
		const dir = join(root, `${name}-old`);
		mkdirSync(dir, { recursive: true });
		// Written as an older build did: kept whole.
		const legacy = open(dir, {
			eventsKept: 1_000_000,
			eventsPruneEvery: 1_000_000,
		});
		legacy.init();
		for (let n = 1; n <= 40; n++) {
			legacy.handleTeamEvent("team", event(n));
		}

		const reopened = open(dir);
		reopened.init();
		reopened.handleTeamEvent("team", event(41));

		const kept = summaries(reopened.readHistory("team", 100));
		expect(kept.length).toBe(retention.eventsKept);
		expect(kept[0]).toBe("entry 41");
	});
});
