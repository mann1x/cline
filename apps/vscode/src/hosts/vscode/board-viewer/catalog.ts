import { EXPRESSION_FUNCTIONS, getShippedToolCallSignatures, loadConfiguredAgentConfigs } from "@cline/core"
import { resolveAgentConfigSearchPaths } from "@cline/shared/storage"
import { TOOLS_NOT_OFFERED } from "@/core/controller/file/agent-files"
import type { ViewerCatalog } from "@/shared/board-viewer"

/** The board is redrawn in bursts; the agent folders are read at most this often. */
const AGENTS_TTL_MS = 5_000

let cached: { root: string | undefined; at: number; agents: string[] } | undefined

/**
 * What a pipeline step can name, for the step form's completions: the tools
 * a conversation has (the runtime's own list, less the ones a pipeline does
 * not call), the configured agents of this workspace and the user's, and
 * the functions an expression may call.
 */
export function viewerCatalog(workspaceRoot: string | undefined, now = Date.now()): ViewerCatalog {
	if (!cached || cached.root !== workspaceRoot || now - cached.at > AGENTS_TTL_MS) {
		let agents: string[] = []
		try {
			agents = loadConfiguredAgentConfigs({
				searchPaths: resolveAgentConfigSearchPaths(workspaceRoot).filter(Boolean),
			}).configs.map((config) => config.name)
		} catch {
			agents = []
		}
		cached = { root: workspaceRoot, at: now, agents }
	}
	return {
		tools: [
			...new Set(
				getShippedToolCallSignatures()
					.map((signature) => signature.name)
					.filter((name) => !TOOLS_NOT_OFFERED.has(name)),
			),
		].sort((a, b) => a.localeCompare(b)),
		agents: [...cached.agents].sort((a, b) => a.localeCompare(b)),
		functions: [...EXPRESSION_FUNCTIONS],
	}
}
