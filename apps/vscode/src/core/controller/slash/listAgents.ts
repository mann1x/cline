import type { EmptyRequest } from "@shared/proto/cline/common"
import { AgentListResponse, AgentSummary } from "@shared/proto/cline/slash"
import type { Controller } from ".."

/** The agents this session can hand work to, for autocomplete and pickers. */
export async function listAgents(controller: Controller, _request: EmptyRequest): Promise<AgentListResponse> {
	const agents = await controller.listConfiguredAgents()
	return AgentListResponse.create({
		agents: agents.map((agent: (typeof agents)[number]) =>
			AgentSummary.create({
				name: agent.name,
				description: agent.description,
				toolName: agent.toolName,
				// One field for "somewhere other than the session", because that is
				// the only thing a picker needs to say about where an agent runs.
				runsOn: agent.profile ?? agent.modelId ?? "",
			}),
		),
	})
}
