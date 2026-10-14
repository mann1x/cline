import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NoticesSection, parseNoticeSteps } from "./NoticesSection"

type Config = { notices?: { enabled?: boolean; thinkSteps?: number[]; answerSteps?: number[] } }

const mocks = vi.hoisted(() => ({ write: vi.fn(), config: { current: {} as Config } }))

vi.mock("@/hooks/useProviderConfig", async () => {
	const { useCallback, useState } = await import("react")
	return {
		useProviderConfig: () => {
			const [config, setConfig] = useState<Config>(mocks.config.current)
			const write = useCallback(async (patch: Config) => {
				mocks.write(patch)
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
	DebouncedTextField: ({
		initialValue,
		onChange,
		children,
	}: {
		initialValue: string
		onChange: (value: string) => void
		children?: ReactNode
	}) => (
		<label>
			{children}
			<input defaultValue={initialValue} onChange={(event) => onChange(event.target.value)} />
		</label>
	),
}))

describe("the generation notices section", () => {
	beforeEach(() => {
		mocks.write.mockReset()
		mocks.config.current = {}
	})

	it("reads steps as whole percents, sorted, at most four", () => {
		expect(parseNoticeSteps("90, 60 70;80 85")).toEqual([60, 70, 80, 85])
		expect(parseNoticeSteps("0, 100, 50.5, x, 75")).toEqual([75])
		expect(parseNoticeSteps("")).toEqual([])
	})

	it("is off for a profile that never set it, and shows no steps", () => {
		render(<NoticesSection providerId="opencoti" />)
		expect((screen.getByTestId("notices-enabled") as HTMLInputElement).checked).toBe(false)
		expect(screen.queryByText(/Thinking steps/)).toBeNull()
	})

	it("writes the whole section, and a step typed after the switch keeps the switch on", async () => {
		render(<NoticesSection providerId="xollama" />)
		await act(async () => {
			fireEvent.click(screen.getByTestId("notices-enabled"))
		})
		expect(mocks.write).toHaveBeenLastCalledWith({
			notices: { enabled: true, thinkSteps: [], answerSteps: [] },
		})
		const thinking = screen.getByText(/Thinking steps/).parentElement?.querySelector("input") as HTMLInputElement
		await act(async () => {
			fireEvent.change(thinking, { target: { value: "80, 90" } })
		})
		expect(mocks.write).toHaveBeenLastCalledWith({
			notices: { enabled: true, thinkSteps: [80, 90], answerSteps: [] },
		})
	})
})
