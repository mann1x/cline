import { type AgentCommandPlan, planAgentCommand } from "@cline/core";
import type { SlashCommandRegistry } from "../commands/slash-command-registry";
import type { TuiProps } from "../types";

/**
 * Plan an `/agent` message with what the CLI knows: the configured agents and
 * the skill commands in the registry.
 *
 * Agents count as available: the CLI session offers `spawn_agent` except
 * under --yolo, and a lead with no agent tool says so in its answer, which is
 * the same outcome a refusal here would give.
 */
export async function planCliAgentCommand(
	text: string,
	registry: SlashCommandRegistry,
	listAgents?: TuiProps["onListAgents"],
): Promise<AgentCommandPlan> {
	let agents: Awaited<ReturnType<TuiProps["onListAgents"]>> = [];
	try {
		agents = (await listAgents?.()) ?? [];
	} catch {
		// Without the list, a first word is never an agent: the lead gets the
		// request and picks one itself.
	}
	return planAgentCommand(text, {
		agents,
		skillNames: registry.entries
			.filter((entry) => entry.source === "skill")
			.map((entry) => entry.name),
		agentsEnabled: true,
	});
}
