/**
 * Whether a scroll the user just made should stop the chat tailing.
 *
 * Only `wheel` used to do this, and only with a negative `deltaY`. Dragging the
 * scrollbar thumb, clicking its track, and anything else that moves the view
 * without turning a wheel produce `scroll` events and no wheel at all — so
 * following was never stopped and the next pin yanked the reader back to the
 * bottom, during a run and after it had finished. Reported 2026-09-21: "when I
 * move it it always goes back to the bottom … mouse wheel and pgup/pgdn works
 * fine", which is exactly the shape of a wheel-only listener.
 *
 * Both halves are required, and each rules out one thing that is not a reader
 * scrolling away:
 *
 *   - **moved up** — content appended below during streaming grows
 *     `scrollHeight` without moving `scrollTop`, so a growing list never
 *     satisfies this. Our own scroll-to-bottom only ever moves down.
 *   - **and away from the bottom** — a compaction removes messages, which can
 *     drop `scrollTop` while the view stays pinned. That is a shrinking
 *     document, not a reader, and it leaves the distance from the bottom
 *     unchanged.
 */
export interface ScrollPosition {
	scrollTop: number
	scrollHeight: number
	clientHeight: number
}

/** Matches Virtuoso's `atBottomThreshold`, so both agree on what "at the bottom" means. */
export const AT_BOTTOM_THRESHOLD_PX = 64

export function distanceFromBottom(position: ScrollPosition): number {
	return Math.max(0, position.scrollHeight - position.scrollTop - position.clientHeight)
}

export function shouldStopFollowing(
	previous: ScrollPosition | undefined,
	next: ScrollPosition,
	threshold = AT_BOTTOM_THRESHOLD_PX,
): boolean {
	if (!previous) {
		return false
	}
	const movedUp = next.scrollTop < previous.scrollTop
	return movedUp && distanceFromBottom(next) > threshold
}

/**
 * Whether the reader is the one moving the view right now.
 *
 * `shouldStopFollowing` reads positions, and positions cannot say who moved
 * them. Reported 2026-10-05 against 4.100.239: on one monitor and not on
 * another of the same machine, tailing stopped at the end of a turn with
 * nobody touching anything, and "Jump to present" had to be clicked every
 * time. The scroll handler was the only path to `stopFollowing` that needs no
 * reader, so the view had been moved up by something else.
 *
 * The likely mover is the list library, not confirmed on the affected
 * monitor: when a row's height changes within 50ms of an upward move, and the
 * first row is not rendered, Virtuoso assumes the change was above the
 * viewport and scrolls by the difference ("upward scrolling compensation").
 * That depends on frame timing, which a monitor changes. The handler logs
 * each unattended move to the webview console, so the next report can say.
 *
 * So a scroll only stops tailing when there is a hand on it: a pointer held
 * on the scroller (dragging the thumb, holding the track), or a wheel, a
 * scrolling key or a touch within the last moments.
 */
export const READER_SCROLL_WINDOW_MS = 1000

const SCROLL_KEYS = new Set(["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End", " ", "Spacebar"])

export function isScrollKey(key: string): boolean {
	return SCROLL_KEYS.has(key)
}

export interface ReaderScrollIntent {
	/** A pointer is down on the scroller and has not been released. */
	pointerHeld: boolean
	/** When the reader last did something that scrolls, in `Date.now()` time. */
	lastInputAt: number
}

export function readerIsScrolling(intent: ReaderScrollIntent, now: number, windowMs = READER_SCROLL_WINDOW_MS): boolean {
	return intent.pointerHeld || now - intent.lastInputAt <= windowMs
}
