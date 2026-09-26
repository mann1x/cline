import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TeamRuntimeState } from "@cline/shared";
import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Every reader of a saved team revives its dates through one function. There
 * were four copies -- two stores, the session's team file, the team tools --
 * and B-10's missing `lastProgressAt` had to be added to each by hand.
 */

const revived = vi.hoisted(() => ({ calls: 0 }));

vi.mock("./team-state-dates", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./team-state-dates")>();
	return {
		reviveTeamStateDates: (state: TeamRuntimeState) => {
			revived.calls++;
			return actual.reviveTeamStateDates(state);
		},
	};
});

const { reviveTeamStateDates } = await import("./team-state-dates");
const { reviveTeamStateDates: fromTeamTools } = await import("./team-tools");
const { reviveTeamStateDates: fromSessionRow } = await import(
	"../../../session/models/session-row"
);
const { SqliteTeamStore } = await import(
	"../../../services/storage/sqlite-team-store"
);
const { FileTeamStore } = await import(
	"../../../services/storage/file-team-store"
);

// Under the package, not the system temp dir: a scratch dir this test owns.
const dir = join(__dirname, `.team-state-dates-${process.pid}`);

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

const state: TeamRuntimeState = {
	teamId: "t_1",
	teamName: "team",
	members: [],
	tasks: [],
	mailbox: [],
	missionLog: [],
	runs: [
		{
			id: "run_00001",
			agentId: "w",
			status: "completed",
			message: "m",
			priority: 0,
			retryCount: 0,
			maxRetries: 0,
			startedAt: new Date(1_000),
			endedAt: new Date(2_000),
			lastProgressAt: new Date(1_500),
		},
	],
	outcomes: [],
	outcomeFragments: [],
};

describe("reviving a saved team's dates", () => {
	it("is one function, whichever module a reader takes it from", () => {
		expect(fromTeamTools).toBe(reviveTeamStateDates);
		expect(fromSessionRow).toBe(reviveTeamStateDates);
	});

	it("is the one both stores load through", () => {
		mkdirSync(dir, { recursive: true });
		for (const store of [
			new SqliteTeamStore({ teamDir: join(dir, "sqlite") }),
			new FileTeamStore({ teamDir: join(dir, "file") }),
		]) {
			store.init();
			store.persistRuntime("team", state, []);
			const before = revived.calls;
			const loaded = store.loadRuntime("team").state;
			expect(revived.calls).toBe(before + 1);
			expect(loaded?.runs[0]?.lastProgressAt).toEqual(new Date(1_500));
		}
	});
});
