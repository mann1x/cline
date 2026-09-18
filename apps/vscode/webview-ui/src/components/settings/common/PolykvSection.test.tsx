import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PolykvSection } from "./PolykvSection"

type Config = { polykv?: Record<string, unknown> }

const mocks = vi.hoisted(() => ({ write: vi.fn(), config: { current: {} as Config } }))

// The store's own merge rules behind the hook: the section is written whole,
// and a value of `false` is exactly what a section written whole must keep.
vi.mock("@/hooks/useProviderConfig", async () => {
	const { useCallback, useState } = await import("react")
	return {
		useProviderConfig: () => {
			const [config, setConfig] = useState<Config>(mocks.config.current)
			const write = useCallback(async (patch: Config) => {
				mocks.write(patch)
				// The host round trip, which is the whole point: the panel does
				// not see its own write until the answer comes back, so anything
				// the user touches in between is composed from the old section.
				await Promise.resolve()
				setConfig((previous) => ({ ...previous, ...(patch.polykv !== undefined ? { polykv: patch.polykv } : {}) }))
			}, [])
			return { config, write }
		},
	}
})

vi.mock("@/components/ui/label", () => ({ Label: ({ children }: { children?: ReactNode }) => <span>{children}</span> }))
vi.mock("@/components/ui/switch", () => ({
	Switch: ({ checked, onCheckedChange, id }: { checked?: boolean; onCheckedChange?: (v: boolean) => void; id?: string }) => (
		<input
			checked={checked ?? false}
			data-testid={id}
			onChange={(event) => onCheckedChange?.(event.target.checked)}
			type="checkbox"
		/>
	),
}))
// Close enough to the real one for this file's purpose: it reports what was
// typed, and the field under test is what the panel does with that string.
vi.mock("./DebouncedTextField", () => ({
	DebouncedTextField: ({ initialValue, onChange }: { initialValue: string; onChange: (value: string) => void }) => (
		<input defaultValue={initialValue} onChange={(event) => onChange(event.target.value)} />
	),
}))
vi.mock("./PolykvStatusStrip", () => ({ PolykvStatusStrip: () => <div /> }))

describe("the PolyKV section", () => {
	beforeEach(() => {
		mocks.write.mockReset()
		mocks.write.mockResolvedValue(undefined)
		mocks.config.current = { polykv: { enabled: true } }
	})

	// Reported: "I had disabled polykv and now I found it was enabled ... it
	// does not get saved."
	it("writes the switch turned off", () => {
		render(<PolykvSection providerId="opencoti" />)
		const toggle = screen.getByTestId("polykv-enabled") as HTMLInputElement
		expect(toggle.checked).toBe(true)

		fireEvent.click(toggle)

		expect(mocks.write).toHaveBeenCalledWith({ polykv: { enabled: false } })
	})

	it("shows the switch off after the write comes back", async () => {
		render(<PolykvSection providerId="opencoti" />)
		const toggle = screen.getByTestId("polykv-enabled") as HTMLInputElement
		fireEvent.click(toggle)
		await act(async () => {})

		expect((screen.getByTestId("polykv-enabled") as HTMLInputElement).checked).toBe(false)
	})

	// The write is whole-section, so it is only ever as correct as the section
	// it was composed from. Two controls touched before the first answer comes
	// back both compose from the config of the render they were created in, and
	// the second write puts the first one's field back to where it started.
	// That is what a switch that will not stay off looks like from the chair.
	it("keeps an earlier change when a second control is touched before the write lands", () => {
		render(<PolykvSection providerId="opencoti" />)

		fireEvent.click(screen.getByTestId("polykv-pinPrefix"))
		fireEvent.click(screen.getByTestId("polykv-overcommit"))

		expect(mocks.write).toHaveBeenLastCalledWith({ polykv: { enabled: true, pinPrefix: false, overcommit: true } })
	})

	// `Number("")` is 0, so an emptied field was stored as a configured zero
	// rather than removed -- and zero is a real setting for three of these.
	it("removes a number field that was cleared instead of storing zero", () => {
		mocks.config.current = { polykv: { enabled: true, compactionPressureThreshold: 0.9 } }
		render(<PolykvSection providerId="opencoti" />)
		const field = screen.getAllByRole("textbox")[0] as HTMLInputElement

		fireEvent.change(field, { target: { value: "" } })

		expect(mocks.write).toHaveBeenLastCalledWith({ polykv: { enabled: true, compactionPressureThreshold: undefined } })
	})

	// A section that already carries other values must keep them: the panel
	// sends the whole section, so a dropped sibling is a silently reset knob.
	it("keeps the rest of the section when the switch changes", () => {
		mocks.config.current = { polykv: { enabled: true, settleTokens: 48 } }
		render(<PolykvSection providerId="opencoti" />)

		fireEvent.click(screen.getByTestId("polykv-enabled"))

		expect(mocks.write).toHaveBeenCalledWith({ polykv: { enabled: false, settleTokens: 48 } })
	})
})
