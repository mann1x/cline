import { act, render } from "@testing-library/react"
import type { MutableRefObject } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useScrollBehavior } from "./useScrollBehavior"

/**
 * Reported 2026-10-05 against 4.100.239: on one monitor the chat stopped
 * tailing by itself on every turn and "Jump to present" had to be clicked,
 * with nobody scrolling. The view had been moved up by the list, not by the
 * reader, and a move up was all the scroll handler looked for.
 */
describe("useScrollBehavior: who moved the view", () => {
	let hook: ReturnType<typeof useScrollBehavior>
	let scroller: HTMLDivElement
	const scrollTo = vi.fn()

	function Harness() {
		hook = useScrollBehavior([], [], [], {}, vi.fn())
		return (
			<div ref={hook.scrollContainerRef}>
				<div data-virtuoso-scroller="true" />
			</div>
		)
	}

	const place = (scrollTop: number, scrollHeight = 10_000, clientHeight = 640) => {
		for (const [name, value] of Object.entries({ scrollTop, scrollHeight, clientHeight })) {
			Object.defineProperty(scroller, name, { configurable: true, value })
		}
		act(() => {
			scroller.dispatchEvent(new Event("scroll"))
		})
	}

	beforeEach(() => {
		vi.useFakeTimers()
		scrollTo.mockClear()
		const { container } = render(<Harness />)
		scroller = container.querySelector('[data-virtuoso-scroller="true"]') as HTMLDivElement
		;(hook.virtuosoRef as MutableRefObject<{ scrollTo: typeof scrollTo } | null>).current = { scrollTo }
		// Pinned at the bottom of a long list, tailing.
		place(9_360)
		scrollTo.mockClear()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("keeps following, and returns to the bottom, when the view moves up with no reader input", () => {
		// The list's own compensation: up by 300px, 300px short of the bottom.
		place(9_060)

		expect(hook.isFollowing).toBe(true)
		expect(hook.disableAutoScrollRef.current).toBe(false)

		act(() => {
			vi.advanceTimersByTime(50)
		})
		expect(scrollTo).toHaveBeenCalledWith({ top: Number.MAX_SAFE_INTEGER, behavior: "auto" })
	})

	it("stops following when the reader drags the scrollbar up", () => {
		act(() => {
			scroller.dispatchEvent(new Event("pointerdown"))
		})
		place(4_000)

		expect(hook.isFollowing).toBe(false)
		expect(hook.disableAutoScrollRef.current).toBe(true)
	})

	it("stops following on a scrolling key, and on what the key is still scrolling a moment later", () => {
		act(() => {
			document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageUp", bubbles: true }))
			vi.advanceTimersByTime(300)
		})
		place(8_700)

		expect(hook.isFollowing).toBe(false)
	})

	it("does not take a key that scrolls nothing for the reader", () => {
		act(() => {
			document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))
		})
		place(9_060)

		expect(hook.isFollowing).toBe(true)
	})

	it("forgets the reader's hand once it has been off the view for a while", () => {
		act(() => {
			scroller.dispatchEvent(new Event("pointerdown"))
			window.dispatchEvent(new Event("pointerup"))
			vi.advanceTimersByTime(5_000)
		})
		place(9_060)

		expect(hook.isFollowing).toBe(true)
	})
})
