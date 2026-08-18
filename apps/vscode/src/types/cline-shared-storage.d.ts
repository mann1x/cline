declare module "@cline/shared/storage" {
	export function resolveGlobalSettingsPath(): string
	export function resolveSessionDataDir(): string
	/** `~/.cline/agents` — where a global subagent's file lives. */
	export function resolveAgentsConfigDirPath(): string
	/** The workspace agents directory first, then the global one. */
	export function resolveAgentConfigSearchPaths(workspacePath?: string): string[]
}
