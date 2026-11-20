import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { findLatestTaskGraph, TaskGraphPanel, type TaskGraphPanelTask, taskGraphHeader } from "./TaskGraphPanel"

const base: Omit<TaskGraphPanelTask, "id" | "title" | "status"> = {
	priority: "M",
	depends: [],
	openDepends: [],
	acceptance: [],
	later: false,
	files: [],
	notes: [],
	ready: false,
	blocked: false,
}

function board(tasks: TaskGraphPanelTask[], layers: string[][] = []): ClineMessage {
	return { ts: 1, type: "say", say: "task_graph", text: JSON.stringify({ tasks, layers }), partial: false }
}

const tasks: TaskGraphPanelTask[] = [
	{ ...base, id: "T1", title: "Read the code", status: "done", outcome: "read it" },
	{ ...base, id: "T2", title: "Store cents", status: "active", acceptance: [{ text: "old files load", done: false }] },
	{ ...base, id: "T3", title: "Report", status: "pending", depends: ["T2"], openDepends: ["T2"], blocked: true },
	{ ...base, id: "T3.1", title: "Monthly totals", status: "pending", parent: "T3", openDepends: ["T2"], blocked: true },
]

describe("TaskGraphPanel", () => {
	it("renders nothing without a board", () => {
		const { container } = render(<TaskGraphPanel clineMessages={[]} />)
		expect(container.firstChild).toBeNull()
	})

	it("takes the newest board and ignores a broken row", () => {
		const older = board([{ ...base, id: "T1", title: "old", status: "pending" }])
		expect(findLatestTaskGraph([older, board(tasks)])?.tasks).toHaveLength(4)
		expect(findLatestTaskGraph([{ ...older, text: "{not json" }])).toBeUndefined()
	})

	it("says how far along the board is, with the active task while collapsed", () => {
		render(<TaskGraphPanel clineMessages={[board(tasks)]} />)
		expect(taskGraphHeader(tasks)).toBe("1/4 · 1 active · 2 blocked")
		expect(screen.getByText("1/4 · 1 active · 2 blocked")).toBeTruthy()
		expect(screen.getByText("T2 Store cents")).toBeTruthy()
	})

	it("lists subtasks under their parent, blocked ones with what they wait on, and opens a task's detail", () => {
		render(<TaskGraphPanel clineMessages={[board(tasks, [["T2"], ["T3", "T3.1"]])]} />)
		fireEvent.click(screen.getByRole("button", { name: /Tasks/ }))
		expect(screen.getAllByText("· after T2")).toHaveLength(2)
		fireEvent.click(screen.getByText("Store cents"))
		expect(screen.getByText("old files load")).toBeTruthy()
		fireEvent.click(screen.getByRole("tab", { name: "Graph" }))
		expect(screen.getByText(/T3 Report · T3.1 Monthly totals/)).toBeTruthy()
	})

	it("has no control that changes the board", () => {
		render(<TaskGraphPanel clineMessages={[board(tasks)]} />)
		fireEvent.click(screen.getByRole("button", { name: /Tasks/ }))
		expect(screen.queryByRole("checkbox")).toBeNull()
		expect(screen.queryByRole("textbox")).toBeNull()
	})
})
