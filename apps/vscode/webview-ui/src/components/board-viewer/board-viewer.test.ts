import { describe, expect, it } from "vitest"
import type { TaskGraphPanelTask } from "@/components/chat/task-header/TaskGraphPanel"
import { boardGraph, layoutGraph, nodeTarget, pipelineGraph } from "./graph"
import {
	formatDuration,
	initialSource,
	readBoard,
	readViewerMessage,
	runBelongsTo,
	type ViewerPipeline,
	type ViewerPipelineDefinition,
	type ViewerRun,
} from "./model"
import { eventSummary, runReport } from "./report"

const definition: ViewerPipelineDefinition = {
	name: "release",
	nodes: [
		{ id: "build", type: "command", command: "bun run build" },
		{ id: "ok", type: "if", after: ["build"], when: "$node.build.exit == 0" },
		{ id: "ship", type: "tool", after: ["ok.true"], tool: "publish" },
		{ id: "tell", type: "agent", after: ["ok.false"], task: "explain", agent: "reviewer" },
		{ id: "lint", type: "check", after: ["build"], command: "bun run lint" },
	],
}

const run = (over: Partial<ViewerRun> = {}): ViewerRun => ({
	id: "release-3",
	pipeline: "release",
	hash: "abc123",
	status: "running",
	startedAt: 1_000,
	inputs: {},
	nodes: {
		build: { status: "done", attempts: 1, startedAt: 1_000, endedAt: 3_500, output: { items: [{}], port: "out", exit: 0 } },
		ok: { status: "done", attempts: 1, startedAt: 3_500, endedAt: 3_510, output: { items: [{}], port: "true" } },
		ship: { status: "running", attempts: 2, startedAt: 3_600, lastError: "timeout" },
		lint: { status: "failed", attempts: 3, startedAt: 3_520, endedAt: 9_000, error: "lint failed: exited 1" },
	},
	events: [],
	eventCount: 0,
	...over,
})

const task = (over: Partial<TaskGraphPanelTask> & { id: string }): TaskGraphPanelTask => ({
	title: over.id,
	status: "pending",
	priority: "M",
	depends: [],
	openDepends: [],
	acceptance: [],
	later: false,
	files: [],
	notes: [],
	ready: false,
	blocked: false,
	...over,
})

describe("a pipeline on the canvas", () => {
	it("draws every node and an edge per `after`, labelling the branch it hangs from", () => {
		const graph = pipelineGraph(definition)
		expect(graph.nodes.map((node) => node.id)).toEqual(["build", "ok", "ship", "tell", "lint"])
		expect(graph.edges.map((edge) => [edge.source, edge.target, edge.label ?? ""])).toEqual([
			["build", "ok", ""],
			["ok", "ship", "true"],
			["ok", "tell", "false"],
			["build", "lint", ""],
		])
		// No run: no status, edges idle.
		expect(graph.nodes.every((node) => node.data.status === "")).toBe(true)
		expect(new Set(graph.edges.map((edge) => edge.state))).toEqual(new Set(["idle"]))
	})

	it("colours a run: the branch not taken, the edge into a running node, a failure", () => {
		const graph = pipelineGraph(definition, run())
		const edge = (id: string) => graph.edges.find((candidate) => candidate.id === id)?.state
		expect(edge("ok.true->ship")).toBe("active")
		expect(edge("ok.false->tell")).toBe("untaken")
		expect(edge("build->ok")).toBe("done")
		const card = (id: string) => graph.nodes.find((node) => node.id === id)?.data
		expect(card("ship")).toMatchObject({ status: "running", attempts: 2, target: "publish" })
		expect(card("tell")).toMatchObject({ status: "pending", target: "agent reviewer" })
		expect(card("build")).toMatchObject({ status: "done", time: "2.5 s" })
		expect(card("lint")?.attempts).toBe(3)
	})

	it("ignores an `after` naming a node that is not there", () => {
		const graph = pipelineGraph({ name: "x", nodes: [{ id: "a", type: "set", after: ["ghost"] }] })
		expect(graph.edges).toEqual([])
	})

	it("says what each kind of node acts on", () => {
		expect(nodeTarget({ id: "h", type: "http", url: "https://x.test/a", method: "POST" })).toBe("POST https://x.test/a")
		expect(nodeTarget({ id: "s", type: "swarm" })).toBe("spawn_swarm")
		expect(nodeTarget({ id: "a", type: "agent" })).toBe("spawn_agent")
		expect(nodeTarget({ id: "l", type: "loop", over: "$items", body: { type: "tool" } })).toBe("over $items → tool")
		expect(nodeTarget({ id: "w", type: "wait", gate: "timer:+5m" })).toBe("timer:+5m")
	})

	it("lays columns out left to right: a node after its source", () => {
		const graph = pipelineGraph(definition)
		const at = layoutGraph(graph)
		expect(at.ok.x).toBeGreaterThan(at.build.x)
		expect(at.ship.x).toBeGreaterThan(at.ok.x)
		// Two nodes in one column do not overlap.
		expect(Math.abs(at.ship.y - at.tell.y)).toBeGreaterThanOrEqual(84)
	})
})

describe("a board on the canvas", () => {
	const board = {
		layers: [["t1"], ["t2", "t3"]],
		tasks: [
			task({ id: "t1", title: "Plan", status: "done" }),
			task({
				id: "t2",
				title: "Build",
				status: "active",
				depends: ["t1"],
				claimedBy: "pipeline:release-3",
			}),
			task({
				id: "t3",
				title: "Ship",
				depends: ["t1"],
				blocked: true,
				gates: [
					{ spec: "human:approve the release", open: false },
					{ spec: "timer:+30m", open: true },
				],
			}),
		],
	}

	it("draws tasks, their dependencies, and gates as small nodes feeding their task", () => {
		const graph = boardGraph(board)
		expect(graph.nodes.map((node) => [node.id, node.data.kind, node.data.status])).toEqual([
			["t1", "task", "done"],
			["t2", "task", "active"],
			["t3", "task", "blocked"],
			["gate:t3:0", "gate", "waiting"],
			["gate:t3:1", "gate", "open"],
		])
		expect(graph.edges.map((edge) => [edge.id, edge.state])).toEqual([
			["t1->t2", "active"],
			["t1->t3", "done"],
			["gate:t3:0->t3", "pending"],
			["gate:t3:1->t3", "done"],
		])
		expect(graph.nodes[1].data.run).toBe("release-3")
	})

	it("is empty without a board", () => {
		expect(boardGraph(undefined)).toEqual({ nodes: [], edges: [] })
	})
})

describe("the panel's message", () => {
	it("reads ours, refuses others, and keeps going on a damaged run", () => {
		expect(readViewerMessage({ type: "state", data: {} })).toBeUndefined()
		expect(readViewerMessage(null)).toBeUndefined()
		const data = readViewerMessage({
			type: "boardViewer/data",
			data: {
				workspace: "/w",
				boardText:
					'{"tasks":[{"id":"t1","title":"A","status":"pending","depends":[],"openDepends":[]}],"layers":[["t1"]]}',
				pipelines: [{ slug: "release", name: "release" }, { nope: true }],
				runs: [{ id: "release-1", nodes: "garbage" }, { id: 4 }],
			},
		})
		expect(data?.pipelines.map((pipeline) => pipeline.slug)).toEqual(["release"])
		expect(data?.pipelines[0].errors).toEqual([])
		expect(data?.runs).toHaveLength(1)
		expect(data?.runs[0]).toMatchObject({ nodes: {}, events: [], inputs: {}, eventCount: 0 })
		expect(readBoard(data)?.tasks.map((entry) => entry.id)).toEqual(["t1"])
	})

	it("opens on its focus, else the board, else the newest run", () => {
		const base = { workspace: "/w", pipelines: [{ slug: "release" } as ViewerPipeline], runs: [run()] }
		expect(initialSource({ ...base, focus: { run: "release-3" } })).toEqual({ kind: "run", id: "release-3" })
		expect(initialSource({ ...base, focus: { pipeline: "release" } })).toEqual({ kind: "pipeline", slug: "release" })
		expect(initialSource({ ...base, focus: { pipeline: "gone" } })).toEqual({ kind: "run", id: "release-3" })
		expect(initialSource({ ...base, boardText: "{}" })).toEqual({ kind: "board" })
		expect(initialSource({ workspace: "/w", pipelines: [], runs: [] })).toBeUndefined()
	})

	it("matches a run, and a test run, to its pipeline", () => {
		const pipeline = { slug: "release", name: "Release" } as ViewerPipeline
		expect(runBelongsTo(run(), pipeline)).toBe(true)
		expect(runBelongsTo(run({ pipeline: "release-test" }), pipeline)).toBe(true)
		expect(runBelongsTo(run({ pipeline: "other" }), pipeline)).toBe(false)
	})

	it("formats durations", () => {
		expect(formatDuration(840)).toBe("840 ms")
		expect(formatDuration(12_400)).toBe("12.4 s")
		expect(formatDuration(185_000)).toBe("3 m 05 s")
		expect(formatDuration(3_720_000)).toBe("1 h 02 m")
		expect(formatDuration(undefined)).toBe("")
	})
})

describe("a run's report", () => {
	it("lists the nodes in definition order, the failures, and what checks and agents found", () => {
		const report = runReport(
			run({
				status: "failed",
				endedAt: 9_000,
				error: "lint failed",
				from: "release-2",
				nodes: {
					...run().nodes,
					tell: {
						status: "done",
						attempts: 1,
						output: { items: [], port: "out", text: "The build | broke\non line 4" },
					},
				},
			}),
			definition,
		)
		expect(report).toContain("# Run release-3: failed")
		expect(report).toContain("- Re-run of release-2")
		expect(report.indexOf("| build |")).toBeLessThan(report.indexOf("| lint |"))
		expect(report).toContain("| ok | if | done | 1 | 10 ms | 1 item on true |")
		expect(report).toContain("- **lint** (after 3 attempts): lint failed: exited 1")
		expect(report).toContain("- agent **tell** answered: The build | broke on line 4")
		expect(report).toContain("| tell | agent | done |")
	})

	it("puts journal events in words", () => {
		expect(eventSummary({ t: "retry", ts: 1, node: "a", attempt: 2, error: "boom", wait: 2 })).toBe(
			"attempt 2 failed: boom; again in 2 s",
		)
		expect(eventSummary({ t: "end", ts: 1, node: "a", output: { items: [1, 2], port: "false" }, reused: "r-1" })).toBe(
			"2 items on false, reused from r-1",
		)
		expect(eventSummary({ t: "wait", ts: 1, node: "a", on: "human:ok" })).toBe("waiting on human:ok")
		expect(eventSummary({ t: "done", ts: 1, status: "failed", error: "x" })).toBe("failed: x")
	})
})
