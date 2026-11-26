import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

// jsdom cannot lay out a canvas; the graph it would draw is tested in board-viewer.test.ts.
vi.mock("./Canvas", () => ({
	Canvas: ({ graph, onSelect }: { graph: { nodes: { id: string }[] }; onSelect: (id: string) => void }) => (
		<div data-testid="canvas">
			{graph.nodes.map((node) => (
				<button key={node.id} onClick={() => onSelect(node.id)} type="button">
					card {node.id}
				</button>
			))}
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
})
