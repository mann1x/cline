export interface SlashCommand {
	name: string
	description?: string
	section?: "default" | "custom" | "mcp" | "agent" | "skill"
	cliCompatible?: boolean
}

export const BASE_SLASH_COMMANDS: SlashCommand[] = [
	// `/newtask` is an alias of `/compact`: condensing achieves its goal
	// (continue working with a fresh, summarized context window) without the
	// legacy new_task tool. The webview intercepts all three spellings and
	// runs the condense RPC (see useMessageHandlers.handleSendMessage).
	{
		name: "newtask",
		description: "Condenses the current task and continues with a fresh context window",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "deep-planning",
		description: "Create a comprehensive implementation plan before coding",
		section: "default",
		cliCompatible: true,
	},
	// NOTE: legacy's /newrule and /reportbug are hidden until their prompt
	// expansions are ported to the SDK runtime — without expansion the literal
	// command text reaches the model, which silently degrades to plain chat.
	{
		name: "compact",
		description: "Condenses your current context window",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "agent",
		description: "Hand a task to an agent: /agent <agent> [/skill] <task>, or describe it and the model picks one",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "delegate",
		description: "Hand a task to a configured agent: /delegate <agent> <task>",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "delegate-background",
		description: "Hand a task to an agent and keep working: /delegate-background <agent> <task>",
		section: "default",
		cliCompatible: true,
	},
	{
		name: "smol",
		description: "Alias for /compact",
		section: "default",
		cliCompatible: true,
	},
]

// VS Code-only slash commands
export const VSCODE_ONLY_COMMANDS: SlashCommand[] = [
	// A picker, not a command: what follows it filters the skills, and the one
	// picked replaces it as `/<skill-name>`. Nothing is sent as `/skill`.
	{
		name: "skill",
		description: "Find a skill: type words from its name or description",
		section: "default",
	},
]

/**
 * A skill's command name, as the runtime spells it.
 *
 * A copy of `normalizeRuntimeCommandName` in @cline/core
 * (extensions/config/runtime-commands.ts), which the webview cannot import:
 * the `/` menu and the `/skill` picker insert the token the runtime knows a
 * skill by, or the model is handed a command that names no skill.
 * `slashCommands.test.ts` beside it holds the two to the same answers.
 */
export function skillCommandName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[^\p{L}\p{N}_.:@-]+/gu, "-")
		.replace(/-+/g, "-")
		.replace(/^-/, "")
		.replace(/-$/, "")
}
