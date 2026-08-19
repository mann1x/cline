import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { findLatestTaskProgress, parseTaskProgressMarkdown, TaskProgressPanel } from "./TaskProgressPanel"

const msg = (text: string, ts = 1): ClineMessage => ({ ts, type: "say", say: "task_progress", text }) as ClineMessage

describe("parseTaskProgressMarkdown", () => {
	it("reads checked and unchecked items", () => {
		expect(parseTaskProgressMarkdown("- [x] read the file\n- [ ] fix line 94")).toEqual([
			{ text: "read the file", done: true },
			{ text: "fix line 94", done: false },
		])
	})

	// Models wrap the list in prose; counting those as pending items would show
	// work that does not exist and never reach complete.
	it("ignores prose around the list", () => {
		expect(parseTaskProgressMarkdown("Here is my plan:\n\n- [ ] real\nnot an item")).toEqual([{ text: "real", done: false }])
	})
})

describe("findLatestTaskProgress", () => {
	// The checklist replaces the previous one rather than appending, so the
	// newest message is the whole truth.
	it("takes the newest checklist", () => {
		const found = findLatestTaskProgress([msg("- [ ] a", 1), msg("- [x] a", 2)])
		expect(found).toBe("- [x] a")
	})

	it("returns nothing when the model never sent one", () => {
		expect(findLatestTaskProgress([{ ts: 1, type: "say", say: "text", text: "hi" } as ClineMessage])).toBeUndefined()
	})
})

describe("TaskProgressPanel", () => {
	it("shows progress and the current item while collapsed", () => {
		render(<TaskProgressPanel clineMessages={[msg("- [x] read\n- [ ] fix\n- [ ] verify")]} />)

		expect(screen.getByText("(1/3)")).toBeInTheDocument()
		expect(screen.getByText("fix")).toBeInTheDocument()
	})

	it("lists every item once expanded", () => {
		render(<TaskProgressPanel clineMessages={[msg("- [x] read\n- [ ] fix")]} />)
		fireEvent.click(screen.getByRole("button"))

		expect(screen.getByText("read")).toBeInTheDocument()
		expect(screen.getByText("fix")).toBeInTheDocument()
	})

	// A model that ignores the parameter should cost no screen space, rather
	// than leaving an empty panel advertising a feature that is not running.
	it("renders nothing without a checklist", () => {
		const { container } = render(<TaskProgressPanel clineMessages={[]} />)
		expect(container.firstChild).toBeNull()
	})

	it("renders nothing when the feature is disabled", () => {
		const { container } = render(<TaskProgressPanel clineMessages={[msg("- [ ] a")]} enabled={false} />)
		expect(container.firstChild).toBeNull()
	})
})
