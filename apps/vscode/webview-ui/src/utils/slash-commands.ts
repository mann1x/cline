import type { McpServer } from "@shared/mcp"
import { PLATFORM_CONFIG, PlatformType } from "@/config/platform.config"
import {
	BASE_SLASH_COMMANDS,
	type SlashCommand,
	skillCommandName,
	VSCODE_ONLY_COMMANDS,
} from "../../../src/shared/slashCommands.ts"
import { matchesFilter } from "./text-filter"

export type { SlashCommand }
export { skillCommandName }

const DEFAULT_SLASH_COMMANDS: SlashCommand[] =
	PLATFORM_CONFIG.type === PlatformType.VSCODE ? [...BASE_SLASH_COMMANDS, ...VSCODE_ONLY_COMMANDS] : BASE_SLASH_COMMANDS

function getWorkflowCommands(
	localWorkflowToggles: Record<string, boolean>,
	globalWorkflowToggles: Record<string, boolean>,
	remoteWorkflowToggles?: Record<string, boolean>,
	remoteWorkflows?: any[],
): SlashCommand[] {
	const { workflows: localWorkflows, nameSet: localWorkflowNames } = Object.entries(localWorkflowToggles)
		.filter(([_, enabled]) => enabled)
		.reduce(
			(acc, [filePath, _]) => {
				const fileName = filePath.replace(/^.*[/\\]/, "")

				// Add to array of workflows
				acc.workflows.push({
					name: fileName,
					section: "custom",
				} as SlashCommand)

				// Add to set of names
				acc.nameSet.add(fileName)

				return acc
			},
			{ workflows: [] as SlashCommand[], nameSet: new Set<string>() },
		)

	const globalWorkflows = Object.entries(globalWorkflowToggles)
		.filter(([_, enabled]) => enabled)
		.flatMap(([filePath, _]) => {
			const fileName = filePath.replace(/^.*[/\\]/, "")

			// skip if a local workflow with the same name exists
			if (localWorkflowNames.has(fileName)) {
				return []
			}

			return [
				{
					name: fileName,
					section: "custom",
				},
			] as SlashCommand[]
		})

	// Add remote workflows that are enabled
	const remoteWorkflowCommands: SlashCommand[] = []
	if (remoteWorkflows && remoteWorkflowToggles) {
		for (const workflow of remoteWorkflows) {
			// Include if alwaysEnabled or if toggle is not explicitly false
			const enabled = workflow.alwaysEnabled || remoteWorkflowToggles[workflow.name] !== false
			if (enabled) {
				remoteWorkflowCommands.push({
					name: workflow.name,
					section: "custom",
				})
			}
		}
	}

	const workflows = [...localWorkflows, ...globalWorkflows, ...remoteWorkflowCommands]
	return workflows
}

/**
 * Gets MCP prompt commands from connected MCP servers
 * Format: mcp:<server-name>:<prompt-name>
 */
export function getMcpPromptCommands(mcpServers: McpServer[] = []): SlashCommand[] {
	const commands: SlashCommand[] = []

	for (const server of mcpServers) {
		if (server.status !== "connected" || !server.prompts) {
			continue
		}

		for (const prompt of server.prompts) {
			commands.push({
				name: `mcp:${server.name}:${prompt.name}`,
				description: prompt.description || prompt.title || `MCP prompt from ${server.name}`,
				section: "mcp",
			})
		}
	}

	return commands
}

// Regex for detecting slash commands in text
// Must be at start of string OR preceded by whitespace to avoid matching URLs/paths
// e.g., matches "/newtask" or "text /newtask" but not "http://example.com/newtask"
// Note: Colons are allowed to support MCP prompt commands like /mcp:server:prompt
export const slashCommandRegex = /(^|\s)(\/[a-zA-Z0-9_.:@-]+)(?=\s|$)/
export const slashCommandRegexGlobal = new RegExp(slashCommandRegex.source, "g")
// Regex for detecting a slash command at the end of text (for deletion)
// Must be at start OR preceded by whitespace, captures the whole command including slash
export const slashCommandDeleteRegex = /(^|\s)(\/[a-zA-Z0-9_.:@-]+)$/

/**
 * Removes a slash command at the cursor position
 */
export function removeSlashCommand(text: string, position: number): { newText: string; newPosition: number } {
	const beforeCursor = text.slice(0, position)
	const afterCursor = text.slice(position)

	// Check if we're at the end of a slash command (anywhere in text, not just at start)
	const matchEnd = beforeCursor.match(slashCommandDeleteRegex)

	if (matchEnd) {
		// matchEnd[1] is the whitespace or empty string before the slash
		// matchEnd[2] is the slash command (e.g., "/newtask")
		const slashCommand = matchEnd[2]
		const newText = text.slice(0, position - slashCommand.length) + afterCursor.replace(/^ /, "") // removes the space immediately after the command
		const newPosition = position - slashCommand.length
		return { newText, newPosition }
	}

	// If we're not at the end of a slash command, just return the original text and position
	return { newText: text, newPosition: position }
}

/**
 * Determines whether the slash command menu should be displayed based on text input.
 * Only shows for the FIRST valid slash command position in the message - subsequent
 * slash commands won't trigger suggestions since only one is processed per message.
 */
export function shouldShowSlashCommandsMenu(text: string, cursorPosition: number): boolean {
	const beforeCursor = text.slice(0, cursorPosition)

	// first check if there is a slash before the cursor
	const slashIndex = beforeCursor.lastIndexOf("/")

	if (slashIndex === -1) {
		return false
	}

	// Check if slash is preceded by whitespace or is at the beginning
	// This allows slash commands anywhere in the message, similar to @ mentions
	const charBeforeSlash = slashIndex > 0 ? beforeCursor[slashIndex - 1] : null
	if (charBeforeSlash !== null && !/\s/.test(charBeforeSlash)) {
		return false
	}

	// potential partial or full command
	const textAfterSlash = beforeCursor.slice(slashIndex + 1)

	// don't show menu if there's whitespace after the slash but before the cursor
	if (/\s/.test(textAfterSlash)) {
		return false
	}

	// Only show suggestions for the FIRST slash command in the message.
	// Check if there's already a valid slash command earlier in the text.
	// A valid earlier slash command is one that: starts at beginning or after whitespace,
	// and is followed by whitespace (meaning it's complete).
	// Note: Colons are allowed to support MCP prompt commands like /mcp:server:prompt
	const firstSlashCommandRegex = /(^|\s)\/[a-zA-Z0-9_.:@-]+\s/
	const textBeforeCurrentSlash = text.slice(0, slashIndex)
	if (firstSlashCommandRegex.test(textBeforeCurrentSlash)) {
		return false
	}

	return true
}

/**
 * Gets filtered slash commands that match the current input
 */
export function getMatchingSlashCommands(
	query: string,
	localWorkflowToggles: Record<string, boolean> = {},
	globalWorkflowToggles: Record<string, boolean> = {},
	remoteWorkflowToggles?: Record<string, boolean>,
	remoteWorkflows?: any[],
	mcpServers: McpServer[] = [],
	skills: readonly SlashCommand[] = [],
): SlashCommand[] {
	const workflowCommands = getWorkflowCommands(
		localWorkflowToggles,
		globalWorkflowToggles,
		remoteWorkflowToggles,
		remoteWorkflows,
	)
	const mcpPromptCommands = getMcpPromptCommands(mcpServers)
	const allCommands = [...DEFAULT_SLASH_COMMANDS, ...workflowCommands, ...mcpPromptCommands]

	if (!query) {
		return [...allCommands, ...skills]
	}

	// filter commands that start with the query (case insensitive); a skill
	// matches anywhere in its name, so `/deploy` finds `docker-compose-deploy`.
	const wanted = query.toLowerCase()
	return [
		...allCommands.filter((cmd) => cmd.name.toLowerCase().startsWith(wanted)),
		...skills.filter((skill) => skill.name.includes(wanted)),
	]
}

/**
 * The enabled skills as menu entries, one per command name (the first of a
 * name wins, as in the runtime), in name order. A skill switched off on the
 * Skills tab is left out: the runtime does not offer it either.
 */
export function getSkillCommands(
	skills: ReadonlyArray<{ name: string; description?: string; enabled?: boolean }>,
): SlashCommand[] {
	const byName = new Map<string, SlashCommand>()
	for (const skill of skills) {
		const name = skillCommandName(skill.name)
		if (skill.enabled === false || !name || byName.has(name)) {
			continue
		}
		byName.set(name, { name, description: skill.description, section: "skill" })
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The filter typed after `/skill`, when the message starts with it and the
 * cursor is in what follows; undefined anywhere else. Several words are
 * allowed, unlike any other slash command.
 */
export function getSkillQuery(text: string, cursorPosition: number): string | undefined {
	return text.slice(0, cursorPosition).match(/^\/skill\s+([^\n]*)$/)?.[1]
}

/** The skills with every word of the filter in their name or description. */
export function getMatchingSkills(query: string, skills: readonly SlashCommand[]): SlashCommand[] {
	return skills.filter((skill) => matchesFilter(query, skill.name, skill.description))
}

/** Replace `/skill <filter>` with the skill's command, leaving the cursor where the request goes. */
export function insertSkillCommand(
	text: string,
	skillName: string,
	cursorPosition: number,
): { newValue: string; newCursorPosition: number } {
	const rest = text.slice(cursorPosition).replace(/^[^\S\n]+/, "")
	const command = `/${skillName} `
	return { newValue: `${command}${rest}`, newCursorPosition: command.length }
}

/**
 * The part of an agent name typed so far, when the cursor is on the first
 * argument of `/delegate` or `/delegate-background`; undefined anywhere else.
 * Only at the start of the message, where those commands are recognised.
 */
export function getDelegateAgentQuery(text: string, cursorPosition: number): string | undefined {
	return text.slice(0, cursorPosition).match(/^\/(?:delegate|delegate-background)\s+([^\s@]*)$/)?.[1]
}

/** The agents whose name starts with what was typed, as menu entries. */
export function getMatchingDelegateAgents(
	query: string,
	agents: ReadonlyArray<{ name: string; description: string }>,
): SlashCommand[] {
	const wanted = query.toLowerCase()
	return agents
		.filter((agent) => agent.name.toLowerCase().startsWith(wanted))
		.map((agent) => ({ name: agent.name, description: agent.description, section: "agent" }))
}

/** Replace the agent name under the cursor, leaving the cursor where the task goes. */
export function insertDelegateAgent(
	text: string,
	agentName: string,
	cursorPosition: number,
): { newValue: string; newCursorPosition: number } {
	const start = cursorPosition - (getDelegateAgentQuery(text, cursorPosition) ?? "").length
	const rest = text.slice(cursorPosition).replace(/^\S*/, "")
	return {
		newValue: `${text.slice(0, start)}${agentName}${rest.startsWith(" ") ? rest : ` ${rest}`}`,
		newCursorPosition: start + agentName.length + 1,
	}
}

/** An agent as `/agent` offers it: its name, and the skills it may load (none listed: every one). */
export interface AgentCommandAgent {
	name: string
	description: string
	skills?: readonly string[]
}

/**
 * Which argument of `/agent` the cursor is on, and what is typed there so far;
 * undefined anywhere else. The first takes an agent or a skill, the second (after
 * a first word that is not a skill) only a skill. Past that it is free text.
 */
export type AgentCommandSlot = { position: "first"; query: string } | { position: "second"; agentName: string; query: string }

export function getAgentCommandSlot(text: string, cursorPosition: number): AgentCommandSlot | undefined {
	const beforeCursor = text.slice(0, cursorPosition)
	const first = beforeCursor.match(/^\/agent\s+([^\s@]*)$/)
	if (first) {
		return { position: "first", query: first[1] }
	}
	const second = beforeCursor.match(/^\/agent\s+([^\s/@][^\s@]*)\s+([^\s@]*)$/)
	if (second) {
		return { position: "second", agentName: second[1], query: second[2] }
	}
	return undefined
}

/**
 * What the `/agent` menu offers at the cursor: agents whose name starts with
 * what was typed, then skills with it in their name; for the second argument,
 * only the skills that agent may load. Matching names only, not descriptions,
 * so ordinary words typed as a task close the menu instead of finding a skill
 * that happens to mention them.
 */
export function getMatchingAgentCommandItems(
	slot: AgentCommandSlot,
	agents: readonly AgentCommandAgent[],
	skills: readonly SlashCommand[],
): SlashCommand[] {
	const wanted = slot.query.replace(/^\//, "").toLowerCase()
	const matchingSkills = (allowed?: ReadonlySet<string>) =>
		skills.filter((skill) => (!allowed || allowed.has(skill.name)) && skill.name.includes(wanted))
	if (slot.position === "first") {
		const agentItems = slot.query.startsWith("/")
			? []
			: agents
					.filter((agent) => agent.name.toLowerCase().startsWith(wanted))
					.map((agent) => ({ name: agent.name, description: agent.description, section: "agent" as const }))
		return [...agentItems, ...matchingSkills()]
	}
	const agent = agents.find((entry) => entry.name.toLowerCase() === slot.agentName.toLowerCase())
	if (!agent) {
		return []
	}
	const allowed = agent.skills?.length ? new Set(agent.skills.map(skillCommandName)) : undefined
	return matchingSkills(allowed)
}

/**
 * Replace the word under the cursor with the chosen agent or skill. A skill
 * goes in with its slash, which is how the agent's `skills` tool knows it.
 */
export function insertAgentCommandItem(
	text: string,
	item: SlashCommand,
	cursorPosition: number,
): { newValue: string; newCursorPosition: number } {
	const word = text.slice(0, cursorPosition).match(/\S*$/)?.[0] ?? ""
	const start = cursorPosition - word.length
	const token = item.section === "agent" ? item.name : `/${item.name}`
	const rest = text.slice(cursorPosition).replace(/^\S*/, "")
	return {
		newValue: `${text.slice(0, start)}${token}${rest.startsWith(" ") ? rest : ` ${rest}`}`,
		newCursorPosition: start + token.length + 1,
	}
}

/**
 * Insert a slash command at position or replace partial command
 */
export function insertSlashCommand(
	text: string,
	commandName: string,
	partialCommandLength: number,
	cursorPosition: number,
): { newValue: string; commandIndex: number } {
	// Find the slash nearest to cursor (before cursor position)
	const beforeCursor = text.slice(0, cursorPosition)
	const slashIndex = beforeCursor.lastIndexOf("/")

	const beforeSlash = text.substring(0, slashIndex + 1)
	const afterPartialCommand = text.substring(slashIndex + 1 + partialCommandLength)

	// replace the partial command with the full command
	const newValue =
		beforeSlash + commandName + (afterPartialCommand.startsWith(" ") ? afterPartialCommand : " " + afterPartialCommand)

	return { newValue, commandIndex: slashIndex }
}

/**
 * Determines the validation state of a slash command
 * Returns partial if we have a partial match against valid commands, or full for full match
 */
export function validateSlashCommand(
	command: string,
	localWorkflowToggles: Record<string, boolean> = {},
	globalWorkflowToggles: Record<string, boolean> = {},
	remoteWorkflowToggles?: Record<string, boolean>,
	remoteWorkflows?: any[],
	mcpServers: McpServer[] = [],
	skillNames: readonly string[] = [],
): "full" | "partial" | null {
	if (!command) {
		return null
	}

	const workflowCommands = getWorkflowCommands(
		localWorkflowToggles,
		globalWorkflowToggles,
		remoteWorkflowToggles,
		remoteWorkflows,
	)
	const mcpPromptCommands = getMcpPromptCommands(mcpServers)
	const allCommands = [
		...DEFAULT_SLASH_COMMANDS,
		...workflowCommands,
		...mcpPromptCommands,
		...skillNames.map((name) => ({ name })),
	]

	// case insensitive matching
	const exactMatch = allCommands.some((cmd) => cmd.name.toLowerCase() === command.toLowerCase())

	if (exactMatch) {
		return "full"
	}

	const partialMatch = allCommands.some((cmd) => cmd.name.toLowerCase().startsWith(command.toLowerCase()))

	if (partialMatch) {
		return "partial"
	}

	return null // no match
}
