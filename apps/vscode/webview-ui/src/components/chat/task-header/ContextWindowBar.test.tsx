import type { ContextBreakdown } from "@shared/ExtensionMessage"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { CONTEXT_SEGMENT_COLORS, ContextWindowBar, contextWindowSegments } from "./ContextWindowBar"

/** pandorum's own numbers, from a 65,536-token window on 2026-09-19. */
const PANDORUM: ContextBreakdown = {
	systemPromptTokens: 1_607,
	builtinToolSchemaTokens: 9_054,
	mcpToolSchemaTokens: 12_400,
	toolCount: 41,
	mcpToolCount: 28,
}

describe("the context bar's slices", () => {
	it("splits a request into the prompt, the tools, the MCP tools and the rest", () => {
		const segments = contextWindowSegments(30_000, PANDORUM)

		expect(segments.map((segment) => segment.key)).toEqual(["systemPrompt", "builtinTools", "mcpTools", "messages"])
		expect(segments.map((segment) => segment.tokens)).toEqual([1_607, 9_054, 12_400, 6_939])
		// The slices are the request, exactly: a fourth, unnamed colour would
		// mean the bar is drawing something nobody measured.
		expect(segments.reduce((sum, segment) => sum + segment.tokens, 0)).toBe(30_000)
	})

	// Two measurements of overlapping things: `used` is the provider's count of
	// the request, the breakdown is this fork's estimate made before it went
	// out. The estimate can come out the larger of the two, and a conversation
	// slice of minus four thousand tokens is not a picture of anything.
	it("fits the fixed slices inside a request the provider counted smaller", () => {
		const segments = contextWindowSegments(10_000, PANDORUM)

		expect(segments.map((segment) => segment.key)).toEqual(["systemPrompt", "builtinTools", "mcpTools"])
		expect(segments.reduce((sum, segment) => sum + segment.tokens, 0)).toBeCloseTo(10_000, 6)
		// Scaled, so the proportions the colours exist to show survive.
		expect(segments[2].tokens / segments[0].tokens).toBeCloseTo(PANDORUM.mcpToolSchemaTokens / PANDORUM.systemPromptTokens, 6)
	})

	it("leaves out the MCP slice when no server is connected", () => {
		const segments = contextWindowSegments(30_000, { ...PANDORUM, mcpToolSchemaTokens: 0, mcpToolCount: 0 })

		expect(segments.map((segment) => segment.key)).toEqual(["systemPrompt", "builtinTools", "messages"])
	})

	it("has no slices to draw without a breakdown", () => {
		expect(contextWindowSegments(30_000, undefined)).toEqual([])
	})
})

describe("the context bar", () => {
	it("draws one slice per part, in the order they are paid", () => {
		render(<ContextWindowBar breakdown={PANDORUM} max={65_536} used={30_000} />)

		const bar = screen.getByTestId("context-window-bar")
		const drawn = Array.from(bar.children).map((child) => ({
			segment: child.getAttribute("data-segment"),
			width: (child as HTMLElement).style.width,
			color: (child as HTMLElement).style.backgroundColor,
		}))
		expect(drawn.map((slice) => slice.segment)).toEqual(["systemPrompt", "builtinTools", "mcpTools", "messages"])
		expect(drawn[0].color).toBe(CONTEXT_SEGMENT_COLORS.systemPrompt)
		expect(drawn[2].color).toBe(CONTEXT_SEGMENT_COLORS.mcpTools)
		// Widths are a share of the window, not of the request: the bar's track
		// is the context window, so the four slices together fill the same
		// fraction the undivided bar did.
		const total = drawn.reduce((sum, slice) => sum + Number.parseFloat(slice.width), 0)
		expect(total).toBeCloseTo((30_000 / 65_536) * 100, 6)
	})

	// A task from before the breakdown existed, or a core that does not report
	// one. The bar has to look exactly as it did rather than empty.
	it("falls back to one undivided fill with nothing to colour", () => {
		render(<ContextWindowBar max={65_536} used={30_000} />)

		const bar = screen.getByTestId("context-window-bar")
		expect(bar.children).toHaveLength(1)
		expect(bar.children[0].getAttribute("data-segment")).toBe("total")
		expect((bar.children[0] as HTMLElement).style.width).toBe(`${(30_000 / 65_536) * 100}%`)
	})
})
