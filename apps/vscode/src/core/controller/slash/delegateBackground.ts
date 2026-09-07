import { BackgroundDelegation, type DelegateRequest } from "@shared/proto/cline/slash"
import type { Controller } from "../index"

/**
 * Start a configured agent beside the current turn.
 *
 * Unlike `delegate`, this returns as soon as the run exists rather than when
 * the agent is done — so the response describes a run, not a result. What the
 * agent reported reaches the conversation on its own when it finishes.
 */
export async function delegateBackground(controller: Controller, request: DelegateRequest): Promise<BackgroundDelegation> {
	const run = await controller.startBackgroundDelegation(request.agentName, request.prompt)
	return BackgroundDelegation.create({
		id: run.id,
		agentName: run.agentName,
		prompt: run.prompt,
		status: run.status,
		startedAt: run.startedAt,
		endedAt: run.endedAt ?? 0,
		activity: run.activity ?? "",
		error: run.error ?? "",
	})
}
