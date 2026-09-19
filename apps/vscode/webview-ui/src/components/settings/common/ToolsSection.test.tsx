import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ToolsSection } from "./ToolsSection"

type Config = { tools?: { disabled?: string[] } }

const mocks = vi.hoisted(() => ({ write: vi.fn(), config: { current: {} as Config } }))

// The host round trip behind the hook: the panel does not see its own write
// until the answer comes back, so anything clicked in between is composed from
// the list as it stood before.
vi.mock("@/hooks/useProviderConfig", async () => {
	const { useCallback, useState } = await import("react")
	return {
		useProviderConfig: () => {
			const [config, setConfig] = useState<Config>(mocks.config.current)
			const write = useCallback(async (patch: Config) => {
				mocks.write(patch)
				await Promise.resolve()
				setConfig((previous) => ({ ...previous, ...(patch.tools !== undefined ? { tools: patch.tools } : {}) }))
			}, [])
			return { config, write }
		},
	}
})

vi.mock("@/components/ui/label", () => ({
	Label: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}))
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

describe("the tools section", () => {
	beforeEach(() => {
		mocks.write.mockReset()
		mocks.write.mockResolvedValue(undefined)
		mocks.config.current = {}
	})

	it("offers every tool when the profile names none", () => {
		render(<ToolsSection providerId="ollama" />)

		expect((screen.getByTestId("tool-grep") as HTMLInputElement).checked).toBe(true)
		expect((screen.getByTestId("tool-editor") as HTMLInputElement).checked).toBe(true)
	})

	it("writes the tool the user switched off", async () => {
		render(<ToolsSection providerId="ollama" />)

		fireEvent.click(screen.getByTestId("tool-grep"))

		expect(mocks.write).toHaveBeenCalledWith({ tools: { disabled: ["grep"] } })
		await act(async () => {})
	})

	it("keeps the first switch off when a second is flipped in the same round trip", async () => {
		render(<ToolsSection providerId="ollama" />)

		// Both inside one round trip. Composed from the config rather than from
		// what was last sent, the second write would carry only `awk` and put
		// `grep` back -- the fault the PolyKV section was reported for.
		fireEvent.click(screen.getByTestId("tool-grep"))
		fireEvent.click(screen.getByTestId("tool-awk"))

		expect(mocks.write).toHaveBeenLastCalledWith({ tools: { disabled: ["awk", "grep"] } })
		await act(async () => {})
	})

	it("switches a tool back on by dropping it from the list", async () => {
		mocks.config.current = { tools: { disabled: ["grep", "awk"] } }
		render(<ToolsSection providerId="ollama" />)
		expect((screen.getByTestId("tool-grep") as HTMLInputElement).checked).toBe(false)

		fireEvent.click(screen.getByTestId("tool-grep"))

		expect(mocks.write).toHaveBeenCalledWith({ tools: { disabled: ["awk"] } })
		await act(async () => {})
	})

	it("shows what the selection costs", () => {
		mocks.config.current = { tools: { disabled: ["editor"] } }
		render(<ToolsSection providerId="ollama" />)

		// The editor is 1,860 of the 8,647 tokens on offer, so dropping it has
		// to move the number the panel prints.
		const total = screen.getByTestId("tools-section-total").textContent ?? ""
		expect(total).toContain("6.8k of 8.6k tokens")
	})
})
