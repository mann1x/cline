import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/index.host"
import { Logger } from "@/shared/services/Logger"

/**
 * Asking the user before the task is handed to the expert.
 *
 * Off unless they asked for it. What makes the dialog worth having when it is
 * on is the pair of accounts it carries: the model's own reason for escalating
 * — the one piece of evidence it has an interest in — and the harness's
 * independent reading of the same run, computed from things that were counted.
 * A disagreement between the two is the most useful thing on the screen.
 *
 * A refusal costs nothing. The budget is there to ration the model, and a
 * person saying no is not the model overspending, so the escalation count does
 * not move and the tool comes back with a result the model can act on.
 */

const APPROVE = "Hand it over"
const DECLINE = "No — keep going"

/** How much of the brief the dialog shows before it stops being readable. */
const BRIEF_PREVIEW_CHARS = 2_000

export async function approveEscalation(request: { brief: string; index: number; of: number }): Promise<boolean> {
	try {
		const brief =
			request.brief.length > BRIEF_PREVIEW_CHARS
				? `${request.brief.slice(0, BRIEF_PREVIEW_CHARS)}\n\n… (${request.brief.length - BRIEF_PREVIEW_CHARS} more characters)`
				: request.brief
		const answer = await HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: `Cline wants to hand this task to the expert model (escalation ${request.index} of ${request.of}).\n\n${brief}\n\nThe expert edits your files and takes the task over until it hands back.`,
			options: { modal: true, items: [APPROVE, DECLINE] },
		})
		return answer.selectedOption === APPROVE
	} catch (error) {
		// Dismissed, or no window to show it in. Either way nobody approved,
		// and the setting that asked for an approval is not satisfied by one
		// that could not be requested.
		Logger.warn(`[Escalation] the escalation could not be put to the user: ${error}`)
		return false
	}
}
