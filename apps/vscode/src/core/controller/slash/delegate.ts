import { DelegateRequest, DelegateResponse } from "@shared/proto/cline/slash"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/index.host"
import type { Controller } from ".."

/**
 * Say why a delegation did not run, where the user will see it.
 *
 * The chat sends the command and moves on, so a refusal that only rejects the
 * call reached nobody: a misspelled agent, or one from someone else's
 * machine, read as "nothing happened". Rethrown so the caller still sees it.
 */
export function reportDelegationFailure(command: string, error: unknown): never {
	const message = error instanceof Error ? error.message : String(error)
	try {
		void HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: `${command}: ${message}` }).catch(() => {})
	} catch {
		// No host to show it on: the caller still gets the refusal itself.
	}
	throw error
}

/**
 * `/delegate <agent> <task>` — hand work to a configured agent.
 *
 * Distinct from the lead model calling `subagent_<name>` itself: the model is
 * not consulted about whether to delegate, and does not get a turn until the
 * agent has reported back. "Run the QA agent on this" is an instruction, and a
 * session where the lead quietly does the work itself instead has declined it.
 */
export async function delegate(controller: Controller, request: DelegateRequest): Promise<DelegateResponse> {
	const result = await controller
		.delegateToAgent(request.agentName, request.prompt)
		.catch((error) => reportDelegationFailure("/delegate", error))
	return DelegateResponse.create({
		agentName: result.agentName,
		text: result.text,
		iterations: result.iterations,
		durationMs: result.durationMs,
	})
}
