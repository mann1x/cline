import { describe, expect, it } from "vitest";
import {
	rewriteTeamPrompt,
	TEAM_COMMAND_USAGE,
	teammatesRequested,
	teamsForRewrittenPrompt,
} from "./team-command";
import type { Config } from "./types";

describe("team command prompt rewrite", () => {
	it("does not rewrite non-team prompts", () => {
		expect(rewriteTeamPrompt("investigate rpc startup")).toEqual({
			kind: "none",
		});
	});

	it("rewrites /team prompts", () => {
		expect(rewriteTeamPrompt("/team investigate rpc startup")).toEqual({
			kind: "rewritten",
			prompt:
				'<user_command slash="team">spawn a team of agents for the following task: investigate rpc startup</user_command>',
		});
	});

	it("preserves multiline team tasks", () => {
		expect(
			rewriteTeamPrompt("/team investigate rpc startup\ninclude tests"),
		).toEqual({
			kind: "rewritten",
			prompt:
				'<user_command slash="team">spawn a team of agents for the following task: investigate rpc startup\ninclude tests</user_command>',
		});
	});

	it("returns usage for /team without a task", () => {
		expect(rewriteTeamPrompt("/team")).toEqual({ kind: "usage" });
		expect(TEAM_COMMAND_USAGE).toContain("/team <task description>");
	});
});

describe("the team tools are off unless asked for", () => {
	it("reads --teammates and CLINE_TEAMMATES=1, and nothing else", () => {
		expect(teammatesRequested({}, {})).toBe(false);
		expect(teammatesRequested({ teammates: true }, {})).toBe(true);
		expect(teammatesRequested({}, { CLINE_TEAMMATES: "1" })).toBe(true);
		expect(teammatesRequested({}, { CLINE_TEAMMATES: "0" })).toBe(false);
		expect(teammatesRequested({}, { CLINE_TEAMMATES: "true" })).toBe(false);
	});

	it("turns them on for a /team prompt, except in yolo mode", () => {
		const on = { enableAgentTeams: false } as unknown as Config;
		teamsForRewrittenPrompt(rewriteTeamPrompt("/team find the bug"), on, false);
		expect(on.enableAgentTeams).toBe(true);

		const yolo = { enableAgentTeams: false } as unknown as Config;
		teamsForRewrittenPrompt(
			rewriteTeamPrompt("/team find the bug"),
			yolo,
			true,
		);
		expect(yolo.enableAgentTeams).toBe(false);

		const plain = { enableAgentTeams: false } as unknown as Config;
		teamsForRewrittenPrompt(rewriteTeamPrompt("find the bug"), plain, false);
		expect(plain.enableAgentTeams).toBe(false);
	});
});
