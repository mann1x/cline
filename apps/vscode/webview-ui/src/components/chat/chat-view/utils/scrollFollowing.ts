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
