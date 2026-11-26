import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const taskGraphAction = vi.fn()
const openFileRelativePath = vi.fn()
vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { taskGraphAction: (request: { value: string }) => taskGraphAction(request) },
	FileServiceClient: { openFileRelativePath: (request: { value: string }) => openFileRelativePath(request) },
}))
// The drawing itself is mermaid's; the panel's part is the code it hands over.
vi.mock("@/components/common/MermaidBlock", () => ({
	default: ({ code }: { code: string }) => <pre data-testid="mermaid">{code}</pre>,
}))

import {
	findLatestTaskGraph,
	plannedRows,
	TaskGraphPanel,
	type TaskGraphPanelTask,
	taskGraphHeader,
	taskGraphMermaid,
} from "./TaskGraphPanel"

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
	it("a task links to the chat row of the call that planned it", () => {
		const planned: ClineMessage = {
			ts: 7,
			type: "say",
			say: "tool",
			text: JSON.stringify({ tool: "task_plan", callId: "call-9" }),
			partial: false,
		}
		expect(plannedRows([planned, board(tasks)]).get("call-9")).toBe(7)
		const onShowMessage = vi.fn()
		const withOrigin = tasks.map((task) => (task.id === "T2" ? { ...task, createdCall: "call-9" } : task))
		render(<TaskGraphPanel clineMessages={[planned, board(withOrigin)]} onShowMessage={onShowMessage} />)
		fireEvent.click(screen.getByText("Tasks"))
		fireEvent.click(screen.getByText("Store cents"))
		fireEvent.click(screen.getByText("Show where it was planned"))
		expect(onShowMessage).toHaveBeenCalledWith(7)
		// A task whose call has no row (an older conversation) offers no link.
		fireEvent.click(screen.getByText("Read the code"))
		expect(screen.getAllByText("Show where it was planned")).toHaveLength(1)
	})

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

describe("TaskGraphPanel gates, links and drawing (phase 5)", () => {
	beforeEach(() => {
		taskGraphAction.mockReset()
		taskGraphAction.mockResolvedValue({ value: JSON.stringify({ ok: true, lines: ["T2: human:go resolved."] }) })
		openFileRelativePath.mockReset()
		openFileRelativePath.mockResolvedValue({})
	})
	const sent = () => taskGraphAction.mock.calls.map(([request]) => JSON.parse(request.value))
	const gated: TaskGraphPanelTask[] = [
		{ ...base, id: "T1", title: "Build", status: "done", files: ["src/a.ts"] },
		{
			...base,
			id: "T2",
			title: "Ship",
			status: "pending",
			blocked: true,
			depends: ["T1"],
			gates: [{ spec: "human:go", open: false }],
			waitsOn: ["human:go"],
			links: [
				{ type: "discovered-from", target: "T1" },
				{ type: "url", target: "https://example.com/pr/1" },
			],
		},
	]

	it("shows what a task waits on, and the person resolves a gate", async () => {
		render(<TaskGraphPanel clineMessages={[board(gated)]} />)
		fireEvent.click(screen.getByText("Tasks"))
		expect(screen.getByText("· after human:go")).toBeTruthy()
		fireEvent.click(screen.getByText("Ship"))
		fireEvent.click(screen.getByRole("button", { name: "Resolve" }))
		await waitFor(() => expect(sent()).toEqual([{ op: "update", updates: [{ id: "T2", gate_open: ["human:go"] }] }]))
	})

	it("links: a task link opens that task, a URL is a link", () => {
		render(<TaskGraphPanel clineMessages={[board(gated)]} />)
		fireEvent.click(screen.getByText("Tasks"))
		fireEvent.click(screen.getByText("Ship"))
		expect(screen.getByRole("link", { name: "https://example.com/pr/1" })).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "T1" }))
		expect(screen.getByRole("button", { name: "src/a.ts" })).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }))
		expect(openFileRelativePath).toHaveBeenCalledWith({ value: "src/a.ts" })
	})

	it("draws the board in the Graph tab", () => {
		render(<TaskGraphPanel clineMessages={[board(gated, [["T2"]])]} />)
		fireEvent.click(screen.getByText("Tasks"))
		fireEvent.click(screen.getByRole("tab", { name: "Graph" }))
		const code = screen.getByTestId("mermaid").textContent ?? ""
		expect(code).toContain("flowchart TD")
		expect(code).toContain("T1 --> T2")
		expect(code).toContain("T1 -. discovered-from .-> T2")
		expect(code).toContain('{{"human:go"}}:::gate --> T2')
		expect(taskGraphMermaid(tasks)).toContain("subgraph T3_group")
	})

	it("starts from a saved plan", async () => {
		taskGraphAction.mockImplementation(async (request: { value: string }) => {
			const action = JSON.parse(request.value)
			if (action.op === "templates") {
				return { value: JSON.stringify({ ok: true, templates: [{ name: "Release", vars: ["version"], tasks: 3 }] }) }
			}
			return { value: JSON.stringify({ ok: true, lines: ['From the saved plan "Release".'] }) }
		})
		render(<TaskGraphPanel clineMessages={[board(gated)]} />)
		fireEvent.click(screen.getByText("Tasks"))
		fireEvent.click(screen.getByRole("button", { name: "Start from a saved plan…" }))
		await waitFor(() => expect(screen.getByRole("combobox", { name: "Saved plan to start from" })).toBeTruthy())
		fireEvent.change(screen.getByRole("textbox", { name: "Values for the plan" }), { target: { value: "version=2.0" } })
		fireEvent.click(screen.getByRole("button", { name: "Add to board" }))
		await waitFor(() => expect(sent().at(-1)).toEqual({ op: "template-use", name: "Release", vars: { version: "2.0" } }))
	})
})
