import { describe, expect, it } from "vitest";
import { createSpawnAgentTool, describeSpawnAgent } from "./spawn-agent-tool";
import { historyUsedTeammates } from "./teammates-off";

describe("spawn_agent's description and the Teammates setting", () => {
	it("names the team tools only when the session has them", () => {
		expect(describeSpawnAgent(false)).not.toMatch(/team_|teammate/i);
		expect(describeSpawnAgent(true)).not.toMatch(/team_|teammate/i);
		expect(describeSpawnAgent(false, true)).toContain("`team_*`");
	});

	it("is built without them unless asked", () => {
		const off = createSpawnAgentTool({ configProvider: {} as never });
		const on = createSpawnAgentTool({
			configProvider: {} as never,
			teammates: true,
		});
		expect(off.description).not.toMatch(/team_|teammate/i);
		expect(on.description).toContain("long-lived teammates");
	});
});

describe("historyUsedTeammates", () => {
	it("finds a team_* call in the transcript", () => {
		expect(
			historyUsedTeammates([
				{ content: "plain text" },
				{
					content: [
						{ type: "text", text: "spawning" },
						{ type: "tool_use", name: "team_run_task", input: {} },
					],
				},
			]),
		).toBe(true);
	});

	it("ignores other tools, text that mentions them, and no history", () => {
		expect(
			historyUsedTeammates([
				{ content: "use team_run_task next" },
				{ content: [{ type: "tool_use", name: "spawn_agent", input: {} }] },
			]),
		).toBe(false);
		expect(historyUsedTeammates([])).toBe(false);
		expect(historyUsedTeammates(undefined)).toBe(false);
	});
});
