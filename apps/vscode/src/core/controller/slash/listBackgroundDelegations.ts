import type { EmptyRequest } from "@shared/proto/cline/common"
import { BackgroundDelegation, BackgroundDelegationList } from "@shared/proto/cline/slash"
import type { Controller } from "../index"

/** The background delegations of the active session, for the panel. */
export async function listBackgroundDelegations(
	controller: Controller,
	_request: EmptyRequest,
): Promise<BackgroundDelegationList> {
	const runs = await controller.listBackgroundDelegations()
	return BackgroundDelegationList.create({
		runs: runs.map((run) =>
			BackgroundDelegation.create({
				id: run.id,
				agentName: run.agentName,
				prompt: run.prompt,
				status: run.status,
				startedAt: run.startedAt,
				endedAt: run.endedAt ?? 0,
				activity: run.activity ?? "",
				error: run.error ?? "",
			}),
		),
	})
}
