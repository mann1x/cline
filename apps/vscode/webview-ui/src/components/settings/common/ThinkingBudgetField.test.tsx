import { fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { readStoredThinkingLevel, ThinkingBudgetField } from "./ThinkingBudgetField"

type Reasoning = { enabled?: boolean; effort?: string }
type Config = { reasoning?: Reasoning; sampling?: Record<string, unknown> }

const mocks = vi.hoisted(() => ({ write: vi.fn(), config: { current: {} as Record<string, unknown> } }))

/**
 * The hook, with the host store's own merge rules behind it — a panel that
 * writes and then reads its own value back is the whole of the reported bug,
 * and a mock that ignores the write cannot see it.
 *
 * Mirrors `apps/vscode/src/sdk/model-catalog/store.ts`: `reasoning` merges
 * field by field, an absent field is left alone, `""` clears the level, and
 * `sampling` is replaced wholesale.
 */
vi.mock("@/hooks/useProviderConfig", async () => {
	const { useCallback, useState } = await import("react")
	return {
		useProviderConfig: () => {
			const [config, setConfig] = useState<Config>(mocks.config.current as Config)
			const write = useCallback(async (patch: Config) => {
				mocks.write(patch)
				setConfig((previous) => {
					const next: Config = { ...previous }
					if (patch.reasoning) {
						const reasoning: Reasoning = { ...previous.reasoning }
						if (patch.reasoning.enabled !== undefined) {
							reasoning.enabled = patch.reasoning.enabled
						}
						if (patch.reasoning.effort !== undefined) {
							reasoning.effort = patch.reasoning.effort === "" ? undefined : patch.reasoning.effort
						}
						next.reasoning = reasoning
					}
					if (patch.sampling !== undefined) {
						next.sampling = patch.sampling
					}
					return next
				})
			}, [])
			return { config, write }
		},
	}
})

// The dropdown is a Radix select, which needs pointer capture jsdom does not
// have. A native select answers the same question — which value is shown, and
// what a change asks for — without the harness.
vi.mock("@/components/ui/select", () => ({
	Select: ({
		value,
		onValueChange,
		children,
	}: {
		value?: string
		onValueChange?: (value: string) => void
		children?: ReactNode
	}) => (
		<select data-testid="thinking-level" onChange={(event) => onValueChange?.(event.target.value)} value={value}>
			{children}
		</select>
	),
	SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
	SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => <option value={value}>{children}</option>,
	SelectTrigger: () => null,
	SelectValue: () => null,
}))

vi.mock("@/components/ui/label", () => ({ Label: ({ children }: { children?: ReactNode }) => <span>{children}</span> }))
vi.mock("./DebouncedTextField", () => ({
	DebouncedTextField: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
	VSCodeCheckbox: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}))

function lastPatch() {
	return mocks.write.mock.calls.at(-1)?.[0] as { reasoning?: { effort?: unknown } } | undefined
}

describe("the thinking budget field", () => {
	beforeEach(() => {
		mocks.write.mockReset()
		mocks.write.mockResolvedValue(undefined)
		mocks.config.current = { reasoning: { enabled: true, effort: "high" } }
	})

	// `undefined` is not a clear: the store merges this section field by field
	// and skips a field that is undefined, so Default left `high` in place and
	// the dropdown snapped straight back to it.
	it("clears the stored level when Default is picked", () => {
		render(<ThinkingBudgetField providerId="opencoti" />)
		fireEvent.change(screen.getByTestId("thinking-level"), { target: { value: "unset" } })

		expect(lastPatch()?.reasoning?.effort).toBe("")
	})

	it("clears the stored level when Custom is picked, since a count replaces it", () => {
		render(<ThinkingBudgetField providerId="opencoti" />)
		fireEvent.change(screen.getByTestId("thinking-level"), { target: { value: "custom" } })

		expect(lastPatch()?.reasoning?.effort).toBe("")
	})

	// Custom stores nothing of its own until a count is typed, so a panel that
	// only reads the store shows Default again and never reveals the field the
	// count goes in — Custom is then unreachable, whatever the store does.
	it("keeps Custom selected before a count has been typed", () => {
		render(<ThinkingBudgetField providerId="opencoti" />)
		const select = screen.getByTestId("thinking-level") as HTMLSelectElement
		fireEvent.change(select, { target: { value: "custom" } })

		expect(select.value).toBe("custom")
		expect(screen.getByText(/An absolute token count/)).toBeInTheDocument()
	})

	it("shows the stored level again once one is picked back", () => {
		render(<ThinkingBudgetField providerId="opencoti" />)
		const select = screen.getByTestId("thinking-level") as HTMLSelectElement
		fireEvent.change(select, { target: { value: "custom" } })
		fireEvent.change(select, { target: { value: "medium" } })

		expect(select.value).toBe("medium")
		expect(screen.queryByText(/An absolute token count/)).not.toBeInTheDocument()
	})
})

describe("reading the stored level", () => {
	it("reads a level from the effort", () => {
		expect(readStoredThinkingLevel({ effort: "xhigh" })).toBe("xhigh")
	})

	it("reads Custom from a stored count", () => {
		expect(readStoredThinkingLevel({ thinkBudget: "4096" })).toBe("custom")
	})

	// Neither stored is not "Default": it is also the state Custom is in before
	// a count exists, and only the panel knows which of the two was asked for.
	it("names no level when nothing is stored", () => {
		expect(readStoredThinkingLevel({ effort: "", thinkBudget: "  " })).toBeUndefined()
	})

	it("ignores a level it does not offer", () => {
		expect(readStoredThinkingLevel({ effort: "enormous" })).toBeUndefined()
	})
})
