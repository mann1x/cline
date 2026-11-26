import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// jsdom cannot lay out a canvas; the graph it would draw is tested in board-viewer.test.ts.
vi.mock("./Canvas", () => ({
	Canvas: ({
		graph,
		onSelect,
		edit,
	}: {
		graph: { nodes: { id: string }[] }
		onSelect: (id: string) => void
		edit?: { onAdd: (type: string) => void; onConnect: (source: string, port: string | undefined, target: string) => void }
	}) => (
		<div data-testid="canvas">
			{graph.nodes.map((node) => (
				<button key={node.id} onClick={() => onSelect(node.id)} type="button">
					card {node.id}
				</button>
			))}
			{edit && (
				<button onClick={() => edit.onAdd("command")} type="button">
					palette command
				</button>
			)}
		</div>
	),
}))

const posted: unknown[] = []
vi.mock("@/config/platform.config", () => ({
	PLATFORM_CONFIG: { postMessage: (message: unknown) => posted.push(message) },
}))

import { BoardViewer } from "./BoardViewer"

const data = {
	workspace: "/home/me/game",
	boardText: JSON.stringify({
		layers: [["t1"]],
		tasks: [
			{
				id: "t1",
				title: "Run the release pipeline",
				status: "active",
				priority: "H",
				depends: [],
				openDepends: [],
				acceptance: [{ text: "tests pass", done: true }],
				later: false,
				files: [],
				notes: [],
				ready: false,
				blocked: false,
				claimedBy: "pipeline:release-1",
			},
		],
	}),
	pipelines: [
		{
			name: "release",
			slug: "release",
			path: "/home/me/game/.cerebriline/pipelines/release.pipeline.json",
			hash: "abc123",
			text: '{"name":"release"}',
			valid: true,
			errors: [],
			isApproved: true,
			definition: {
				name: "release",
				nodes: [
					{ id: "build", type: "command", command: "make" },
					{ id: "ship", type: "tool", tool: "publish", after: ["build"] },
				],
			},
		},
	],
	runs: [
		{
			id: "release-1",
			pipeline: "release",
			hash: "abc123",
			status: "failed",
			startedAt: 1_000,
			endedAt: 5_000,
			error: "ship failed",
			inputs: {},
			nodes: {
				build: { status: "done", attempts: 1, startedAt: 1_000, endedAt: 2_000, output: { items: [], port: "out" } },
				ship: { status: "failed", attempts: 2, startedAt: 2_000, endedAt: 5_000, error: "publish refused" },
			},
			events: [
				{ t: "run", ts: 1_000, run: "release-1", pipeline: "release", hash: "abc123", inputs: {} },
				{ t: "fail", ts: 5_000, node: "ship", error: "publish refused" },
			],
			eventCount: 2,
		},
	],
}

const send = (payload: object) =>
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "boardViewer/data", data: payload } }))
	})

/** The extension's answer to the last request of `type`. */
const answer = (type: string, payload: { ok: boolean; errors?: string[]; lines?: string[] }) => {
	const request = [...posted].reverse().find((message) => (message as { type?: string }).type === type) as
		| { id: number }
		| undefined
	if (!request) throw new Error(`nothing asked ${type}`)
	act(() => {
		window.dispatchEvent(new MessageEvent("message", { data: { type: "boardViewer/reply", id: request.id, ...payload } }))
	})
}
const sentOf = (type: string) => posted.filter((message) => (message as { type?: string }).type === type)

describe("the board viewer", () => {
	beforeEach(() => {
		posted.length = 0
	})

	it("asks for its data, then opens on the board with the task in the inspector", () => {
		render(<BoardViewer />)
		expect(posted).toEqual([{ type: "boardViewer/ready" }])
		expect(screen.getByText("Reading the workspace…")).toBeTruthy()
		send(data)
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Conversation board")
		fireEvent.click(screen.getByText("card t1"))
		const inspector = screen.getByRole("complementary", { name: "Inspector" })
		expect(inspector.textContent).toContain("Run the release pipeline")
		expect(inspector.textContent).toContain("tests pass")
		// A run's task leads to the run.
		fireEvent.click(screen.getByText("pipeline run release-1"))
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Run release-1")
	})

	it("shows a run's monitor, activity and report, and saves the report through the extension", () => {
		render(<BoardViewer />)
		send({ ...data, focus: { run: "release-1" } })
		fireEvent.click(screen.getByRole("tab", { name: "Run monitor" }))
		expect(screen.getAllByText("failed").length).toBeGreaterThan(0)
		expect(screen.getByText("×2")).toBeTruthy()
		fireEvent.click(screen.getByRole("tab", { name: "Activity" }))
		expect(screen.getAllByText("publish refused").length).toBeGreaterThan(0)
		fireEvent.click(screen.getByRole("tab", { name: "Report" }))
		expect(screen.getByText(/# Run release-1: failed/)).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Save…" }))
		expect(posted.at(-1)).toMatchObject({ type: "boardViewer/saveReport", name: "release-1" })
	})

	it("keeps what the person picked across a refresh, and opens a pipeline's file", () => {
		render(<BoardViewer />)
		send(data)
		fireEvent.click(
			screen.getAllByRole("button", { name: /release/ }).find((button) => button.textContent?.includes("approved"))!,
		)
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("release")
		send(data)
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("release")
		fireEvent.click(screen.getByRole("tab", { name: "Definition" }))
		fireEvent.click(screen.getByRole("button", { name: "Open file" }))
		expect(posted.at(-1)).toEqual({
			type: "boardViewer/openFile",
			path: "/home/me/game/.cerebriline/pipelines/release.pipeline.json",
		})
	})

	it("edits a pipeline as a draft, checked by the extension, and saves it from the version it started at", async () => {
		render(<BoardViewer />)
		send({ ...data, focus: { pipeline: "release" } })
		expect(screen.getByText(/approved/, { selector: ".bv-chip" })).toBeTruthy()
		fireEvent.click(screen.getByText("palette command"))
		expect(screen.getByText("card command")).toBeTruthy()
		expect(screen.getByText("unsaved edit")).toBeTruthy()
		const save = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement
		// Not before the extension has checked it.
		expect(save().disabled).toBe(true)
		await waitFor(() => expect(sentOf("boardViewer/validate")).toHaveLength(1))
		answer("boardViewer/validate", { ok: false, errors: ['node "command" runs after nothing it can reach'] })
		// The reply settles a promise: the bar shows it a tick later.
		expect(await screen.findByText('node "command" runs after nothing it can reach')).toBeTruthy()
		expect(save().disabled).toBe(true)
		// The new node is picked: its JSON is in the inspector, and a change goes to the draft.
		await waitFor(() => expect(screen.getByRole("textbox", { name: "command as JSON" })).toBeTruthy())
		fireEvent.change(screen.getByRole("textbox", { name: "command as JSON" }), {
			target: { value: JSON.stringify({ id: "notify", type: "command", command: "echo done", after: ["ship"] }) },
		})
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(screen.getByText("card notify")).toBeTruthy()
		await waitFor(() => expect(sentOf("boardViewer/validate")).toHaveLength(2))
		answer("boardViewer/validate", { ok: true, errors: [] })
		await waitFor(() => expect(save().disabled).toBe(false))
		fireEvent.click(save())
		expect(sentOf("boardViewer/save").at(-1)).toMatchObject({
			slug: "release",
			base: "abc123",
			definition: { nodes: [{ id: "build" }, { id: "ship" }, { id: "notify", after: ["ship"] }] },
		})
		answer("boardViewer/save", { ok: true })
		await waitFor(() => expect(screen.getByText("Saved and approved.")).toBeTruthy())
		expect(screen.queryByText("unsaved edit")).toBeNull()
	})

	it("shows a proposal against the approved version, and approves or rejects it for that version", async () => {
		const proposal = {
			...data.pipelines[0],
			hash: "def456",
			text: '{\n\t"name": "release",\n\t"step": "new"\n}\n',
			isApproved: false,
			approved: { hash: "abc123", by: "user", at: "2026-11-26T10:00:00.000Z" },
			author: "model",
			approvedText: '{\n\t"name": "release",\n\t"step": "old"\n}\n',
			versions: [
				{ hash: "def456", by: "model", at: "2026-11-26T11:00:00.000Z", base: "abc123" },
				{ hash: "abc123", by: "person", at: "2026-11-26T10:00:00.000Z" },
			],
		}
		render(<BoardViewer />)
		send({ ...data, pipelines: [proposal], focus: { pipeline: "release" } })
		expect(screen.getByText(/Version def456 by the model, against the approved abc123/)).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Changes" }))
		expect(screen.getByText(/"step": "old"/, { selector: '.bv-diff-line[data-kind="del"]' })).toBeTruthy()
		expect(screen.getByText(/"step": "new"/, { selector: '.bv-diff-line[data-kind="add"]' })).toBeTruthy()
		expect(screen.getByText("the model", { selector: "td" })).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Approve" }))
		expect(sentOf("boardViewer/approve").at(-1)).toMatchObject({ slug: "release", hash: "def456" })
		answer("boardViewer/approve", {
			ok: false,
			errors: ["The file changed to version 0001 while you looked: read it again first."],
		})
		await waitFor(() => expect(screen.getByText(/read it again first/)).toBeTruthy())
		fireEvent.click(screen.getByRole("button", { name: "Reject" }))
		expect(sentOf("boardViewer/reject").at(-1)).toMatchObject({ slug: "release", hash: "def456" })
	})

	it("saves the board as a pipeline, and changes a task from the inspector", async () => {
		render(<BoardViewer />)
		send(data)
		fireEvent.click(screen.getByRole("button", { name: "Save as a pipeline" }))
		expect(sentOf("boardViewer/boardToPipeline").at(-1)).toMatchObject({
			tasks: [{ id: "t1", title: "Run the release pipeline", acceptance: ["tests pass"], depends: [] }],
		})
		fireEvent.click(screen.getByText("card t1"))
		// A run holds this task: its status is the run's, not a button's.
		expect(screen.getByText("A pipeline run holds this task: its status is the run's.")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Done" })).toBeNull()
		fireEvent.change(screen.getByRole("textbox", { name: "New acceptance item" }), { target: { value: "docs updated" } })
		fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0] as HTMLElement)
		expect(sentOf("boardViewer/editTask").at(-1)).toMatchObject({
			updates: [{ id: "t1", acceptance_add: ["docs updated"] }],
		})
		answer("boardViewer/editTask", { ok: true, lines: ["T1: acceptance item added."] })
		await waitFor(() => expect(screen.getByText("T1: acceptance item added.")).toBeTruthy())
	})
})
