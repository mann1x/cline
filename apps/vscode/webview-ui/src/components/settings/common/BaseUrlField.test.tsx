import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ChangeEventHandler, ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"
import { BaseUrlField } from "./BaseUrlField"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({
		checked,
		children,
		disabled,
		onChange,
	}: {
		checked?: boolean
		children?: ReactNode
		disabled?: boolean
		onChange?: ChangeEventHandler<HTMLInputElement>
	}) => (
		<label>
			<input checked={checked} disabled={disabled} onChange={onChange} type="checkbox" />
			{children}
		</label>
	),
	VSCodeTextField: ({
		onInput,
		placeholder,
		value,
	}: {
		onInput?: ChangeEventHandler<HTMLInputElement>
		placeholder?: string
		value?: string
	}) => <input onChange={onInput} placeholder={placeholder} value={value} />,
}))

async function flushDebounce() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 150))
	})
}

describe("BaseUrlField", () => {
	it("checks the box and shows the URL once the saved value loads asynchronously", () => {
		// Provider config is fetched after mount, so the saved base URL
		// arrives as an initialValue update rather than at first render.
		const onChange = vi.fn()
		const { rerender } = render(<BaseUrlField initialValue={undefined} onChange={onChange} />)

		expect(screen.getByRole("checkbox")).not.toBeChecked()

		rerender(<BaseUrlField initialValue="https://proxy.example.com" onChange={onChange} />)

		expect(screen.getByRole("checkbox")).toBeChecked()
		expect(screen.getByRole("textbox")).toHaveValue("https://proxy.example.com")
		expect(onChange).not.toHaveBeenCalled()
	})

	it("stays unchecked after the user unchecks it, even if a stale value echoes back", () => {
		const onChange = vi.fn()
		const { rerender } = render(<BaseUrlField initialValue="https://proxy.example.com" onChange={onChange} />)

		fireEvent.click(screen.getByRole("checkbox"))
		expect(screen.getByRole("checkbox")).not.toBeChecked()
		expect(onChange).toHaveBeenCalledWith("")

		// A stale echo of the old config must not re-check the box.
		rerender(<BaseUrlField initialValue="https://proxy.example.com" onChange={onChange} />)
		expect(screen.getByRole("checkbox")).not.toBeChecked()
	})

	it("restores the checked state when clearing the persisted URL fails", async () => {
		const onChange = vi.fn()
		const onClear = vi.fn().mockRejectedValue(new Error("write failed"))
		render(<BaseUrlField initialValue="https://proxy.example.com" onChange={onChange} onClear={onClear} />)

		fireEvent.click(screen.getByRole("checkbox"))
		expect(screen.getByRole("checkbox")).not.toBeChecked()

		await act(async () => {})
		expect(onClear).toHaveBeenCalledTimes(1)
		expect(onChange).not.toHaveBeenCalled()
		expect(screen.getByRole("checkbox")).toBeChecked()
		expect(screen.getByRole("textbox")).toHaveValue("https://proxy.example.com")
	})

	it("clears the hidden input value after persistence succeeds", async () => {
		const onChange = vi.fn()
		const onClear = vi.fn().mockResolvedValue(undefined)
		const { rerender } = render(
			<BaseUrlField initialValue="https://proxy.example.com" onChange={onChange} onClear={onClear} />,
		)

		fireEvent.click(screen.getByRole("checkbox"))
		await act(async () => {})
		rerender(<BaseUrlField initialValue={undefined} onChange={onChange} onClear={onClear} />)
		fireEvent.click(screen.getByRole("checkbox"))

		expect(screen.getByRole("textbox")).toHaveValue("")
		expect(onChange).not.toHaveBeenCalled()
	})

	it("cancels a pending URL edit before clearing", async () => {
		const onChange = vi.fn()
		let resolveClear: () => void = () => {}
		const onClear = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveClear = resolve
				}),
		)
		const { unmount } = render(
			<BaseUrlField initialValue="https://saved.example.com" onChange={onChange} onClear={onClear} />,
		)

		fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://pending.example.com" } })
		fireEvent.click(screen.getByRole("checkbox"))
		await flushDebounce()
		unmount()

		expect(onClear).toHaveBeenCalledTimes(1)
		expect(onChange).not.toHaveBeenCalled()

		await act(async () => resolveClear())
	})

	it("saves the trimmed URL after typing", async () => {
		const onChange = vi.fn()
		render(<BaseUrlField initialValue={undefined} onChange={onChange} />)

		fireEvent.click(screen.getByRole("checkbox"))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "https://proxy.example.com " } })

		await flushDebounce()
		expect(onChange).toHaveBeenLastCalledWith("https://proxy.example.com")
	})
})

describe("enabling the field on a tab that has no saved URL yet", () => {
	// The reported sequence (user, 2026-09-13): "I enable custom url but then i
	// cannot paste in the textbox for the url. the custom url sometimes gets
	// disabled." The scoped tabs persist through a settings string that arrives
	// back as a prop a round trip later, so between the paste and the echo the
	// parent re-renders with the value still absent.
	it("keeps a pasted URL while the write is still in flight", async () => {
		const onChange = vi.fn()
		const { rerender } = render(<BaseUrlField initialValue={undefined} onChange={onChange} />)

		fireEvent.click(screen.getByRole("checkbox"))
		const field = screen.getByRole("textbox")
		fireEvent.change(field, { target: { value: "http://192.168.178.161:11434" } })

		// The parent re-renders before the write has landed: same absent value.
		rerender(<BaseUrlField initialValue={undefined} onChange={onChange} />)
		expect(screen.getByRole("textbox")).toHaveValue("http://192.168.178.161:11434")
		expect(screen.getByRole("checkbox")).toBeChecked()

		await flushDebounce()
		expect(onChange).toHaveBeenCalledWith("http://192.168.178.161:11434")

		// And once it echoes back.
		rerender(<BaseUrlField initialValue="http://192.168.178.161:11434" onChange={onChange} />)
		expect(screen.getByRole("textbox")).toHaveValue("http://192.168.178.161:11434")
		expect(screen.getByRole("checkbox")).toBeChecked()
	})

	it("does not lose a second paste made before the first has echoed back", async () => {
		const onChange = vi.fn()
		const { rerender } = render(<BaseUrlField initialValue={undefined} onChange={onChange} />)

		fireEvent.click(screen.getByRole("checkbox"))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "http://first:11434" } })
		await flushDebounce()

		fireEvent.change(screen.getByRole("textbox"), { target: { value: "http://second:11434" } })
		// The first write's echo arrives while the second edit is pending.
		rerender(<BaseUrlField initialValue="http://first:11434" onChange={onChange} />)

		expect(screen.getByRole("textbox")).toHaveValue("http://second:11434")
	})

	// The checkbox is derived state, and a remount recomputes it from the prop.
	// If the tab unmounts mid-edit -- which is what unticking a "Use a different
	// model for ..." toggle rendered under the tab would do -- the field comes
	// back unchecked and empty, which is what "sometimes gets disabled" looks
	// like from the outside.
	it("comes back unchecked when remounted before the URL was saved", () => {
		const onChange = vi.fn()
		const { unmount } = render(<BaseUrlField initialValue={undefined} onChange={onChange} />)
		fireEvent.click(screen.getByRole("checkbox"))
		expect(screen.getByRole("checkbox")).toBeChecked()
		unmount()

		render(<BaseUrlField initialValue={undefined} onChange={onChange} />)
		expect(screen.getByRole("checkbox")).not.toBeChecked()
	})
})
