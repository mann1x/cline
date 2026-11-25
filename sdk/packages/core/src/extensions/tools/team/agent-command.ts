/**
 * `/agent` — one command for handing work to an agent, whichever way the user
 * puts it:
 *
 *   /agent reviewer inspect the source code of the game
 *   /agent reviewer /review-website
 *   /agent launch an agent to inspect the source code of the game
 *
 * A first word that names a configured agent is `/delegate`: that agent runs,
 * and the lead model is not asked. Anything else goes to the lead as a request
 * to hand the work to an agent, and the lead chooses which -- the one form
 * where the model decides, because the user did not name anyone.
 *
 * Pure, so the extension and the CLI plan the same command the same way.
 */
import { normalizeRuntimeCommandName } from "../../config/runtime-commands";

/** An agent as `/agent` needs it: its name, and the skills it may load. */
export interface AgentCommandAgent {
	name: string;
	/** The agent file's `skills:` list. Absent or empty: every skill. */
	skills?: readonly string[];
}

export interface AgentCommandContext {
	agents: readonly AgentCommandAgent[];
	/** The skill commands the session knows, as typed after the slash. */
	skillNames: readonly string[];
	/** Whether this session can run agents at all (subagents on). */
	agentsEnabled: boolean;
}

export type AgentCommandPlan =
	| { kind: "delegate"; agentName: string; prompt: string }
	| { kind: "lead"; message: string }
	| { kind: "refused"; reason: string };

const USAGE =
	"/agent <agent or skill> <task>, or /agent and the task in your own words";

/** Whether a message is an `/agent` command at all. */
export function isAgentCommand(text: string): boolean {
	return /^\/agent(?:\s|$)/.test(text.trim());
}

/**
 * The agent a skill may run under, or why it may not.
 *
 * Only a skill the session knows is checked: `/src/game.js` at the start of a
 * task is a path, not a skill nobody has.
 */
function refuseSkillForAgent(
	agent: AgentCommandAgent,
	task: string,
	skillNames: ReadonlySet<string>,
): string | undefined {
	const typed = task.match(/^\/(\S+)/)?.[1];
	if (!typed) {
		return undefined;
	}
	const skill = normalizeRuntimeCommandName(typed);
	const allowed = (agent.skills ?? [])
		.map(normalizeRuntimeCommandName)
		.filter(Boolean);
	if (!skillNames.has(skill) || allowed.length === 0) {
		return undefined;
	}
	if (allowed.includes(skill)) {
		return undefined;
	}
	return (
		`The "${agent.name}" agent cannot load the "${skill}" skill: its agent file allows only ${allowed.map((name) => `"${name}"`).join(", ")}. ` +
		`Add "${skill}" to its skills, or pick one of those.`
	);
}

/** Plan what an `/agent` message does. */
export function planAgentCommand(
	text: string,
	context: AgentCommandContext,
): AgentCommandPlan {
	const body = text
		.trim()
		.replace(/^\/agent(?=\s|$)/, "")
		.trim();
	if (!body) {
		return {
			kind: "refused",
			reason: `Say what to hand off: ${USAGE}.`,
		};
	}
	const first = body.match(/^\S+/)?.[0] ?? "";
	const rest = body.slice(first.length).trim();
	const skillNames = new Set(
		context.skillNames.map(normalizeRuntimeCommandName).filter(Boolean),
	);

	// A first word that is an agent's name, exactly, is that agent. Before any
	// skill of the same name: the menu offered it as the agent first.
	const agent = first.startsWith("/")
		? undefined
		: context.agents.find(
				(entry) => entry.name.toLowerCase() === first.toLowerCase(),
			);
	if (agent) {
		if (!rest) {
			return {
				kind: "refused",
				reason: `Say what the "${agent.name}" agent is to do: /agent ${agent.name} <task>, or /agent ${agent.name} /<skill>.`,
			};
		}
		const refusal = refuseSkillForAgent(agent, rest, skillNames);
		if (refusal) {
			return { kind: "refused", reason: refusal };
		}
		return { kind: "delegate", agentName: agent.name, prompt: rest };
	}

	if (!context.agentsEnabled) {
		return {
			kind: "refused",
			reason:
				"Agents are turned off for this conversation, so there is no agent to hand this to. Turn on subagents in Settings, or send it without /agent.",
		};
	}

	const handOff =
		"Hand the following to an agent instead of doing it yourself: one of the configured agents if one fits, otherwise a new one. Then tell me what it reported.";
	// A skill as the first word is the agent's instructions, not the lead's.
	// Named without its slash, which would read as the user invoking it here.
	const skill = normalizeRuntimeCommandName(first.replace(/^\//, ""));
	if (skill && skillNames.has(skill)) {
		const task = rest ? `\n\n${rest}` : "";
		return {
			kind: "lead",
			message: `${handOff} The agent is to load and follow the "${skill}" skill.${task}`,
		};
	}
	return { kind: "lead", message: `${handOff}\n\n${body}` };
}
