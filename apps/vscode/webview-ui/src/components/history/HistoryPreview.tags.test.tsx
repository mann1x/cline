import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const taskHistory = [
	{ id: "a", ts: 3, task: "fix the login form", tags: ["work", "ui"] },
	{ id: "b", ts: 2, task: "write the release notes", tags: ["docs"] },
	{ id: "c", ts: 1, task: "tidy the css", tags: ["UI"] },
	{ id: "d", ts: 0.5, task: "untagged chore" },
]

vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ taskHistory }) }))
vi.mock("@/hooks/useUsageCostVisibility", () => ({ useUsageCostVisibility: () => () => false, hasReportableCost: () => false }))
vi.mock("@/services/grpc-client", () => ({ TaskServiceClient: { showTaskWithId: vi.fn(() => Promise.resolve()) } }))
vi.mock("@shared/proto/cline/common", () => ({ StringRequest: { create: (x: unknown) => x } }))

import HistoryPreview from "./HistoryPreview"

describe("HistoryPreview tags", () => {
	it("shows each conversation's tags", () => {
		render(<HistoryPreview showHistoryView={vi.fn()} />)
		expect(screen.getAllByText("work")).toHaveLength(1)
		expect(screen.getByText("docs")).toBeTruthy()
	})

	// jsdom has no layout, so the list shows its minimum of three rows; every
	// click below is on a chip in a row that is showing.
	it("narrows the list to the clicked tag, and a second tag widens it (any)", () => {
		render(<HistoryPreview showHistoryView={vi.fn()} />)
		fireEvent.click(screen.getByText("work"))
		expect(screen.getByText("fix the login form")).toBeTruthy()
		expect(screen.queryByText("write the release notes")).toBeNull()
		expect(screen.queryByText("tidy the css")).toBeNull()

		// Any: "ui" adds "tidy the css", whose tag is spelled "UI".
		fireEvent.click(screen.getAllByText("ui")[0])
		expect(screen.getByText("tidy the css")).toBeTruthy()
		expect(screen.queryByText("write the release notes")).toBeNull()
	})

	it("clicking a tag does not open the conversation, and Clear resets", async () => {
		const { TaskServiceClient } = await import("@/services/grpc-client")
		render(<HistoryPreview showHistoryView={vi.fn()} />)
		fireEvent.click(screen.getByText("docs"))
		expect(TaskServiceClient.showTaskWithId).not.toHaveBeenCalled()
		expect(screen.queryByText("fix the login form")).toBeNull()
		fireEvent.click(screen.getByText("Clear"))
		expect(screen.getByText("fix the login form")).toBeTruthy()
	})
})
