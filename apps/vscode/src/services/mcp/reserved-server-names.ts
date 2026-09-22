import { VSCODE_MCP_SERVER_NAME } from "@/sdk/vscode-lm-mcp-tools"

/**
 * The one server name the editor bridge has already taken.
 *
 * Kept under its own name so the reason a configured server is refused reads
 * as "reserved" rather than as "this is the VS Code one".
 */
export const RESERVED_MCP_SERVER_NAME = VSCODE_MCP_SERVER_NAME

/**
 * Removes configured servers whose names we have already taken.
 *
 * `vscode` is the synthetic entry the editor bridge publishes for the MCP
 * servers VS Code itself holds, and `McpHub.toggleServerDisabledRPC`,
 * `toggleToolAutoApproveRPC` and `getServersForPanel` all branch on that exact
 * string. A server configured under the same name is therefore shadowed rather
 * than served: the panel's switches would drive the bridge instead, and its
 * tools would collide with the bridge's `vscode__*` names -- which nothing
 * downstream notices, because agent tool names are not checked for duplicates.
 *
 * Refused per server, not per file. A schema error loads nothing on purpose,
 * but one reserved name is not a reason to drop the user's other servers.
 */
export function stripReservedServerNames<T extends { mcpServers?: Record<string, unknown> }>(
	settings: T,
): { settings: T; refused: string[] } {
	const servers = settings.mcpServers
	if (!servers || !Object.hasOwn(servers, RESERVED_MCP_SERVER_NAME)) {
		return { settings, refused: [] }
	}

	const kept: Record<string, unknown> = {}
	for (const [name, config] of Object.entries(servers)) {
		if (name !== RESERVED_MCP_SERVER_NAME) {
			kept[name] = config
		}
	}
	return { settings: { ...settings, mcpServers: kept }, refused: [RESERVED_MCP_SERVER_NAME] }
}
