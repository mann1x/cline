import { subagentCancellation } from "@cline/core"
import { Empty, StringRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

/**
 * Stop one running sub-agent, leaving the session and its siblings alone.
 *
 * `cancelTask` was the only control, and it is the wrong one for this: a
 * fan-out of five where one agent grinds has four reports already written, and
 * cancelling the session throws them away with the lead's context.
 *
 * The id is the one the spawn tool announced on the row that is offering the
 * stop, so nothing here reconstructs it. An id that names nothing running is a
 * no-op rather than an error: by the time a button is pressed the agent may
 * have finished on its own, and that is the good outcome, not a failure.
 */
export async function cancelSubagent(_controller: Controller, request: StringRequest): Promise<Empty> {
	const id = request.value?.trim()
	if (!id) {
		return Empty.create()
	}
	const stopped = subagentCancellation.cancel(id)
	Logger.log(`[Agents] stop requested for ${id}: ${stopped ? "aborted" : "not running"}`)
	return Empty.create()
}
