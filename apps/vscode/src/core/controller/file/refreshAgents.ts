import { AgentsResponse } from "@shared/proto/cline/file"
import { Controller } from ".."
import { listAgents } from "./agent-files"

/**
 * Lists the subagents defined on disk, with what the form needs to edit one.
 */
export async function refreshAgents(_controller: Controller): Promise<AgentsResponse> {
	return listAgents()
}
