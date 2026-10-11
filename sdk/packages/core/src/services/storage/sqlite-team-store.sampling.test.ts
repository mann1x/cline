import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TeamRuntimeState, TeamTeammateSpec } from "@cline/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteTeamStore } from "./sqlite-team-store";

// A teammate spawned with a random sampler is restored with the values it
// drew, and with how it drew them: a swarm experiment is reproduced from
// these, so a restore that lost them would report a teammate's temperature
// as if the lead had chosen it.
describe("a persisted teammate's sampler", () => {
	let dir: string;

	const opened: SqliteTeamStore[] = [];

	// The store writes the team row from the state, so the state names its team.
	const emptyState = () =>
		({
			teamId: "team-1",
			teamName: "team",
			members: [],
			tasks: [],
			mailbox: [],
			missionLog: [],
			runs: [],
			outcomes: [],
			outcomeFragments: [],
		}) as unknown as TeamRuntimeState;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-store-sampling-"));
	});

	afterEach(() => {
		// Closed before the directory goes: Windows will not delete an open teams.db.
		for (const store of opened.splice(0)) {
			store.close();
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("comes back with the drawn values and how they were drawn", () => {
		const store = new SqliteTeamStore({ teamDir: dir });
		opened.push(store);
		store.init();
		const state = emptyState();
		const teammate: TeamTeammateSpec = {
			agentId: "w",
			rolePrompt: "Write",
			temperature: 0.713,
			seed: 2847193,
			seedRandom: true,
			temperatureBase: 0.7,
			temperatureRange: 2,
		};
		store.persistRuntime("team", state, [teammate]);
		expect(store.loadRuntime("team").teammates).toEqual([teammate]);
	});

	it("drops a range it could not have drawn with", () => {
		const store = new SqliteTeamStore({ teamDir: dir });
		opened.push(store);
		store.init();
		store.persistRuntime("team", emptyState(), [
			{
				agentId: "w",
				rolePrompt: "Write",
				temperatureRange: 400,
			} as TeamTeammateSpec,
		]);
		expect(store.loadRuntime("team").teammates).toEqual([
			{ agentId: "w", rolePrompt: "Write" },
		]);
	});
});
