import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ThinkingRow } from "./ThinkingRow"

describe("ThinkingRow", () => {
	it("renders streaming title styling and expanded reasoning content", () => {
		render(
			<ThinkingRow
				isExpanded={true}
				isStreaming={true}
				isVisible={true}
				reasoningContent="Inspecting files..."
				showTitle={true}
				title="Thinking..."
			/>,
		)

		const title = screen.getByText("Thinking...")
		expect(title).toBeInTheDocument()
		expect(title).toHaveClass("animate-shimmer")
		expect(screen.getByText("Inspecting files...")).toBeInTheDocument()
	})

	it("renders reasoning as Markdown rather than its source", () => {
		// Models write headings, lists and fenced code while they think. Shown
		// as source, that is a wall of `#` and backticks to read through.
		render(
			<ThinkingRow
				isExpanded={true}
				isVisible={true}
				reasoningContent={"## Plan\n\n- read the file\n- fix line 94"}
				showTitle={true}
			/>,
		)

		expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument()
		expect(screen.getByRole("list")).toBeInTheDocument()
		expect(screen.queryByText(/^## Plan/)).not.toBeInTheDocument()
	})

	it("keeps the body out of a button so reasoning stays selectable", () => {
		// Markdown carries its own buttons (file links); nesting those inside
		// one is invalid, and a clickable body collapsed the block whenever a
		// line of reasoning was selected.
		render(
			<ThinkingRow
				isExpanded={true}
				isVisible={true}
				onToggle={vi.fn()}
				reasoningContent="some reasoning"
				showTitle={true}
			/>,
		)

		// The invariant is that the *body* is not inside a button, not that the
		// row has exactly one: the copy control below is a button too, and
		// counting them made this test fail for a reason it does not care about.
		const body = screen.getByText("some reasoning")
		expect(body.closest("button")).toBeNull()
		expect(screen.getByRole("button", { name: "Thinking" })).toBeInTheDocument()
	})

	it("offers a way to copy the reasoning on its title line, while it streams too", () => {
		// Reasoning was the one row in the panel with no copy affordance, and
		// its body is a 150px scroller pinned to its bottom while text arrives
		// -- what scrolled out could not be read until the turn ended
		// (reported 2026-09-26). The copy sits on the title line and works
		// mid-stream.
		const { rerender } = render(
			<ThinkingRow
				isExpanded={true}
				isStreaming={true}
				isVisible={true}
				onToggle={vi.fn()}
				reasoningContent="I keep regressing."
				showTitle={true}
			/>,
		)

		const copy = screen.getByRole("button", { name: "Copy reasoning" })
		// Beside the title, not inside it: a button cannot hold a button.
		expect(copy.closest("button")).toBe(copy)
		expect(copy.parentElement?.contains(screen.getByRole("button", { name: "Thinking" }))).toBe(true)

		rerender(
			<ThinkingRow
				isExpanded={true}
				isStreaming={false}
				isVisible={true}
				onToggle={vi.fn()}
				reasoningContent="I keep regressing."
				showTitle={true}
			/>,
		)

		// One button, on the title line: the body does not add a second.
		expect(screen.getAllByRole("button", { name: "Copy reasoning" })).toHaveLength(1)
	})

	it("calls onToggle when header is clicked", () => {
		const onToggle = vi.fn()

		render(
			<ThinkingRow
				isExpanded={false}
				isVisible={true}
				onToggle={onToggle}
				reasoningContent="some reasoning"
				showTitle={true}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: /Thinking/i }))
		expect(onToggle).toHaveBeenCalledTimes(1)
	})
})

describe("ThinkingRow body visibility", () => {
	// The body renders only when expanded. A caller that leaves `isExpanded`
	// false during streaming shows a shimmering title and nothing else, and the
	// reasoning becomes readable only once the turn is over — the exact failure
	// this row exists to avoid. RequestStartRow therefore passes
	// `isExpanded || showStreamingThinking`.
	it("hides the reasoning body when collapsed", () => {
		render(
			<ThinkingRow
				isExpanded={false}
				isStreaming={true}
				isVisible={true}
				reasoningContent="Deciding which file to read"
				showTitle={true}
			/>,
		)

		expect(screen.getByText("Thinking")).toBeInTheDocument()
		expect(screen.queryByText("Deciding which file to read")).not.toBeInTheDocument()
	})

	it("shows the reasoning body while it is still streaming in", () => {
		render(
			<ThinkingRow
				isExpanded={true}
				isStreaming={true}
				isVisible={true}
				reasoningContent="Deciding which file to read"
				showTitle={true}
			/>,
		)

		expect(screen.getByText("Deciding which file to read")).toBeInTheDocument()
	})
})

describe("ThinkingRow while streaming", () => {
	const twoLines = "First I read the file.\nThen I fix line 94."

	// Single newlines are not line breaks in Markdown, so live reasoning renders
	// as one running paragraph — reported as a code snippet "collapsed in a
	// single line".
	it("keeps line breaks in streaming reasoning", () => {
		const { container } = render(
			<ThinkingRow isExpanded={true} isStreaming={true} isVisible={true} reasoningContent={twoLines} showTitle={true} />,
		)

		expect(container.textContent).toContain("First I read the file.\nThen I fix line 94.")
		expect(container.querySelector(".whitespace-pre-wrap")).not.toBeNull()
	})

	it("renders Markdown once the text has stopped arriving", () => {
		render(
			<ThinkingRow
				isExpanded={true}
				isStreaming={false}
				isVisible={true}
				reasoningContent={"## Plan\n\n- read the file"}
				showTitle={true}
			/>,
		)

		expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument()
	})
})
