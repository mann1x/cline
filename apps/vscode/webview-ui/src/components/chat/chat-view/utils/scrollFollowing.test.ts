import { describe, expect, it } from "vitest"
import { AT_BOTTOM_THRESHOLD_PX, distanceFromBottom, shouldStopFollowing } from "./scrollFollowing"

const at = (scrollTop: number, scrollHeight = 10_000, clientHeight = 800) => ({
	scrollTop,
	scrollHeight,
	clientHeight,
})

describe("shouldStopFollowing", () => {
	it("stops when the reader drags the thumb up", () => {
		// The reported bug: a drag produces scroll events and no wheel, so the
		// wheel-only listener never stopped tailing and the view snapped back.
		expect(shouldStopFollowing(at(9_200), at(4_000))).toBe(true)
	})

	it("does not stop while the list grows underneath a pinned view", () => {
		// Streaming appends content: scrollHeight rises, scrollTop does not move.
		const before = at(9_200, 10_000)
		const after = at(9_200, 12_000)
		expect(shouldStopFollowing(before, after)).toBe(false)
	})

	it("does not stop when our own scroll takes the view down", () => {
		expect(shouldStopFollowing(at(4_000), at(9_200))).toBe(false)
	})

	it("does not stop when a compaction shrinks the document under a pinned view", () => {
		// Messages are removed, so scrollTop drops — but the view is still at the
		// bottom, which is what separates this from a reader scrolling away.
		const before = at(9_200, 10_000)
		const after = at(3_200, 4_000)
		expect(distanceFromBottom(after)).toBe(0)
		expect(shouldStopFollowing(before, after)).toBe(false)
	})

	it("ignores a nudge that stays within the bottom threshold", () => {
		const before = at(9_200, 10_000)
		const after = at(9_180, 10_000)
		expect(distanceFromBottom(after)).toBeLessThanOrEqual(AT_BOTTOM_THRESHOLD_PX)
		expect(shouldStopFollowing(before, after)).toBe(false)
	})

	it("has nothing to say about the first scroll it sees", () => {
		expect(shouldStopFollowing(undefined, at(0))).toBe(false)
	})
})
