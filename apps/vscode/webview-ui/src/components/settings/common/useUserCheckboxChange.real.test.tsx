import { act, render } from "@testing-library/react"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { useUserCheckboxChange } from "./useUserCheckboxChange"

/**
 * The real toolkit checkbox, not a stand-in: the hook exists because of how
 * this element behaves, so a mock of it can only restate the assumption.
 */
const writes = vi.fn()
let setShown: (value: boolean) => void = () => {}

function Panel() {
	const [shown, set] = useState(false)
	setShown = set
	const onChange = useUserCheckboxChange(shown, (checked) => {
		writes(checked)
		set(checked)
	})
	return (
		<VSCodeCheckbox checked={shown} data-testid="box" onChange={onChange}>
			Enable thinking
		</VSCodeCheckbox>
	)
}

describe("the thinking checkbox on the real toolkit element", () => {
	it("stores a click and ignores the panel's own update", async () => {
		const { getByTestId } = render(<Panel />)
		const box = getByTestId("box") as HTMLElement & { checked: boolean }
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0))
		})

		await act(async () => {
			box.click()
		})
		expect(writes.mock.calls).toEqual([[true]])
		expect(box.checked).toBe(true)

		// The panel unticks it, as a profile load does.
		await act(async () => {
			setShown(false)
		})
		expect(box.checked).toBe(false)
		expect(writes.mock.calls).toEqual([[true]])

		await act(async () => {
			box.click()
		})
		expect(writes.mock.calls).toEqual([[true], [true]])
	})
})
