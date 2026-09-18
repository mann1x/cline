import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OutputBudgetField } from "./OutputBudgetField"

type Config = { outputBudget?: Record<string, unknown>; contextWindow?: number }

const mocks = vi.hoisted(() => ({ write: vi.fn(), config: { current: {} as Config } }))

vi.mock("@/hooks/useProviderConfig", async () => {
	const { useCallback, useState } = await import("react")
	return {
		useProviderConfig: () => {
			const [config, setConfig] = useState<Config>(mocks.config.current)
			const write = useCallback(async (patch: Config) => {
				mocks.write(patch)
				// The host round trip: the panel does not see its own write until
				// the answer comes back, which is the window this file is about.
				await Promise.resolve()
				setConfig((previous) => ({ ...previous, ...patch }))
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
vi.mock("./DebouncedTextField", () => ({
	DebouncedTextField: ({ initialValue, onChange }: { initialValue: string; onChange: (value: string) => void }) => (
		<input defaultValue={initialValue} onChange={(event) => onChange(event.target.value)} />
	),
}))

describe("the output budget field", () => {
	beforeEach(() => {
		mocks.write.mockReset()
		mocks.write.mockResolvedValue(undefined)
		mocks.config.current = { contextWindow: 128000, outputBudget: { mode: "manual", maxTokens: 96000 } }
	})

	it("keeps the stored cap when only the mode changes", async () => {
		render(<OutputBudgetField providerId="opencoti" />)

		fireEvent.click(screen.getByTestId("output-budget-auto"))
		await act(async () => {})

		expect(mocks.write).toHaveBeenLastCalledWith({ outputBudget: { mode: "auto", maxTokens: 96000 } })
	})

	// Same fault as the PolyKV section: the section is written whole, and both
	// controls compose it from the render they were created in. A cap typed
	// straight after flipping the mode put the mode back.
	it("keeps the mode change when the cap is typed before the write lands", () => {
		render(<OutputBudgetField providerId="opencoti" />)

		fireEvent.click(screen.getByTestId("output-budget-auto"))
		fireEvent.change(screen.getByRole("textbox"), { target: { value: "64000" } })

		expect(mocks.write).toHaveBeenLastCalledWith({ outputBudget: { mode: "auto", maxTokens: 64000 } })
	})
})
