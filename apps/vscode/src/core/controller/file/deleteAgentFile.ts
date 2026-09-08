import { AgentsResponse, DeleteAgentRequest } from "@shared/proto/cline/file"
import { Controller } from ".."
import { listAgents, removeAgent } from "./agent-files"

/**
 * Removes one agent's file and returns the list as it now stands.
 */
export async function deleteAgentFile(_controller: Controller, request: DeleteAgentRequest): Promise<AgentsResponse> {
	await removeAgent(request.path)
	return listAgents()
}
