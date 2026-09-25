import { Empty } from "@shared/proto/cline/common"
import { SetTaskTagsRequest } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from "../"

/** Replaces the tags on a task; an empty list removes them all. */
export async function setTaskTags(controller: Controller, request: SetTaskTagsRequest): Promise<Empty> {
	if (!request.taskId) {
		Logger.error(`[setTaskTags] Invalid request: taskId missing`)
		return Empty.create({})
	}

	try {
		await controller.setTaskTags(request.taskId, request.tags)
		return Empty.create({})
	} catch (error) {
		Logger.error("Error in setTaskTags:", error)
		throw error
	}
}
