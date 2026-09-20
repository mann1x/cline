import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { minSliderPercent, OutputBudgetField, thinkingFloorTokens } from "./OutputBudgetField"

type Config = {
	outputBudget?: Record<string, unknown>
	contextWindow?: number
	sampling?: { thinkBudget?: string | number; numPredict?: string | number }
	reasoning?: { thinking?: boolean }
}

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

/**
 * The share slider over the automatic budget.
 *
 * The automatic figure is deliberately generous — three quarters of the window,
 * capped at 512,000 — because its job is to not truncate a turn. That is the
 * right bound and the wrong thing to hand a model that has started looping: it
 * will keep going for as long as the cap allows. Tuning it down needed the
 * arithmetic done by hand into the ceiling box until this existed.
 */
describe("the automatic share slider", () => {
	beforeEach(() => {
		mocks.write.mockReset()
		mocks.write.mockResolvedValue(undefined)
		mocks.config.current = { contextWindow: 128000, outputBudget: { mode: "auto" } }
	})

	it("starts at the full automatic figure", () => {
		render(<OutputBudgetField providerId="opencoti" />)

		expect(screen.getByTestId("output-budget-percent").textContent).toBe("100%")
		// 75% of 128,000.
		expect(screen.getByTestId("output-budget-readout").textContent).toContain("96,000")
	})

	it("reads the stored ceiling back as a percentage", () => {
		mocks.config.current = { contextWindow: 128000, outputBudget: { mode: "auto", maxTokens: 48000 } }
		render(<OutputBudgetField providerId="opencoti" />)

		expect(screen.getByTestId("output-budget-percent").textContent).toBe("50%")
	})

	it("is absent in manual mode, where the box is the cap itself", () => {
		mocks.config.current = { contextWindow: 128000, outputBudget: { mode: "manual", maxTokens: 96000 } }
		render(<OutputBudgetField providerId="opencoti" />)

		expect(screen.queryByTestId("output-budget-percent")).toBeNull()
	})

	it("is absent with no context window, having nothing to take a share of", () => {
		mocks.config.current = { outputBudget: { mode: "auto" } }
		render(<OutputBudgetField providerId="opencoti" />)

		expect(screen.queryByTestId("output-budget-percent")).toBeNull()
	})

	it("writes the ceiling the slider lands on", async () => {
		render(<OutputBudgetField providerId="opencoti" />)

		// Radix drives the thumb from the keyboard, which is the only pointer
		// -free path in jsdom. One step down from 100% is 95% of 96,000.
		await act(async () => {
			fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowLeft" })
		})

		expect(mocks.write).toHaveBeenLastCalledWith({ outputBudget: { mode: "auto", maxTokens: 91200 } })
	})

	it("clears the ceiling at the top, rather than pinning it to today's window", async () => {
		// 100% is the absence of a ceiling. Stored as a number it would freeze
		// the cap at the current window and stop tracking a later change to it.
		mocks.config.current = { contextWindow: 128000, outputBudget: { mode: "auto", maxTokens: 91200 } }
		render(<OutputBudgetField providerId="opencoti" />)

		await act(async () => {
			fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" })
		})

		expect(mocks.write).toHaveBeenLastCalledWith({ outputBudget: { mode: "auto", maxTokens: undefined } })
	})

	it("will not step below the floor", async () => {
		// The floor is 15% here (10,667 of 96,000 rounded up to a 5% step), so
		// the slider must refuse to go under it however many times it is nudged.
		mocks.config.current = {
			contextWindow: 128000,
			outputBudget: { mode: "auto", maxTokens: 14400 },
			sampling: { thinkBudget: 8000 },
		}
		render(<OutputBudgetField providerId="opencoti" />)

		expect(screen.getByTestId("output-budget-percent").textContent).toBe("15%")
		await act(async () => {
			fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowLeft" })
		})

		// Still 15%: Radix clamps to `min`, so no write below the floor happens.
		expect(screen.getByTestId("output-budget-percent").textContent).toBe("15%")
	})

	it("says when num_predict will override it", () => {
		mocks.config.current = {
			contextWindow: 128000,
			outputBudget: { mode: "auto" },
			sampling: { numPredict: 4096 },
		}
		render(<OutputBudgetField providerId="opencoti" />)

		expect(screen.getByTestId("output-budget-readout").textContent).toContain("num_predict is set to 4,096")
	})
})

/**
 * The floor, which is the part that stops the slider producing a cap that
 * cannot answer.
 */
describe("the slider floor", () => {
	it("ignores a thinking level, which scales with the cap", () => {
		// high is 1/2 of min(cap, window): lower the cap and the allowance
		// follows it down, so the reply always keeps its half.
		expect(thinkingFloorTokens("high", true)).toBeNull()
		expect(thinkingFloorTokens("medium", true)).toBeNull()
		expect(thinkingFloorTokens(undefined, true)).toBeNull()
		expect(thinkingFloorTokens("", true)).toBeNull()
	})

	it("guards a flat token count, which does not", () => {
		// 8,000 sent whatever the cap is: at a 1,000-token cap the turn spends
		// its whole allowance thinking and is cut before writing an answer.
		// Needs room past the thinking, not merely room for it.
		expect(thinkingFloorTokens(8000, true)).toBe(Math.ceil(8000 / 0.75))
		expect(thinkingFloorTokens("8000", true)).toBe(10667)
	})

	it("is irrelevant when thinking is off", () => {
		expect(thinkingFloorTokens(8000, false)).toBeNull()
	})

	it("rounds the lowest step up to clear the floor", () => {
		// 1,024 of 96,000 is 1.07%, and the first 5% step above it is 5%.
		expect(minSliderPercent(96000, 1024)).toBe(5)
		// 10,667 of 96,000 is 11.1%, so 10% would sit under the floor.
		expect(minSliderPercent(96000, 10667)).toBe(15)
	})

	it("collapses to the default when the floor is at or above it", () => {
		// Nothing safe to offer: better a slider that cannot move than one whose
		// positions all truncate the answer.
		expect(minSliderPercent(8000, 10667)).toBe(100)
		expect(minSliderPercent(0, 1024)).toBe(100)
	})

	it("explains a floor raised by the thinking budget", () => {
		mocks.config.current = {
			contextWindow: 128000,
			outputBudget: { mode: "auto" },
			sampling: { thinkBudget: 8000 },
		}
		render(<OutputBudgetField providerId="opencoti" />)

		const readout = screen.getByTestId("output-budget-readout").textContent ?? ""
		expect(readout).toContain("Floor 10,667")
		expect(readout).toContain("8,000")
	})
})
