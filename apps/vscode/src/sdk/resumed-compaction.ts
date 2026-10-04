import { createSessionCompactionState, projectSessionCompactionState, type SessionCompactionState } from "@cline/core"

type Messages = Parameters<typeof projectSessionCompactionState>[1]

/**
 * A session's saved compaction, carried across a rebuild that reshapes its
 * transcript.
 *
 * The compaction is saved against the transcript as stored: a hash of its
 * first N messages. Every rebuild of a session (a resume, a mode or provider
 * switch) passes the transcript through the tool-pairing sanitizer first, and
 * the sanitizer folds the separate user messages of a parallel tool batch
 * into one. The count and the hash then match nothing, core drops the
 * compaction without a word, and the first request carries the whole
 * conversation: session wlafh was at 58k tokens before a reload and at 134.5k
 * of a 128k window after it (pandorum, 2026-10-04), with the estimate still
 * reading 74.9k, so nothing compacted either.
 *
 * `rebase` applies the saved compaction to the stored transcript, where it
 * still fits, and states the result against the reshaped one.
 */
export function rebaseCompactionState(input: {
	sessionId: string
	state: SessionCompactionState | undefined
	stored: readonly unknown[]
	reshaped: readonly unknown[]
	reshape: (messages: unknown[]) => unknown[]
}): SessionCompactionState | "fits" | undefined {
	const { state } = input
	if (!state) {
		return undefined
	}
	if (projectSessionCompactionState(state, input.reshaped as Messages) !== undefined) {
		// It still fits as it is: core applies it by itself.
		return "fits"
	}
	const projected = projectSessionCompactionState(state, input.stored as Messages)
	if (!projected) {
		return undefined
	}
	return createSessionCompactionState({
		sourceMessages: input.reshaped as Messages,
		compactedMessages: input.reshape(projected as unknown[]) as Messages,
		conversationId: state.conversation_id ?? input.sessionId,
		...(state.system_prompt !== undefined ? { systemPrompt: state.system_prompt } : {}),
	})
}

const rebased = new Map<string, SessionCompactionState>()

/** Keep a rebased compaction for the session start that follows the load. */
export function stashRebasedCompaction(sessionId: string, state: SessionCompactionState | undefined): void {
	if (state) {
		rebased.set(sessionId, state)
	} else {
		rebased.delete(sessionId)
	}
}

/**
 * The rebased compaction for this start, if it fits the messages the start
 * was given. Taken once: a later start loads its own.
 */
export function takeRebasedCompaction(
	sessionId: string | undefined,
	initialMessages: readonly unknown[] | undefined,
): SessionCompactionState | undefined {
	if (!sessionId) {
		return undefined
	}
	const state = rebased.get(sessionId)
	rebased.delete(sessionId)
	if (!state || !initialMessages) {
		return undefined
	}
	return projectSessionCompactionState(state, initialMessages as Messages) !== undefined ? state : undefined
}
