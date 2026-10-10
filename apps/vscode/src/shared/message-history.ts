/**
 * The message box's history and unsent draft.
 *
 * Kept by the extension, not the webview: a webview's own storage does not
 * survive every way a window can close, and the history is the user's, not
 * one window's. Nothing is kept while the setting is off, and switching it
 * off deletes what was kept.
 */

export const DEFAULT_MESSAGE_HISTORY_LIMIT = 50
export const MAX_MESSAGE_HISTORY_LIMIT = 500

/** A pasted log is not something to cycle back to, or to write on every keystroke. */
export const MAX_MESSAGE_HISTORY_ENTRY_CHARS = 20_000

export type MessageHistoryAction = { op: "load" } | { op: "draft"; text: string } | { op: "push"; text: string }

export interface MessageHistorySnapshot {
	enabled: boolean
	limit: number
	/** Oldest first. */
	history: string[]
	draft: string
}

export function clampMessageHistoryLimit(value: unknown): number {
	const limit = Math.floor(Number(value))
	if (!Number.isFinite(limit) || limit < 1) {
		return DEFAULT_MESSAGE_HISTORY_LIMIT
	}
	return Math.min(limit, MAX_MESSAGE_HISTORY_LIMIT)
}

/**
 * The history with one more message sent. A message already in it moves to
 * the end rather than appearing twice: cycling past five copies of "continue"
 * to reach the message before them is the list working against its purpose.
 */
export function pushMessageHistory(history: readonly string[], text: string, limit: number): string[] {
	const entry = text.trim()
	const kept = history.filter((item) => typeof item === "string" && item.length > 0)
	if (!entry || entry.length > MAX_MESSAGE_HISTORY_ENTRY_CHARS) {
		return kept.slice(-limit)
	}
	return [...kept.filter((item) => item !== entry), entry].slice(-limit)
}

/** Where a walk through the history stands: `index` into it, and what was typed before the walk began. */
export interface MessageHistoryCursor {
	index: number
	stash: string
}

/**
 * One step through the history. Up from the box goes to the newest message
 * and keeps what was typed; down past the newest gives it back. `cursor` is
 * undefined while the box holds the user's own text.
 */
export function stepMessageHistory(
	history: readonly string[],
	cursor: MessageHistoryCursor | undefined,
	direction: "up" | "down",
	current: string,
): { cursor: MessageHistoryCursor | undefined; text: string } | undefined {
	if (history.length === 0) {
		return undefined
	}
	if (!cursor) {
		if (direction === "down") {
			return undefined
		}
		const index = history.length - 1
		return { cursor: { index, stash: current }, text: history[index] as string }
	}
	if (direction === "up") {
		const index = Math.max(0, Math.min(cursor.index, history.length) - 1)
		return { cursor: { index, stash: cursor.stash }, text: history[index] as string }
	}
	const index = cursor.index + 1
	if (index >= history.length) {
		return { cursor: undefined, text: cursor.stash }
	}
	return { cursor: { index, stash: cursor.stash }, text: history[index] as string }
}
