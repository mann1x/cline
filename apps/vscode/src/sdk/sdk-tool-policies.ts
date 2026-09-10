import { defaultMcpToolNameTransform } from "@cline/core"
import type { AutoApprovalSettings } from "@shared/AutoApprovalSettings"
import type { McpHub } from "@/services/mcp/McpHub"

/**
 * Build SDK `toolPolicies` for tools governed by Cline's auto-approval UI.
 *
 * The SDK defaults unlisted tools to auto-approved. For tools controlled by
 * the AutoApproveBar toggles (including all MCP tools), force the SDK to call
 * `requestToolApproval`; the approval callback then evaluates the latest
 * settings and either silently approves or shows the approval UI. This keeps
 * active sessions in sync when the user toggles auto-approval mid-task.
 */
export function buildToolPolicies(
	_settings: AutoApprovalSettings,
	mcpHub?: McpHub,
): Record<string, { enabled?: boolean; autoApprove?: boolean }> {
	const policies: Record<string, { enabled?: boolean; autoApprove?: boolean }> = {}

	const set = (tools: string[]) => {
		for (const tool of tools) {
			policies[tool] = { autoApprove: false }
		}
	}

	set(["read_files", "read_file", "list_files", "list_code_definition_names", "search_codebase", "search_files"])
	set(["editor", "replace_in_file", "write_to_file", "apply_patch", "delete_file"])
	set(["run_commands", "execute_command"])
	set(["fetch_web_content", "web_fetch", "web_search"])
	set(["browser", "browser_action"])

	if (mcpHub) {
		for (const server of mcpHub.getServers()) {
			for (const tool of server.tools ?? []) {
				// The name the tool is actually registered under, which is not
				// always `server__tool`: `defaultMcpToolNameTransform` replaces
				// anything outside [A-Za-z0-9_-] and truncates past 64 characters
				// with a hash. A policy keyed by the raw pair matches nothing for
				// a server called `Microsoft Learn` or
				// `github.com/modelcontextprotocol/servers/...`, and an unlisted
				// tool is auto-approved by the SDK -- so those servers ran with no
				// approval gate at all, whatever the toggle said.
				policies[defaultMcpToolNameTransform({ serverName: server.name, toolName: tool.name })] = {
					autoApprove: false,
				}
			}
		}
	}

	return policies
}

/**
 * Evaluate the current UI auto-approval settings for a single SDK tool name.
 * Used both when building initial SDK policies and as a live guard in the
 * approval callback, so changes from the AutoApproveBar are respected even if
 * an SDK session was created before the toggle changed.
 */
export function isToolAutoApproved(toolName: string, settings: AutoApprovalSettings, mcpHub?: McpHub): boolean {
	if (isReadTool(toolName)) {
		return !!settings.actions.readFiles
	}
	if (isEditTool(toolName)) {
		return !!settings.actions.editFiles
	}
	if (isCommandTool(toolName)) {
		return !!settings.actions.executeSafeCommands
	}
	if (isWebFetchTool(toolName)) {
		return !!settings.actions.useBrowser
	}
	if (isBrowserTool(toolName)) {
		// Falls back to the web-fetch toggle when the browser one is absent,
		// which is what settings written before it existed look like.
		return !!(settings.actions.useBrowserTool ?? settings.actions.useBrowser)
	}

	// Whether this is an MCP tool at all is answered by finding it, not by the
	// shape of its name: a server name long enough to be truncated leaves a
	// registered name with no `__` in it and none of the tool's own name, so
	// there is nothing in the string to recognize or split.
	const mcpTool = mcpHub ? findMcpTool(toolName, mcpHub) : undefined
	if (mcpTool) {
		// `useMcp` is the gate, not the grant: a tool is auto-approved only when
		// the user marked that tool auto-approve on its server. The per-tool tick
		// boxes in the MCP panel are what set that flag; they were hidden while
		// upstream had the toggle grant everything, which left this branch with
		// no reachable way to return true.
		return !!settings.actions.useMcp && !!mcpTool.autoApprove
	}

	return false
}

function isReadTool(toolName: string): boolean {
	return ["read_files", "read_file", "list_files", "list_code_definition_names", "search_codebase", "search_files"].includes(
		toolName,
	)
}

export function isEditTool(toolName: string): boolean {
	return ["editor", "replace_in_file", "write_to_file", "apply_patch", "delete_file"].includes(toolName)
}

function isCommandTool(toolName: string): boolean {
	return toolName === "run_commands" || toolName === "execute_command"
}

function isWebFetchTool(toolName: string): boolean {
	return toolName === "fetch_web_content" || toolName === "web_fetch" || toolName === "web_search"
}

/**
 * The tools that drive a real browser.
 *
 * Kept apart from the web-fetch tools, which used to share their toggle. They
 * are not the same risk: fetching a URL returns its text, while this launches a
 * browser process that runs whatever the page contains. Someone can reasonably
 * want the first to go through unattended and the second to ask every time, and
 * with one checkbox for both they could not have it.
 */
function isBrowserTool(toolName: string): boolean {
	return toolName === "browser" || toolName === "browser_action"
}

/**
 * The tool one of this hub's servers is offering under this registered name.
 *
 * Resolved by re-applying the registration transform to every known
 * server/tool pair rather than by splitting the name. Splitting is what the
 * transform makes unsafe: `Microsoft Learn` arrives as `Microsoft_Learn`, and
 * a name long enough to be truncated ends in a hash with the tool's own name
 * cut off entirely, so neither half of a split is the thing it names.
 */
function findMcpTool(registeredName: string, mcpHub: McpHub): { autoApprove?: boolean } | undefined {
	for (const server of mcpHub.getServers()) {
		for (const tool of server.tools ?? []) {
			if (defaultMcpToolNameTransform({ serverName: server.name, toolName: tool.name }) === registeredName) {
				return tool
			}
		}
	}
	return undefined
}
