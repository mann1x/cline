import { describeOptionRanking, type JevEndpoint, rankQuestionOptions } from "@cline/core"
import type { ClineMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import { readJevEndpoint, readJevSettings } from "./jev-config"

/** How much of the conversation Jev is shown, from the end. */
const CONVERSATION_CHARS = 10_000
/** Assistant replies kept, newest last: the question is about the latest one. */
const ASSISTANT_TURNS = 3
/** The longest a question waits for its scores before going out without them. */
const QUESTION_TIMEOUT_MS = 6_000

/**
 * The conversation as Jev reads it: what the user said, and the model's last
 * few replies.
 *
 * Deliberately not the transcript. Tool output is most of a transcript, it is
 * the part text in the repository can steer, and the documentation measured
 * irrelevant state lowering accuracy. What decides which option a user wants is
 * what that user has said.
 */
export function conversationForJev(messages: readonly ClineMessage[]): string {
	const lines: string[] = []
	const assistantAt: number[] = []
	for (const message of messages) {
		if (message.type !== "say" || !message.text?.trim()) {
			continue
		}
		if (message.say === "task" || message.say === "user_feedback") {
			lines.push(`user: ${message.text.trim()}`)
		} else if (message.say === "text" && !message.partial) {
			assistantAt.push(lines.length)
			lines.push(`assistant: ${message.text.trim()}`)
		}
	}
	// Older assistant replies drop out; every user line stays.
	const keep = new Set(assistantAt.slice(-ASSISTANT_TURNS))
	const kept = lines.filter((line, index) => !line.startsWith("assistant: ") || keep.has(index))
	const text = kept.join("\n\n")
	return text.length > CONVERSATION_CHARS ? `… ${text.slice(-CONVERSATION_CHARS)}` : text
}

export interface RankedQuestion {
	question: string
	options: string[]
}

/**
 * A model-authored question, with Jev's reading of its options applied.
 *
 * Runs only on the model's own `ask_question`: escalation and check approvals
 * reach the user through the same asker, and "Hand it over" is not an option
 * Jev should be recommending or dropping. Any failure -- not configured,
 * switched off, a timeout, a refused key -- leaves the question as the model
 * wrote it, because a question the user never sees is worse than one without
 * scores.
 */
export async function rankQuestionWithJev(
	question: string,
	options: readonly string[],
	messages: readonly ClineMessage[],
	endpoint: JevEndpoint | undefined = readJevEndpoint(),
): Promise<RankedQuestion> {
	const unchanged = { question, options: [...options] }
	if (!endpoint || options.length < 2 || !readJevSettings().rankQuestions) {
		return unchanged
	}
	try {
		// The user is waiting for this question; a slow Jev costs it its scores
		// sooner than the tool's own timeout would.
		const bounded = { ...endpoint, timeoutMs: Math.min(endpoint.timeoutMs ?? QUESTION_TIMEOUT_MS, QUESTION_TIMEOUT_MS) }
		const ranked = await rankQuestionOptions(bounded, {
			conversation: conversationForJev(messages),
			question,
			options,
		})
		return {
			question: `${question}\n\n${describeOptionRanking(ranked)}`,
			options: ranked.options,
		}
	} catch (error) {
		Logger.warn(`[Jev] The question's options could not be ranked: ${error instanceof Error ? error.message : String(error)}`)
		return unchanged
	}
}
