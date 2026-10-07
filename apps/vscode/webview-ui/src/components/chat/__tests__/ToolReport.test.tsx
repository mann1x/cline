import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import ToolReport, { reportText } from "../ToolReport"

// A library_add report as pandorum showed it (4.100.242): the checklist
// reminder core appends for the model had become the end of the user's report.
const sent = [
	'"Introducing Ethereum and Solidity" (#169): 1 source added, 463 passages, searchable by keyword now.',
	"",
	"REPORT: 1 of 1 done, 2m 40s.",
	"- introducingethereumandsolidity.epub: added, 14 chapters (2m 05s)",
	"",
	"<task_progress>",
	"Task progress (0/0 done):",
	"Verify epub-parse fix on previously-failed epubs",
	"Report",
	"</task_progress>",
].join("\n")

describe("ToolReport", () => {
	it("leaves out the checklist reminder written to the model", () => {
		expect(reportText(sent)).toBe(
			[
				'"Introducing Ethereum and Solidity" (#169): 1 source added, 463 passages, searchable by keyword now.',
				"",
				"REPORT: 1 of 1 done, 2m 40s.",
				"- introducingethereumandsolidity.epub: added, 14 chapters (2m 05s)",
			].join("\n"),
		)
		render(<ToolReport report={sent} />)
		expect(screen.getByText("4 lines")).toBeTruthy()
		fireEvent.click(screen.getByLabelText("Expand report"))
		expect(screen.queryByText(/Task progress/)).toBeNull()
	})

	it("shows nothing when the reminder was all there was", () => {
		const { container } = render(<ToolReport report={"<task_progress>\n- [ ] a\n</task_progress>"} />)
		expect(container.innerHTML).toBe("")
	})
})
