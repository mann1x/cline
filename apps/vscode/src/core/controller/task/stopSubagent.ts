import { stopSubagent as stopAgent } from "@cline/core"
import { Empty } from "@shared/proto/cline/common"
import type { StopSubagentRequest } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

/**
 * Stop one sub-agent from its row or the panel, as the user chose in the
 * dialog: gracefully -- its step, then one turn to report where it stopped --
 * or at once. The same stop the lead's `stop_agents` makes, so a graceful
 * stop from here reaches the lead as the same partial report.
 *
 * Pressed again while a graceful stop runs, the dialog offers `immediate`,
 * which ends it at once. An id naming nothing running is a no-op: the agent
 * may have finished while the dialog was open.
 */
export async function stopSubagent(_controller: Controller, request: StopSubagentRequest): Promise<Empty> {
	const id = request.id?.trim()
	if (!id) {
		return Empty.create()
	}
	const outcome = stopAgent({ cancelId: id, by: "user", immediate: request.immediate === true })
	Logger.log(`[Agents] ${request.immediate ? "immediate" : "graceful"} stop requested for ${id}: ${outcome}`)
	return Empty.create()
}
