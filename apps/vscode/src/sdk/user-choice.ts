/**
 * Putting a decision to the user in the chat, where there is room for it.
 *
 * Both of the decisions this serves -- the check a model proposed, and handing
 * the task to the expert -- were modal dialogs. A modal is the wrong surface
 * for either: `showMessage` renders its text as a flat string, so a brief
 * written in markdown arrives as literal asterisks and fenced code, and the
 * dialog truncates. The escalation brief carries the task, the transaction, the
 * change budget and what has already been tried; the thing the user is being
 * asked to judge was the part that got cut.
 *
 * The chat already has the surface: `ask:"followup"` renders its question
 * through `MarkdownRow` and its options through `OptionsButtons`, which is the
 * same control the model's own questions use. It also accepts a typed reply
 * instead of a click, which is what makes "no, do this instead" expressible at
 * all -- the dialog could only say no.
 */

import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/index.host"

/** Puts a question with options into the chat and resolves with what came back. */
export type AskUser = (question: string, options: string[]) => Promise<string>

export interface UserChoice {
	/** The option they clicked, when they clicked one. */
	picked?: string
	/** What they typed instead, when they typed. */
	said?: string
}

/**
 * Ask, and work out which of the two things happened.
 *
 * The ask resolves with a plain string for both cases, so an answer that
 * matches an option exactly is read as a click and anything else as typing.
 * Exact match rather than fuzzy: an option is a button whose label is sent
 * back verbatim, and a user who types something that merely resembles one has
 * said something, not clicked it.
 */
export async function putToUser(askUser: AskUser, question: string, options: string[]): Promise<UserChoice> {
	const answer = (await askUser(question, options))?.trim() ?? ""
	if (options.includes(answer)) {
		return { picked: answer }
	}
	return answer ? { said: answer } : {}
}

/**
 * The modal, kept for hosts with no chat to ask in.
 *
 * Not a fallback anyone should hit in VS Code. It exists because a session must
 * be able to ask wherever it runs, and because losing the ability to ask is
 * worse than asking badly: the settings these serve can only refuse when there
 * is nobody to put the question to.
 */
export async function putToUserModally(message: string, options: string[]): Promise<UserChoice> {
	const answer = await HostProvider.window.showMessage({
		type: ShowMessageType.INFORMATION,
		message,
		options: { modal: true, items: options },
	})
	return answer.selectedOption ? { picked: answer.selectedOption } : {}
}

/**
 * Narrow a tool executor's `askQuestion` down to the two arguments a decision
 * needs.
 *
 * The executor's third argument describes the tool call that asked, and these
 * questions have no tool behind them -- the change protocol and the escalation
 * ask them directly. The handler behind it (`handleAskQuestion`) ignores that
 * argument, and has since it was written.
 */
export function asChatAsker(
	askQuestion: ((question: string, options: string[], context: never) => Promise<string>) | undefined,
): AskUser | undefined {
	if (!askQuestion) {
		return undefined
	}
	return (question, options) => askQuestion(question, options, undefined as never)
}
