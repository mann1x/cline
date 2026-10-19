import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NoticesSection, noticeWordingLines, parseNoticeSteps } from "./NoticesSection"

type Config = {
	notices?: {
		enabled?: boolean
		thinkSteps?: number[]
		answerSteps?: number[]
		thinkTemplates?: string[]
		answerTemplates?: string[]
		copyBarThink?: boolean
		copyBarAnswer?: boolean
	}
}

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
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeButton: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
		<button onClick={onClick} type="button">
			{children}
		</button>
	),
}))
vi.mock("./DebouncedTextArea", () => ({
	DebouncedTextArea: ({ initialValue, onChange }: { initialValue: string; onChange: (value: string) => void }) => (
		<textarea data-testid="wording" onChange={(event) => onChange(event.target.value)} value={initialValue} />
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
			notices: { enabled: true, thinkSteps: [], answerSteps: [], thinkTemplates: [], answerTemplates: [] },
		})
		const thinking = screen.getByText(/Thinking steps/).parentElement?.querySelector("input") as HTMLInputElement
		await act(async () => {
			fireEvent.change(thinking, { target: { value: "80, 90" } })
		})
		expect(mocks.write).toHaveBeenLastCalledWith({
			notices: { enabled: true, thinkSteps: [80, 90], answerSteps: [], thinkTemplates: [], answerTemplates: [] },
		})
	})

	// The wording and the copy bar are the model's, so they sit with the switch
	// that turns notices on for this profile, and only while it is on.
	it("shows the wording and copy bars only while notices are on", async () => {
		render(<NoticesSection providerId="opencoti" />)
		expect(screen.queryByTestId("notices-wording")).toBeNull()
		await act(async () => {
			fireEvent.click(screen.getByTestId("notices-enabled"))
		})
		expect(screen.getByTestId("notices-wording")).toBeTruthy()
		expect((screen.getByTestId("notices-copyBarThink") as HTMLInputElement).checked).toBe(true)
		expect((screen.getByTestId("notices-copyBarAnswer") as HTMLInputElement).checked).toBe(false)
	})

	it("stores the wording and each copy bar on the profile", async () => {
		mocks.config.current = { notices: { enabled: true } }
		render(<NoticesSection providerId="opencoti" />)
		const [thinking] = screen.getAllByTestId("wording")
		await act(async () => {
			fireEvent.change(thinking as HTMLTextAreaElement, { target: { value: "Settle now.\n\nAnswer now." } })
		})
		expect(mocks.write).toHaveBeenLastCalledWith({
			notices: expect.objectContaining({ enabled: true, thinkTemplates: ["Settle now.", "", "Answer now."] }),
		})
		await act(async () => {
			fireEvent.click(screen.getByTestId("notices-copyBarAnswer"))
		})
		expect(mocks.write).toHaveBeenLastCalledWith({
			notices: expect.objectContaining({ copyBarAnswer: true, thinkTemplates: ["Settle now.", "", "Answer now."] }),
		})
	})

	it("loads the engine's own lines into an empty box", async () => {
		mocks.config.current = { notices: { enabled: true } }
		render(<NoticesSection providerId="xollama" />)
		const [load] = screen.getAllByText("Load default")
		await act(async () => {
			fireEvent.click(load as HTMLElement)
		})
		const written = mocks.write.mock.lastCall?.[0] as Config
		expect(written.notices?.thinkTemplates).toHaveLength(4)
		expect(written.notices?.thinkTemplates?.[0]).toContain("{words}")
	})

	it("reads the box as one line per step, at most four, with trailing blanks dropped", () => {
		expect(noticeWordingLines(" a \r\n\nc\n\n")).toEqual(["a", "", "c"])
		expect(noticeWordingLines("1\n2\n3\n4\n5")).toEqual(["1", "2", "3", "4"])
		expect(noticeWordingLines("")).toEqual([])
	})
})
