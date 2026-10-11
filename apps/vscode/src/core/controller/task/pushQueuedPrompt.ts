import { Empty, type StringRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Sends a queued prompt of the active SDK session to the model now, at its
 * next turn boundary, instead of after the run.
 *
 * @param controller The controller instance
 * @param request The request containing the queued prompt ID
 * @returns Empty response
 */
export async function pushQueuedPrompt(controller: Controller, request: StringRequest): Promise<Empty> {
	try {
		await controller.pushQueuedPrompt(request.value)
		return Empty.create()
	} catch (error) {
		Logger.error("Error in pushQueuedPrompt handler:", error)
		throw error
	}
}
