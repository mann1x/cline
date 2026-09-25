import { resolveAgentWindowFloor, resolveContextMinimumForWindow } from "@cline/shared"
import { SELECTABLE_TOOLS_TOTAL_TOKENS } from "@shared/tool-selection"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AgentWindowField } from "./AgentWindowField"
import { SYSTEM_PROMPT_FALLBACK_TOKENS } from "./ContextMinimumWarning"

const mocks = vi.hoisted(() => ({ write: vi.fn(), config: { current: {} as Record<string, unknown> } }))

vi.mock("@/hooks/useProviderConfig", async () => {
	const { useCallback, useState } = await import("react")
	return {
		useProviderConfig: () => {
			const [config, setConfig] = useState<Record<string, unknown>>(mocks.config.current)
			const write = useCallback(async (patch: Record<string, unknown>) => {
				mocks.write(patch)
				await Promise.resolve()
				setConfig((previous) => ({ ...previous, ...patch }))
			}, [])
			return { config, write }
		},
	}
})
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ clineMessages: [], mcpServers: [] }),
}))
vi.mock("@/components/ui/label", () => ({ Label: ({ children }: { children?: ReactNode }) => <span>{children}</span> }))

const WINDOW = 131_072

function expectedFloor(sharePercent: number): number {
	const minimum = resolveContextMinimumForWindow({
		contextWindow: WINDOW,
		systemPromptTokens: SYSTEM_PROMPT_FALLBACK_TOKENS,
		toolSchemaTokens: SELECTABLE_TOOLS_TOTAL_TOKENS,
	})
	return resolveAgentWindowFloor({ contextWindow: WINDOW, minimumTokens: minimum.minimumTokens, sharePercent }) ?? 0
}

describe("the agent window slider", () => {
	beforeEach(() => {
		mocks.write.mockReset()
		mocks.config.current = { contextWindow: WINDOW, outputBudget: { mode: "auto" } }
	})

	it("defaults to 50% and shows the floor it gives, live", () => {
		render(<AgentWindowField negotiates providerId="opencoti" />)
		expect(screen.getByTestId("agent-window-percent").textContent).toBe(
			`50% · ${expectedFloor(50).toLocaleString("en-US")} tokens`,
		)
		expect(screen.getByTestId("agent-window-readout").textContent).toContain(
			`accepts no less than ${expectedFloor(50).toLocaleString("en-US")}`,
		)
	})

	it("reads the share the node stored", () => {
		mocks.config.current = { ...mocks.config.current, agentWindow: { sharePercent: 20 } }
		render(<AgentWindowField negotiates providerId="opencoti" />)
		expect(screen.getByTestId("agent-window-percent").textContent).toBe(
			`20% · ${expectedFloor(20).toLocaleString("en-US")} tokens`,
		)
	})

	it("reads a stored 0% as 0%, not as the default", () => {
		mocks.config.current = { ...mocks.config.current, agentWindow: { sharePercent: 0 } }
		render(<AgentWindowField negotiates providerId="opencoti" />)
		expect(screen.getByTestId("agent-window-percent").textContent).toMatch(/^0% · /)
	})

	it("writes the share it lands on, whole", async () => {
		render(<AgentWindowField negotiates providerId="opencoti" />)
		expect(screen.getByRole("slider").hasAttribute("data-disabled")).toBe(false)
		await act(async () => {
			fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" })
		})
		expect(mocks.write).toHaveBeenLastCalledWith({ agentWindow: { sharePercent: 55 } })
		await act(async () => {
			fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" })
		})
		expect(mocks.write).toHaveBeenLastCalledWith({ agentWindow: { sharePercent: 60 } })
		expect(screen.getByTestId("agent-window-percent").textContent).toMatch(/^60% · /)
	})

	// The field takes the node's stored window, never the model info's safe
	// default, which on a node tab is not the window the host resolves.
	it("asks for the node's window to be set when it stores none", () => {
		mocks.config.current = { outputBudget: { mode: "auto" } }
		render(<AgentWindowField negotiates providerId="opencoti" />)
		expect(screen.getByTestId("agent-window-percent").textContent).toBe("50%")
		expect(screen.getByTestId("agent-window-readout").textContent).toBe(
			"Set this node's Model Context Window to see the floor this share gives.",
		)
	})

	it("reads the window from the selection override the same box writes", () => {
		mocks.config.current = { outputBudget: { mode: "auto" }, selectedModelOverrides: { contextWindow: WINDOW } }
		render(<AgentWindowField negotiates providerId="opencoti" />)
		expect(screen.getByTestId("agent-window-percent").textContent).toBe(
			`50% · ${expectedFloor(50).toLocaleString("en-US")} tokens`,
		)
	})

	// Ollama and llama.cpp have no negotiation: the node's window is what is
	// sent, so the slider is shown but cannot move, and says why.
	it("is disabled, with its reason, where the provider does not negotiate", () => {
		render(<AgentWindowField negotiates={false} providerId="ollama" />)
		expect(screen.getByRole("slider").hasAttribute("data-disabled")).toBe(true)
		expect(screen.getByTestId("agent-window-inert").textContent).toBe(
			"Only opencoti negotiates a window per agent; this node sends its context window as set, so the share has no effect here.",
		)
		expect(screen.getByTestId("agent-window-percent").textContent).toBe("50%")
	})
})
