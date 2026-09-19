import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LoadDefaultPromptButton } from "./LoadDefaultPromptButton"

// `VSCodeButton` renders a `vscode-button` custom element, which jsdom does not
// give an implicit role, so these are found by their text the way every other
// spec in this directory finds a toolkit control.
function click(text: string | RegExp): void {
	fireEvent.click(screen.getByText(text))
}

describe("loading a built-in prompt into the box", () => {
	const onLoad = vi.fn()
	beforeEach(() => {
		onLoad.mockClear()
	})

	it("loads straight away when the box is empty", () => {
		render(<LoadDefaultPromptButton currentValue="" defaultValue="BUILT-IN" label="Compaction" onLoad={onLoad} />)
		click(/load default/i)
		expect(onLoad).toHaveBeenCalledWith("BUILT-IN")
	})

	it("treats whitespace as empty", () => {
		render(<LoadDefaultPromptButton currentValue={"  \n\t "} defaultValue="BUILT-IN" label="Compaction" onLoad={onLoad} />)
		click(/load default/i)
		expect(onLoad).toHaveBeenCalledWith("BUILT-IN")
	})

	// The whole point of the button: a custom prompt is work, and one click
	// away from being gone is not far enough away.
	it("asks before it overwrites a custom prompt", () => {
		render(
			<LoadDefaultPromptButton currentValue="my own prompt" defaultValue="BUILT-IN" label="Compaction" onLoad={onLoad} />,
		)
		click(/load default/i)
		expect(onLoad).not.toHaveBeenCalled()
		expect(screen.getByText(/it is not kept anywhere/i)).toBeTruthy()

		click(/^Replace$/)
		expect(onLoad).toHaveBeenCalledWith("BUILT-IN")
	})

	it("lets the warning be dismissed without writing anything", () => {
		render(
			<LoadDefaultPromptButton currentValue="my own prompt" defaultValue="BUILT-IN" label="Compaction" onLoad={onLoad} />,
		)
		click(/load default/i)
		click(/keep mine/i)
		expect(onLoad).not.toHaveBeenCalled()
		expect(screen.queryByText(/^Replace$/)).toBeNull()
	})

	// A default that has not arrived yet is not a default. Offering the button
	// anyway writes an empty string over the user's prompt.
	it("offers nothing when there is no default to load", () => {
		const { container } = render(
			<LoadDefaultPromptButton currentValue="mine" defaultValue={undefined} label="Compaction" onLoad={onLoad} />,
		)
		expect(container.textContent).toBe("")
	})
})
