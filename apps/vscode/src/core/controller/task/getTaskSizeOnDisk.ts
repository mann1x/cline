import { StringRequest } from "@shared/proto/cline/common"
import { TaskSizeOnDisk } from "@shared/proto/cline/task"
import { Controller } from ".."

/**
 * Measures one task's footprint on disk: its session directory -- transcripts,
 * delegated agents' overlays, compaction state -- plus how many checkpoints it
 * holds. Also refreshes the size the history list shows.
 * @param controller The controller instance
 * @param request The task ID
 * @returns The footprint, with `measured: false` when there is nothing to measure
 */
export async function getTaskSizeOnDisk(controller: Controller, request: StringRequest): Promise<TaskSizeOnDisk> {
	const id = request.value?.trim()
	if (!id) {
		throw new Error("Missing task ID")
	}
	const size = await controller.getTaskSizeOnDisk(id)
	if (!size) {
		return TaskSizeOnDisk.create({ measured: false })
	}
	return TaskSizeOnDisk.create({
		totalBytes: size.totalBytes,
		sessionBytes: size.sessionBytes,
		agentTranscriptBytes: size.agentTranscriptBytes,
		overlayBytes: size.overlayBytes,
		checkpointCount: size.checkpointCount,
		measured: true,
	})
}
