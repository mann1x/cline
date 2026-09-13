import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { JumpToPresent } from "./JumpToPresent"

describe("the jump-to-present control", () => {
	it("stays out of the way while the list is already following", () => {
		render(<JumpToPresent isVisible={false} onJump={vi.fn()} />)

		expect(screen.queryByRole("button")).toBeNull()
	})

	it("appears once the reader has scrolled away from the newest message", () => {
		render(<JumpToPresent isVisible={true} onJump={vi.fn()} />)

		expect(screen.getByRole("button")).toBeTruthy()
	})

	it("jumps on click", () => {
		const onJump = vi.fn()
		render(<JumpToPresent isVisible={true} onJump={onJump} />)

		fireEvent.click(screen.getByRole("button"))

		expect(onJump).toHaveBeenCalledTimes(1)
	})

	// It is a div with role="button", so the keyboard activation browsers give a
	// real <button> for free has to be written out, and is worth pinning.
	it.each(["Enter", " "])("jumps on %s", (key) => {
		const onJump = vi.fn()
		render(<JumpToPresent isVisible={true} onJump={onJump} />)

		fireEvent.keyDown(screen.getByRole("button"), { key })

		expect(onJump).toHaveBeenCalledTimes(1)
	})

	it("ignores keys that are not activation keys", () => {
		const onJump = vi.fn()
		render(<JumpToPresent isVisible={true} onJump={onJump} />)

		fireEvent.keyDown(screen.getByRole("button"), { key: "ArrowDown" })

		expect(onJump).not.toHaveBeenCalled()
	})

	it("says what it does, for a reader who cannot see it", () => {
		render(<JumpToPresent isVisible={true} onJump={vi.fn()} />)

		expect(screen.getByRole("button").getAttribute("aria-label")).toBe("Jump to the newest message and resume following")
	})
})
