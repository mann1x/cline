import type { CheckApproval, CheckProposal } from "@cline/core"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import { type AskUser, putToUser, putToUserModally } from "./user-choice"

/**
 * Asking the user to approve the check a model proposed.
 *
 * The change protocol judges every attempt by running something. Where a
 * workspace holds nothing runnable — one HTML file, a script, a game — there
 * is nothing to judge with and the verdict falls back to the model's own
 * account of its work, which is where every wrong verdict measured so far has
 * come from. The model can name a check; it cannot be the one who decides its
 * own exam is fair. This is that decision.
 *
 * Never auto-approved, wherever it is asked. An approved command is then run
 * repeatedly and unattended for the rest of the run, so this is the security
 * boundary rather than a convenience — and the user is shown the exact text
 * that will run, because that is the thing being approved. In the chat it is
 * shown in a fenced block, which is the first surface that has made the
 * difference between a command and prose visible at a glance.
 */

const APPROVE = "Use this check"
const DECLINE = "No — I'll say what I want"

export function createCheckApprover(askUser: AskUser | undefined) {
	return async function approveProposedCheck(proposal: CheckProposal, described: string): Promise<CheckApproval> {
		try {
			// A shell line is named as one. It is the kind that runs something
			// outside Cerebriline, repeatedly and unattended, so the question says so
			// rather than making the user read the text to find out.
			const opening =
				proposal.kind === "command"
					? "Cerebriline proposes running a command to judge this task:"
					: "Cerebriline proposes a check for this task:"

			if (!askUser) {
				const answer = await putToUserModally(
					`${opening}\n\n${described}\n\nEvery attempt is judged by it, and it cannot be changed later in this run.`,
					[APPROVE, DECLINE],
				)
				if (answer.picked === APPROVE) {
					return { approved: true }
				}
				// Dismissed is declined, and silently: a user who closed the
				// dialog has not asked for anything different.
				if (answer.picked !== DECLINE) {
					return { approved: false }
				}
				const said = await HostProvider.window.showInputBox({
					title: "What should the check be?",
					prompt: "In your own words — a command to run, a file to load, or what would convince you the task is done.",
					value: "",
				})
				const feedback = said.response?.trim()
				return feedback ? { approved: false, feedback } : { approved: false }
			}

			const answer = await putToUser(
				askUser,
				[
					`**${opening}**`,
					"",
					described,
					"",
					"Every attempt is judged by it, and it cannot be changed later in this run. Say what you want instead and it goes back to the model.",
				].join("\n"),
				[APPROVE, DECLINE],
			)

			if (answer.picked === APPROVE) {
				return { approved: true }
			}
			// One step where the dialog needed two: declining and saying what
			// you want are the same act in the chat, so there is no second
			// prompt to dismiss and no way to decline into a dead end.
			return answer.said ? { approved: false, feedback: answer.said } : { approved: false }
		} catch (error) {
			// A session must start and finish whether or not the user can be
			// asked. The protocol reads a throw as "nobody could be asked" and
			// carries on with the weaker verdict, which is what it would have
			// had anyway.
			Logger.warn(`[Atomic] the check proposal could not be put to the user: ${error}`)
			throw error
		}
	}
}
