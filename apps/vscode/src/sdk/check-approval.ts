import type { CheckApproval, CheckProposal } from "@cline/core"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/index.host"
import { Logger } from "@/shared/services/Logger"

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
 * Modal on purpose, and never auto-approved. An approved command is then run
 * repeatedly and unattended for the rest of the run, so this dialog is the
 * security boundary rather than a convenience — and the user is shown the
 * exact text that will run, because that is the thing being approved.
 */

const APPROVE = "Use this check"
const DECLINE = "No — I'll say what I want"

export async function approveProposedCheck(proposal: CheckProposal, described: string): Promise<CheckApproval> {
	try {
		// A shell line is named as one. It is the kind that runs something
		// outside Cline, repeatedly and unattended, so the dialog says so
		// rather than making the user read the text to find out.
		const opening =
			proposal.kind === "command"
				? "Cline proposes running a command to judge this task:"
				: "Cline proposes a check for this task:"
		const answer = await HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: `${opening}\n\n${described}\n\nEvery attempt is judged by it, and it cannot be changed later in this run.`,
			options: { modal: true, items: [APPROVE, DECLINE] },
		})

		if (answer.selectedOption === APPROVE) {
			return { approved: true }
		}
		// Dismissed is declined, and silently: a user who closed the dialog has
		// not asked for anything different, so there is nothing to pass on.
		if (answer.selectedOption !== DECLINE) {
			return { approved: false }
		}

		const said = await HostProvider.window.showInputBox({
			title: "What should the check be?",
			prompt: "In your own words — a command to run, a file to load, or what would convince you the task is done.",
			value: "",
		})
		const feedback = said.response?.trim()
		return feedback ? { approved: false, feedback } : { approved: false }
	} catch (error) {
		// A session must start and finish whether or not a dialog can be shown.
		// The protocol reads a throw as "nobody could be asked" and carries on
		// with the weaker verdict, which is what it would have had anyway.
		Logger.warn(`[Atomic] the check proposal could not be put to the user: ${error}`)
		throw error
	}
}
