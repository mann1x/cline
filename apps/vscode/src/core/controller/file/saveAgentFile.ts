import { AgentsResponse, SaveAgentRequest } from "@shared/proto/cline/file"
import { Controller } from ".."
import { listAgents, writeAgent } from "./agent-files"

/**
 * Writes one agent's file and returns the list as it now stands.
 *
 * The whole list comes back rather than the one agent: a save can rename a
 * file, move it between global and workspace, or replace one that was already
 * there, and a tab that patched its own row would be guessing at all three.
 */
export async function saveAgentFile(_controller: Controller, request: SaveAgentRequest): Promise<AgentsResponse> {
	if (!request.agent) {
		throw new Error("saveAgentFile: no agent in the request")
	}
	await writeAgent(request.agent, request.originalPath || undefined)
	return listAgents()
}
