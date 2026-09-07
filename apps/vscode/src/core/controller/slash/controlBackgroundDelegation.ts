import { Boolean as ProtoBoolean } from "@shared/proto/cline/common"
import type { BackgroundDelegationControl } from "@shared/proto/cline/slash"
import type { Controller } from "../index"

/**
 * Pause, resume or stop one background delegation.
 *
 * `false` for a run that was not in a state to take the action — already
 * finished, already paused — rather than an error: the panel and the run can
 * disagree for a moment, and a stale button press is not a failure.
 */
export async function controlBackgroundDelegation(
	controller: Controller,
	request: BackgroundDelegationControl,
): Promise<ProtoBoolean> {
	const action = request.action
	if (action !== "pause" && action !== "resume" && action !== "stop") {
		return ProtoBoolean.create({ value: false })
	}
	return ProtoBoolean.create({ value: await controller.controlBackgroundDelegation(request.id, action) })
}
