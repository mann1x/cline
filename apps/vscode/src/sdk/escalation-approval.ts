import type { EscalationApproval } from "@cline/core"
import { Logger } from "@/shared/services/Logger"
import { type AskUser, putToUser, putToUserModally } from "./user-choice"

/**
 * Asking the user before the task is handed to the expert.
 *
 * Off unless they asked for it. What makes the question worth having when it is
 * on is the pair of accounts it carries: the model's own reason for escalating
 * — the one piece of evidence it has an interest in — and the harness's
 * independent reading of the same run, computed from things that were counted.
 * A disagreement between the two is the most useful thing on the screen, which
 * is why the brief goes out whole here and was truncated at 2,000 characters
 * for as long as this was a dialog.
 *
 * A refusal costs nothing. The budget is there to ration the model, and a
 * person saying no is not the model overspending, so the escalation count does
 * not move and the tool comes back with a result the model can act on. A
 * refusal that carries a reason comes back with the reason too.
 */

const APPROVE = "Hand it over"
const DECLINE = "No — keep going"

/** How much of the brief a modal shows before it stops being readable. */
const BRIEF_PREVIEW_CHARS = 2_000

export interface EscalationApprovalRequest {
	brief: string
	index: number
	of: number
}

export function createEscalationApprover(askUser: AskUser | undefined) {
	return async function approveEscalation(request: EscalationApprovalRequest): Promise<EscalationApproval> {
		try {
			if (!askUser) {
				const preview =
					request.brief.length > BRIEF_PREVIEW_CHARS
						? `${request.brief.slice(0, BRIEF_PREVIEW_CHARS)}\n\n… (${request.brief.length - BRIEF_PREVIEW_CHARS} more characters)`
						: request.brief
				const answer = await putToUserModally(
					`Cerebriline wants to hand this task to the expert model (escalation ${request.index} of ${request.of}).\n\n${preview}\n\nThe expert edits your files and takes the task over until it hands back.`,
					[APPROVE, DECLINE],
				)
				return { approved: answer.picked === APPROVE }
			}

			// Whole, and as markdown. The brief is written as markdown by the
			// code that builds it -- headings, a fenced block for the check, a
			// list of what has already been tried -- and the chat is the first
			// surface that renders it as written.
			const answer = await putToUser(
				askUser,
				[
					`**Hand this task to the expert?** — escalation ${request.index} of ${request.of}`,
					"",
					request.brief,
					"",
					"---",
					"",
					"The expert edits your files and takes the task over until it hands back. Saying no spends nothing, and you can say what you want done instead.",
				].join("\n"),
				[APPROVE, DECLINE],
			)

			if (answer.picked === APPROVE) {
				return { approved: true }
			}
			// Typed instead of clicked: a refusal and an instruction at once.
			// The model is told both, because "no" alone leaves it guessing at
			// what it should have done and it will usually guess "ask again".
			return answer.said ? { approved: false, feedback: answer.said } : { approved: false }
		} catch (error) {
			// Dismissed, or no window to show it in. Either way nobody approved,
			// and the setting that asked for an approval is not satisfied by one
			// that could not be requested.
			Logger.warn(`[Escalation] the escalation could not be put to the user: ${error}`)
			return { approved: false }
		}
	}
}
