import {
	Background,
	Controls,
	type Edge,
	Handle,
	MarkerType,
	MiniMap,
	type Node,
	type NodeProps,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { memo, useEffect, useMemo } from "react"
import { type CardData, type EdgeState, layoutGraph, type ViewerGraph } from "./graph"

type CardNode = Node<CardData, "card">
type GateNode = Node<CardData, "gate">

const Chip = ({ status }: { status: string }) =>
	status ? (
		<span className="bv-chip" data-status={status}>
			{status}
		</span>
	) : null

const Card = memo(({ data }: NodeProps<CardNode>) => (
	<div
		className="bv-card"
		data-kind={data.kind}
		data-status={data.status}
		title={data.target ? `${data.title}\n${data.target}` : data.title}>
		<Handle isConnectable={false} position={Position.Left} type="target" />
		<div className="bv-card-head">
			<span className="bv-card-type">{data.kind === "task" ? data.ref : data.type}</span>
			<Chip status={data.status} />
		</div>
		<div className="bv-card-title">{data.title}</div>
		<div className="bv-card-target">{data.target ?? " "}</div>
		<div className="bv-card-foot">
			{data.badge && <span className="bv-badge">{data.badge}</span>}
			{data.attempts !== undefined && <span>×{data.attempts}</span>}
			{data.time && <span>{data.time}</span>}
		</div>
		<Handle isConnectable={false} position={Position.Right} type="source" />
	</div>
))

const Gate = memo(({ data }: NodeProps<GateNode>) => (
	<div className="bv-gate" data-status={data.status} title={`${data.ref} (${data.status})`}>
		<Handle isConnectable={false} position={Position.Left} type="target" />
		<span aria-hidden className={`codicon codicon-${data.status === "open" ? "unlock" : "lock"}`} />
		<span className="bv-gate-text">{data.title}</span>
		<Handle isConnectable={false} position={Position.Right} type="source" />
	</div>
))

// Stable across renders: xyflow warns and re-mounts every node otherwise.
const nodeTypes = { card: Card, gate: Gate }

const EDGE_STROKE: Record<EdgeState, string> = {
	done: "var(--bv-done)",
	active: "var(--bv-running)",
	failed: "var(--bv-failed)",
	untaken: "var(--bv-idle)",
	skipped: "var(--bv-idle)",
	pending: "var(--bv-idle)",
	idle: "var(--bv-idle)",
}

const EDGE_DASH: Partial<Record<EdgeState, string>> = { pending: "5 4", untaken: "2 4", skipped: "2 4" }

/** The theme's kind, for xyflow's own controls. */
function colorMode(): "light" | "dark" {
	const classes = typeof document !== "undefined" ? document.body.classList : undefined
	return classes?.contains("vscode-light") || classes?.contains("vscode-high-contrast-light") ? "light" : "dark"
}

export interface CanvasProps {
	graph: ViewerGraph
	selected?: string
	onSelect: (id: string | undefined) => void
	/** Changes when a different graph is shown, so the view fits it again. */
	fitKey: string
}

function Flow({ graph, selected, onSelect, fitKey }: CanvasProps) {
	const positions = useMemo(() => layoutGraph(graph), [graph])
	const nodes = useMemo<Node<CardData>[]>(
		() =>
			graph.nodes.map((node) => ({
				id: node.id,
				type: node.data.kind === "gate" ? "gate" : "card",
				position: positions[node.id] ?? { x: 0, y: 0 },
				data: node.data,
				width: node.width,
				height: node.height,
				selected: node.id === selected,
				draggable: false,
				connectable: false,
			})),
		[graph, positions, selected],
	)
	const edges = useMemo<Edge[]>(
		() =>
			graph.edges.map((edge) => ({
				id: edge.id,
				source: edge.source,
				target: edge.target,
				...(edge.label ? { label: edge.label } : {}),
				animated: edge.state === "active",
				focusable: false,
				markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
				style: {
					stroke: EDGE_STROKE[edge.state],
					strokeWidth: edge.state === "done" || edge.state === "active" ? 1.6 : 1.2,
					...(EDGE_DASH[edge.state] ? { strokeDasharray: EDGE_DASH[edge.state] } : {}),
					...(edge.state === "untaken" ? { opacity: 0.5 } : {}),
				},
			})),
		[graph],
	)
	const flow = useReactFlow()
	// A new graph, or the inspector opening or closing beside it, is fitted
	// again; a refresh of the same one keeps the view. The wait lets xyflow
	// measure the resized pane first: a fit in the next frame used the old width.
	// biome-ignore lint/correctness/useExhaustiveDependencies: refit only when the shown graph changes
	useEffect(() => {
		const timer = setTimeout(() => void flow.fitView({ padding: 0.15, maxZoom: 1.1, duration: 150 }), 80)
		return () => clearTimeout(timer)
	}, [fitKey])

	return (
		<ReactFlow
			attributionPosition="top-right"
			colorMode={colorMode()}
			edges={edges}
			edgesFocusable={false}
			elementsSelectable
			fitView
			fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
			maxZoom={2}
			minZoom={0.15}
			nodes={nodes}
			nodesConnectable={false}
			nodesDraggable={false}
			nodeTypes={nodeTypes}
			onNodeClick={(_, node) => onSelect(node.id)}
			onPaneClick={() => onSelect(undefined)}>
			<Background gap={20} size={1} />
			<Controls position="bottom-left" showInteractive={false} />
			<MiniMap pannable position="bottom-right" zoomable />
		</ReactFlow>
	)
}

export function Canvas(props: CanvasProps) {
	return (
		<div className="bv-canvas">
			<ReactFlowProvider>
				<Flow {...props} />
			</ReactFlowProvider>
		</div>
	)
}
