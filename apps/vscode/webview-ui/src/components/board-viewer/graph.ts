import { Graph, layout } from "@dagrejs/dagre"
import type { TaskGraphPanelSnapshot, TaskGraphPanelTask } from "@/components/chat/task-header/TaskGraphPanel"
import { nodePortsOf } from "./edit"
import { formatDuration, type ViewerPipelineDefinition, type ViewerPipelineNode, type ViewerRun } from "./model"

/**
 * One canvas for task boards and pipelines (plan section 9): both become
 * cards and edges here, laid out in columns left to right. Pure, so the
 * shapes are tested without a canvas.
 */

export type CardKind = "node" | "task" | "gate"

export interface CardData {
	kind: CardKind
	/** The node's or task's id, or the gate's spec. */
	ref: string
	title: string
	/** The node's type; "task" or "gate" otherwise. */
	type: string
	/** What it acts on: a tool, a command, an agent, a URL; who holds a task. */
	target?: string
	/** A status word the chip shows, or "" for a definition with no run. */
	status: string
	attempts?: number
	time?: string
	/** A priority, "later", "reused". */
	badge?: string
	/** For a gate: the task it guards. */
	task?: string
	/** A run's task: the run it stands for. */
	run?: string
	/** A node with several outputs: one handle each, so an edge can leave from one. */
	ports?: string[]
	[field: string]: unknown
}

export interface GraphNode {
	id: string
	data: CardData
	width: number
	height: number
}

/**
 * - done: the source finished and fed this edge
 * - active: done, and the target is running now
 * - untaken: the source fired another port
 * - failed / skipped: the source's own end
 * - pending: not reached yet
 * - idle: a definition with no run
 */
export type EdgeState = "done" | "active" | "untaken" | "failed" | "skipped" | "pending" | "idle"

export interface GraphEdge {
	id: string
	source: string
	target: string
	label?: string
	/** The source's output, when the source has several. */
	port?: string
	state: EdgeState
}

export interface ViewerGraph {
	nodes: GraphNode[]
	edges: GraphEdge[]
}

export const CARD_SIZE = { width: 232, height: 90 }
export const GATE_SIZE = { width: 168, height: 36 }

const clip = (text: string, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const str = (value: unknown) => (typeof value === "string" ? value : undefined)

/** What a node acts on, in a line. */
export function nodeTarget(node: ViewerPipelineNode): string | undefined {
	switch (node.type) {
		case "tool":
			return str(node.tool)
		case "command":
		case "check":
			return str(node.command) ?? str(node.when)
		case "agent":
			return str(node.agent) ? `agent ${node.agent}` : "spawn_agent"
		case "swarm":
			return "spawn_swarm"
		case "http":
			return str(node.url) ? `${str(node.method) ?? "GET"} ${node.url}` : undefined
		case "pipeline":
			return str(node.pipeline)
		case "if":
			return str(node.when)
		case "switch":
			return str(node.on)
		case "wait":
			return str(node.gate)
		case "approval":
			return str(node.message)
		case "loop": {
			const body = node.body as { type?: unknown } | undefined
			return [str(node.over) && `over ${node.over}`, str(body?.type)].filter(Boolean).join(" → ") || undefined
		}
		case "merge":
			return str(node.mode)
		case "set":
			return node.fields && typeof node.fields === "object" ? Object.keys(node.fields).join(", ") : str(node.items)
		default:
			return undefined
	}
}

/** `"x.true"` → node x, port true; a bare id is the default port. */
function parseRef(ref: string): { node: string; port: string } {
	const at = ref.indexOf(".")
	return at < 0 ? { node: ref.trim(), port: "out" } : { node: ref.slice(0, at).trim(), port: ref.slice(at + 1).trim() }
}

/** A pipeline's nodes and `after` edges; with a run, its states on both. */
export function pipelineGraph(definition: ViewerPipelineDefinition | undefined, run?: ViewerRun): ViewerGraph {
	const nodes: GraphNode[] = []
	const edges: GraphEdge[] = []
	const list = Array.isArray(definition?.nodes) ? definition.nodes : []
	const ids = new Set(list.map((node) => node.id))
	for (const node of list) {
		if (typeof node?.id !== "string") continue
		const state = run?.nodes[node.id]
		const status = state ? (state.waitingOn ? "waiting" : state.status) : run ? "pending" : ""
		const time =
			state?.startedAt !== undefined && state.endedAt !== undefined
				? formatDuration(state.endedAt - state.startedAt)
				: undefined
		const target = nodeTarget(node)
		const ports = nodePortsOf(node)
		nodes.push({
			id: node.id,
			...CARD_SIZE,
			data: {
				kind: "node",
				ref: node.id,
				title: str(node.name) ?? node.id,
				type: node.type,
				...(target ? { target: clip(target) } : {}),
				status,
				...(state && state.attempts > 1 ? { attempts: state.attempts } : {}),
				...(time ? { time } : {}),
				...(state?.reused ? { badge: "reused" } : {}),
				...(ports.length > 1 ? { ports } : {}),
			},
		})
		const after = Array.isArray(node.after) ? node.after : []
		for (const ref of after) {
			if (typeof ref !== "string") continue
			const { node: source, port } = parseRef(ref)
			if (!ids.has(source)) continue
			edges.push({
				id: `${ref}->${node.id}`,
				source,
				target: node.id,
				...(port !== "out" ? { label: port } : {}),
				port,
				state: edgeState(run, source, port, node.id),
			})
		}
	}
	return { nodes, edges }
}

function edgeState(run: ViewerRun | undefined, source: string, port: string, target: string): EdgeState {
	if (!run) return "idle"
	const from = run.nodes[source]
	switch (from?.status) {
		case "done":
			if (from.output?.port && from.output.port !== port) return "untaken"
			return run.nodes[target]?.status === "running" ? "active" : "done"
		case "failed":
			return "failed"
		case "skipped":
			return "skipped"
		default:
			return "pending"
	}
}

/** A task's word for the chip: a pending task is ready or blocked. */
export function taskStatus(task: TaskGraphPanelTask): string {
	if (task.status !== "pending") return task.status
	if (task.blocked) return "blocked"
	return task.ready ? "ready" : "pending"
}

/** The board's tasks and dependencies, gates as small nodes feeding their task. */
export function boardGraph(board: TaskGraphPanelSnapshot | undefined): ViewerGraph {
	const nodes: GraphNode[] = []
	const edges: GraphEdge[] = []
	if (!board) return { nodes, edges }
	const byId = new Map(board.tasks.map((task) => [task.id, task]))
	for (const task of board.tasks) {
		const run = task.claimedBy?.startsWith("pipeline:") ? task.claimedBy.slice("pipeline:".length) : undefined
		nodes.push({
			id: task.id,
			...CARD_SIZE,
			data: {
				kind: "task",
				ref: task.id,
				title: task.title,
				type: "task",
				...(task.claimedBy ? { target: clip(task.claimedBy) } : task.files[0] ? { target: clip(task.files[0]) } : {}),
				status: taskStatus(task),
				badge: task.later ? "later" : task.priority,
				...(run ? { run } : {}),
			},
		})
		for (const dep of task.depends) {
			const from = byId.get(dep)
			if (!from) continue
			edges.push({
				id: `${dep}->${task.id}`,
				source: dep,
				target: task.id,
				state:
					from.status === "done"
						? task.status === "active"
							? "active"
							: "done"
						: from.status === "cancelled"
							? "skipped"
							: "pending",
			})
		}
		;(task.gates ?? []).forEach((gate, index) => {
			const id = `gate:${task.id}:${index}`
			nodes.push({
				id,
				...GATE_SIZE,
				data: {
					kind: "gate",
					ref: gate.spec,
					title: clip(gate.spec, 28),
					type: "gate",
					status: gate.open ? "open" : gate.failed ? "failed" : "waiting",
					task: task.id,
				},
			})
			edges.push({
				id: `${id}->${task.id}`,
				source: id,
				target: task.id,
				state: gate.open ? "done" : gate.failed ? "failed" : "pending",
			})
		})
	}
	return { nodes, edges }
}

/** Top-left positions, columns left to right: a node after its sources. */
export function layoutGraph(graph: ViewerGraph): Record<string, { x: number; y: number }> {
	const g = new Graph()
	g.setGraph({ rankdir: "LR", nodesep: 18, ranksep: 64, marginx: 16, marginy: 16 })
	g.setDefaultEdgeLabel(() => ({}))
	for (const node of graph.nodes) {
		g.setNode(node.id, { width: node.width, height: node.height })
	}
	for (const edge of graph.edges) {
		g.setEdge(edge.source, edge.target)
	}
	layout(g)
	const positions: Record<string, { x: number; y: number }> = {}
	for (const node of graph.nodes) {
		const placed = g.node(node.id) as { x: number; y: number } | undefined
		positions[node.id] = placed ? { x: placed.x - node.width / 2, y: placed.y - node.height / 2 } : { x: 0, y: 0 }
	}
	return positions
}
