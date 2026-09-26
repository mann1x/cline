import { createTeamName } from "@cline/core";
import { formatUserCommandBlock } from "@cline/shared";
import type { Config } from "./types";

export const TEAM_COMMAND_USAGE =
	"Usage: /team <task description>\nStarts a team of agents for the given task.";

type TeamPromptRewriteResult =
	| { kind: "none" }
	| { kind: "usage" }
	| { kind: "rewritten"; prompt: string };

export function rewriteTeamPrompt(input: string): TeamPromptRewriteResult {
	const match = /^\/team\b([\s\S]*)$/i.exec(input.trim());
	if (!match) {
		return { kind: "none" };
	}
	const taskBody = match[1].trim();
	if (!taskBody) {
		return { kind: "usage" };
	}
	return {
		kind: "rewritten",
		prompt: formatUserCommandBlock(
			`spawn a team of agents for the following task: ${taskBody}`,
			"team",
		),
	};
}

export async function enableTeamsForPrompt(config: Config): Promise<void> {
	if (config.enableAgentTeams) {
		return;
	}
	config.enableAgentTeams = true;
	config.teamName = config.teamName?.trim() || createTeamName();
}

/**
 * Whether this run offers the team tools. Off unless asked for, mirroring the
 * extension's Teammates setting: eighteen tools in every request that most
 * runs never call. `--teammates` or `CLINE_TEAMMATES=1` turns them on.
 */
export function teammatesRequested(
	args: { teammates?: boolean },
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return args.teammates === true || env.CLINE_TEAMMATES?.trim() === "1";
}

/**
 * A `/team` prompt is an explicit request for a team, so it turns the team
 * tools on for its own run whatever the default says -- except in yolo mode,
 * which has never offered them.
 */
export function teamsForRewrittenPrompt(
	rewritten: TeamPromptRewriteResult,
	config: Config,
	isYoloMode: boolean,
): void {
	if (rewritten.kind === "rewritten" && !isYoloMode) {
		config.enableAgentTeams = true;
	}
}
