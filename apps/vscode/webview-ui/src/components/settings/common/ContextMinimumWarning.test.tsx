import { SELECTABLE_TOOLS, SELECTABLE_TOOLS_TOTAL_TOKENS } from "@shared/tool-selection"
import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ContextMinimumWarning, mcpSchemaTokens, SYSTEM_PROMPT_FALLBACK_TOKENS } from "./ContextMinimumWarning"

const mocks = vi.hoisted(() => ({
	config: { current: {} as Record<string, unknown> | undefined },
	state: { current: {} as Record<string, unknown> },
}))

vi.mock("@/hooks/useProviderConfig", () => ({
	useProviderConfig: () => ({ config: mocks.config.current, write: vi.fn() }),
}))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => mocks.state.current,
}))

function fixedPrice(disabled: string[] = []): number {
	return (
		SYSTEM_PROMPT_FALLBACK_TOKENS +
		SELECTABLE_TOOLS.filter((tool) => !disabled.includes(tool.name)).reduce((total, tool) => total + tool.tokens, 0)
	)
}

describe("the context minimum warning", () => {
	beforeEach(() => {
		mocks.config.current = { outputBudget: { mode: "auto" } }
		mocks.state.current = { clineMessages: [], mcpServers: [] }
	})

	it("names the window, the minimum and both parts when the window is short", () => {
		render(<ContextMinimumWarning contextWindow={16_384} providerId="ollama" />)
		const fixed = fixedPrice()
		// Three quarters of 16,384.
		const output = 12_288
		expect(screen.getByTestId("context-minimum-warning").textContent).toBe(
			`16,384 is below the ${(fixed + output).toLocaleString("en-US")} this profile needs ` +
				`(system prompt + tools + MCP ${fixed.toLocaleString("en-US")}, output room 12,288). Turns will be cut short or refused.`,
		)
	})

	it("renders nothing at or above the minimum", () => {
		render(<ContextMinimumWarning contextWindow={131_072} providerId="ollama" />)
		expect(screen.queryByTestId("context-minimum-warning")).toBeNull()
	})

	// The fixed price depends on which tools the profile offers, so switching
	// one off moves the minimum in the same render the Tools section updates.
	it("follows the profile's tool selection", () => {
		const view = render(<ContextMinimumWarning contextWindow={4_096} providerId="ollama" />)
		expect(screen.getByTestId("context-minimum-warning").textContent).toContain(
			`system prompt + tools + MCP ${(SYSTEM_PROMPT_FALLBACK_TOKENS + SELECTABLE_TOOLS_TOTAL_TOKENS).toLocaleString("en-US")},`,
		)
		const off = SELECTABLE_TOOLS.map((tool) => tool.name)
		mocks.config.current = { outputBudget: { mode: "auto" }, tools: { disabled: off } }
		view.rerender(<ContextMinimumWarning contextWindow={4_096} providerId="ollama" />)
		expect(screen.getByTestId("context-minimum-warning").textContent).toContain(
			`system prompt + tools + MCP ${SYSTEM_PROMPT_FALLBACK_TOKENS.toLocaleString("en-US")},`,
		)
	})

	it("uses the system prompt the context bar measured, when a task has one", () => {
		mocks.state.current = {
			mcpServers: [],
			clineMessages: [
				{
					ts: 1,
					type: "say",
					say: "api_req_started",
					text: JSON.stringify({
						tokensIn: 100,
						tokensOut: 10,
						contextBreakdown: {
							systemPromptTokens: 5_000,
							builtinToolSchemaTokens: 0,
							mcpToolSchemaTokens: 0,
							toolCount: 0,
							mcpToolCount: 0,
						},
					}),
				},
			],
		}
		render(<ContextMinimumWarning contextWindow={16_384} providerId="ollama" />)
		const fixed = fixedPrice() - SYSTEM_PROMPT_FALLBACK_TOKENS + 5_000
		expect(screen.getByTestId("context-minimum-warning").textContent).toContain(
			`system prompt + tools + MCP ${fixed.toLocaleString("en-US")},`,
		)
	})

	it("counts MCP schemas of enabled servers only", () => {
		const tool = { name: "search", description: "x".repeat(3_000), inputSchema: { type: "object" } }
		expect(mcpSchemaTokens([{ name: "a", config: "", status: "connected", tools: [tool] }])).toBeGreaterThan(1_000)
		expect(mcpSchemaTokens([{ name: "a", config: "", status: "connected", disabled: true, tools: [tool] }])).toBe(0)
	})

	it("lets a typed num_predict set the output room", () => {
		mocks.config.current = { outputBudget: { mode: "auto" }, sampling: { numPredict: 4_096 } }
		render(<ContextMinimumWarning contextWindow={8_192} providerId="llamacpp" />)
		expect(screen.getByTestId("context-minimum-warning").textContent).toContain("output room 4,096)")
	})
})
