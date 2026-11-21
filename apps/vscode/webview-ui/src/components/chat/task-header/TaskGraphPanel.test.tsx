import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const taskGraphAction = vi.fn()
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { taskGraphAction: (request: { value: string }) => taskGraphAction(request) },
}))

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

describe("TaskGraphPanel edits", () => {
	beforeEach(() => {
		taskGraphAction.mockReset()
		taskGraphAction.mockResolvedValue({ value: JSON.stringify({ ok: true, lines: ["T2 now done."] }) })
	})
	const sent = () => taskGraphAction.mock.calls.map(([request]) => JSON.parse(request.value))
	const openTask = (id: string, title: string) => {
		render(<TaskGraphPanel clineMessages={[board(tasks)]} />)
		fireEvent.click(screen.getByText("Tasks"))
		fireEvent.click(screen.getByText(title))
		return id
	}

	it("finishes a task with what was done, and shows the board's answer", async () => {
		openTask("T2", "Store cents")
		fireEvent.click(screen.getByText("Done…"))
		fireEvent.change(screen.getByLabelText("Mark done"), { target: { value: "migrated" } })
		fireEvent.click(screen.getByRole("button", { name: "Mark done" }))
		expect(sent()).toEqual([{ op: "update", updates: [{ id: "T2", status: "done", note: "migrated" }] }])
		await waitFor(() => expect(screen.getByRole("status").textContent).toBe("T2 now done."))
	})

	it("asks for a reason before cancelling", () => {
		openTask("T2", "Store cents")
		fireEvent.click(screen.getByText("Cancel…"))
		const confirm = screen.getByRole("button", { name: "Cancel task" })
		expect(confirm).toHaveProperty("disabled", true)
		fireEvent.change(screen.getByLabelText("Cancel task"), { target: { value: "dropped" } })
		fireEvent.click(confirm)
		expect(sent()).toEqual([{ op: "update", updates: [{ id: "T2", status: "cancelled", note: "dropped" }] }])
	})

	it("ticks an acceptance item by its number", () => {
		openTask("T2", "Store cents")
		fireEvent.click(screen.getByLabelText("Tick: old files load"))
		expect(sent()).toEqual([{ op: "update", updates: [{ id: "T2", check: [1] }] }])
	})

	it("reopens a closed task and adds a new one", () => {
		openTask("T1", "Read the code")
		fireEvent.click(screen.getByText("Reopen"))
		fireEvent.click(screen.getByText("+ Add task"))
		fireEvent.change(screen.getByLabelText("Add"), { target: { value: "Write docs" } })
		fireEvent.click(screen.getByRole("button", { name: "Add" }))
		expect(sent()).toEqual([
			{ op: "update", updates: [{ id: "T1", status: "pending" }] },
			{ op: "plan", tasks: [{ title: "Write docs" }] },
		])
	})

	it("shows a refusal as an error", async () => {
		taskGraphAction.mockResolvedValue({
			value: JSON.stringify({ ok: false, lines: ["Send a message to resume it."] }),
		})
		openTask("T2", "Store cents")
		fireEvent.click(screen.getByLabelText("Tick: old files load"))
		await waitFor(() => expect(screen.getByRole("status").className).toContain("text-error"))
	})
})

describe("TaskGraphPanel save to memory", () => {
	beforeEach(() => {
		taskGraphAction.mockReset()
	})

	it("offers the memories, then saves into the chosen one", async () => {
		taskGraphAction.mockImplementation(async (request: { value: string }) => {
			const action = JSON.parse(request.value)
			if (action.op === "memories") {
				return {
					value: JSON.stringify({
						ok: true,
						lines: [],
						memories: { enabled: true, names: ["main", "acme"], preferred: "acme" },
					}),
				}
			}
			return { value: JSON.stringify({ ok: true, lines: ['Saved the board as m4 in "main".'] }) }
		})
		render(<TaskGraphPanel clineMessages={[board(tasks)]} />)
		fireEvent.click(screen.getByText("Tasks"))
		fireEvent.click(screen.getByText("Save to memory…"))
		const select = (await screen.findByLabelText("Memory to save the board in")) as HTMLSelectElement
		expect(select.value).toBe("acme")
		fireEvent.change(select, { target: { value: "main" } })
		fireEvent.click(screen.getByLabelText("Keep it updated"))
		fireEvent.click(screen.getByText("Save"))
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("m4"))
		expect(JSON.parse(taskGraphAction.mock.calls[1][0].value)).toEqual({ op: "save", memory: "main", keepUpdated: true })
	})

	it("says so when Memory is off", async () => {
		taskGraphAction.mockResolvedValue({
			value: JSON.stringify({ ok: false, lines: [], memories: { enabled: false, names: [], preferred: "main" } }),
		})
		render(<TaskGraphPanel clineMessages={[board(tasks)]} />)
		fireEvent.click(screen.getByText("Tasks"))
		fireEvent.click(screen.getByText("Save to memory…"))
		await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Memory is off"))
	})
})
