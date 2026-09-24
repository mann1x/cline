import { subagentCancellation } from "@cline/core"
import { Empty, StringRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

/**
 * Start one running sub-agent again from its task, in the same round.
 *
 * Stop was the only control on a stuck agent, and a stopped agent is a lost
 * task: the lead is told "stopped" and the round is a report short. Measured on
 * pandorum 2026-09-24: two agents hung on streams a server restart dropped.
 *
 * Same id and same no-op rule as the stop: an agent that has finished by the
 * time the button is pressed has nothing to restart.
 */
export async function restartSubagent(_controller: Controller, request: StringRequest): Promise<Empty> {
	const id = request.value?.trim()
	if (!id) {
		return Empty.create()
	}
	const restarted = subagentCancellation.restart(id)
	Logger.log(`[Agents] restart requested for ${id}: ${restarted ? "restarting" : "not running"}`)
	return Empty.create()
}
