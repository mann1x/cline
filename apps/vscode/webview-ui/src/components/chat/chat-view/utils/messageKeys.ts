import type { ClineMessage } from "@shared/ExtensionMessage"

/**
 * A stable key per rendered row.
 *
 * Virtuoso keys its items by index unless it is given `computeItemKey`, and an
 * index is not an identity: the row that held one message holds a different one
 * as soon as anything is inserted above it, or a group grows, or the waiting
 * placeholder is swapped for a real row. React then reuses that row's component
 * instance for a message it knows nothing about, and the instance brings its
 * hooks and its state with it.
 *
 * That is how 4.100.145 lost the whole panel: `ChatRowContent` returns early for
 * a tool message and runs on for a command one, two `useEffect`s sat below those
 * returns, and one instance rendering a tool row and then a command row called a
 * different number of hooks on consecutive renders -- React #310. The hooks were
 * moved above the returns, which is the fix for the crash; keying the rows is
 * the fix for the reuse itself, and for the quieter half of it, where output
 * expansion, the quote button and the auto-expand refs carry across to whatever
 * message arrives next.
 *
 * `ts` is the identity. It is `Date.now()` at the moment the message was made,
 * so a collision is rare rather than impossible, and a duplicate key is a broken
 * list rather than a cosmetic warning -- repeats are therefore numbered by the
 * order they appear in. A row with no timestamp at all (an empty group) falls
 * back to its position, in a namespace of its own so it cannot collide with a
 * real one.
 */
export function computeMessageRowKeys(rows: (ClineMessage | ClineMessage[])[]): string[] {
	const seen = new Map<number, number>()

	return rows.map((row, index) => {
		const message = Array.isArray(row) ? row[0] : row
		const ts = message?.ts

		if (typeof ts !== "number") {
			return `row:${index}`
		}

		const occurrence = seen.get(ts) ?? 0
		seen.set(ts, occurrence + 1)
		return occurrence === 0 ? `ts:${ts}` : `ts:${ts}:${occurrence}`
	})
}
