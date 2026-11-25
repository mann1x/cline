import type { StringRequest } from "@shared/proto/cline/common"
import { AgentCommandPlan } from "@shared/proto/cline/slash"
import type { Controller } from ".."
import { reportDelegationFailure } from "./delegate"

/**
 * `/agent ...` — say what it does before anything runs.
 *
 * The chat asks first and acts on the answer: a named agent goes to `delegate`,
 * anything else is sent to the lead as the returned message. A refusal (no task,
 * a skill the agent may not load, agents turned off) is shown here and rejects,
 * so the chat keeps the text for the user to fix.
 */
export async function prepareAgentCommand(controller: Controller, request: StringRequest): Promise<AgentCommandPlan> {
	const plan = await controller.planAgentCommand(request.value ?? "").catch((error) => reportDelegationFailure("/agent", error))
	if (plan.kind === "refused") {
		reportDelegationFailure("/agent", new Error(plan.reason))
	}
	return plan.kind === "delegate"
		? AgentCommandPlan.create({ agentName: plan.agentName, prompt: plan.prompt })
		: AgentCommandPlan.create({ leadMessage: plan.message })
}
