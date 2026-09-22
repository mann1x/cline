import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ write: vi.fn(), config: { parallelSessions: 1 } as Record<string, unknown> | undefined }))

vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({ config: mocks.config, write: mocks.write }),
}))
vi.mock("@/services/grpc-client", () => ({ ModelsServiceClient: { readOpencotiEngine: vi.fn() } }))
// `DebouncedTextField` is half of what is under test, so the toolkit field it
// wraps is a real input here rather than a mock of the whole thing.
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeTextField: ({
		children,
		onBlur,
		onInput,
		onKeyDown,
		value,
	}: {
		children?: ReactNode
		onBlur?: () => void
		onInput?: (event: { target: { value: string } }) => void
		onKeyDown?: (event: { key: string }) => void
		value?: string
	}) => (
		<label>
			{children}
			<input
				onBlur={() => onBlur?.()}
				onChange={(event) => onInput?.({ target: { value: event.target.value } })}
				onKeyDown={(event) => onKeyDown?.({ key: event.key })}
				value={value ?? ""}
			/>
		</label>
	),
}))

import { ParallelSessionsField } from "./ParallelSessionsField"

/**
 * Reported on pandorum 2026-09-22: "Left empty does not propose me to save the
 * profile". The profile bar reports itself dirty by comparing the panel
 * against the loaded profile, and the panel's half of that comparison is the
 * stored provider config -- so a clear that never reaches providers.json is
 * also a clear the Update button cannot see. Both halves of the report are one
 * write.
 *
 * The field's copy was tested; what it does with a keystroke never was.
 */
describe("clearing the field", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.config = { parallelSessions: 1 }
		mocks.write.mockResolvedValue(undefined)
	})

	function field() {
		render(<ParallelSessionsField providerId="opencoti" />)
		return screen.getByLabelText("Parallel Sessions") as HTMLInputElement
	}

	it("writes the clear when the field is emptied", async () => {
		const input = field()
		expect(input.value).toBe("1")

		fireEvent.change(input, { target: { value: "" } })
		fireEvent.blur(input)

		// Zero is the documented unset spelling: the store deletes the key
		// rather than storing a number that means "none".
		await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({ parallelSessions: 0 }))
	})

	it("writes a typed number", async () => {
		const input = field()
		fireEvent.change(input, { target: { value: "4" } })
		fireEvent.blur(input)

		await waitFor(() => expect(mocks.write).toHaveBeenCalledWith({ parallelSessions: 4 }))
	})

	// The clear must not be repeated on a field that is already clear, or every
	// visit to the panel writes providers.json.
	it("writes nothing when an already-empty field is left alone", async () => {
		mocks.config = {}
		const input = field()
		fireEvent.change(input, { target: { value: "" } })
		fireEvent.blur(input)

		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(mocks.write).not.toHaveBeenCalled()
	})
})
