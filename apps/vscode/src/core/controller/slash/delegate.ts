import { DelegateRequest, DelegateResponse } from "@shared/proto/cline/slash"
import type { Controller } from ".."

/**
 * `/delegate <agent> <task>` — hand work to a configured agent.
 *
 * Distinct from the lead model calling `subagent_<name>` itself: the model is
 * not consulted about whether to delegate, and does not get a turn until the
 * agent has reported back. "Run the QA agent on this" is an instruction, and a
 * session where the lead quietly does the work itself instead has declined it.
 */
export async function delegate(controller: Controller, request: DelegateRequest): Promise<DelegateResponse> {
	const result = await controller.delegateToAgent(request.agentName, request.prompt)
	return DelegateResponse.create({
		agentName: result.agentName,
		text: result.text,
		iterations: result.iterations,
		durationMs: result.durationMs,
	})
}
