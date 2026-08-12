import { act, renderHook } from "@testing-library/react"
import type { MutableRefObject } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useScrollBehavior } from "./useScrollBehavior"

const commandMessage = {
	ts: 1,
	type: "ask",
	ask: "command",
	text: "echo hi",
}

describe("useScrollBehavior", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("scrolls to bottom after command output layout has been quiet for 500ms", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		act(() => {
			vi.runOnlyPendingTimers()
		})
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.handleLastRowContentChange()
		})

		expect(scrollTo).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(499)
		})
		expect(scrollTo).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(scrollTo).toHaveBeenCalledWith({
			top: Number.MAX_SAFE_INTEGER,
			behavior: "smooth",
		})
	})

	it("resets the 500ms wait when another command output change arrives", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		act(() => {
			vi.runOnlyPendingTimers()
		})
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.handleLastRowContentChange()
			scrollTo.mockClear()
			vi.advanceTimersByTime(400)
			result.current.handleLastRowContentChange()
			scrollTo.mockClear()
			vi.advanceTimersByTime(499)
		})
		expect(scrollTo).not.toHaveBeenCalled()

		act(() => {
			vi.advanceTimersByTime(1)
		})
		expect(scrollTo).toHaveBeenCalledWith({
			top: Number.MAX_SAFE_INTEGER,
			behavior: "smooth",
		})
	})

	it("does not re-pin command output changes after auto-scroll is disabled", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.disableAutoScrollRef.current = true
			result.current.handleLastRowContentChange()
			vi.runAllTimers()
		})

		expect(scrollTo).not.toHaveBeenCalled()
	})

	it("disables auto-scroll when a user expands a row", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [commandMessage as any], {}, vi.fn()))

		act(() => {
			result.current.toggleRowExpansion(commandMessage.ts)
		})

		expect(result.current.disableAutoScrollRef.current).toBe(true)
	})

	it("keeps auto-scroll enabled when command output expands programmatically", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [commandMessage as any], {}, vi.fn()))

		act(() => {
			result.current.toggleRowExpansion(commandMessage.ts, { preserveAutoScroll: true })
		})

		expect(result.current.disableAutoScrollRef.current).toBe(false)
	})

	// The reported symptom (#49): scrolling up stops the chat following, and the
	// only way back is to land within ten pixels of the bottom -- which a reader
	// cannot do while a turn is streaming, because each token moves the bottom.
	it("resumes following, not just scrolls, when jumping to present", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.disableAutoScrollRef.current = true
			result.current.jumpToPresent()
		})

		expect(result.current.disableAutoScrollRef.current).toBe(false)
		expect(scrollTo).toHaveBeenCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" })
	})

	// Without the flag cleared, the next appended row reads it and declines to
	// pin, which is the difference between jumping once and following again.
	it("lets later content keep pinning after a jump", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		act(() => {
			vi.runOnlyPendingTimers()
		})
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.disableAutoScrollRef.current = true
			result.current.jumpToPresent()
			scrollTo.mockClear()
			result.current.handleLastRowContentChange()
			vi.advanceTimersByTime(500)
		})

		expect(scrollTo).toHaveBeenCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: "smooth" })
	})

	// The follow-up on #49: the button was keyed on Virtuoso's `isAtBottom`,
	// which starts false before the list has reported anything, so it showed on
	// a chat that was tailing from the first frame.
	it("starts out following", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))

		expect(result.current.isFollowing).toBe(true)
	})

	it("stops following when the reader expands a row", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))

		act(() => {
			result.current.toggleRowExpansion(1)
		})

		expect(result.current.isFollowing).toBe(false)
		expect(result.current.disableAutoScrollRef.current).toBe(true)
	})

	// The state and the ref are read by different halves of the UI -- the button
	// renders from one, every pin path reads the other -- so a transition that
	// moved only one of them would show a button that disagrees with the view.
	it("moves the flag and the follow state together", () => {
		const { result } = renderHook(() => useScrollBehavior([], [], [], {}, vi.fn()))
		const scrollTo = vi.fn()
		;(result.current.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }

		act(() => {
			result.current.stopFollowing()
		})
		expect(result.current.isFollowing).toBe(false)
		expect(result.current.disableAutoScrollRef.current).toBe(true)

		act(() => {
			result.current.jumpToPresent()
		})
		expect(result.current.isFollowing).toBe(true)
		expect(result.current.disableAutoScrollRef.current).toBe(false)
	})
})
