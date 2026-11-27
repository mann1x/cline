import {
	Background,
	Controls,
	type Edge,
	Handle,
	MarkerType,
	MiniMap,
	type Node,
	type NodeProps,
	Panel,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
} from "@xyflow/react"
import "@xyflow/react/dist/style.css"
import { type DragEvent, type KeyboardEvent, memo, useEffect, useMemo, useState } from "react"
import { PALETTE_TYPES } from "./edit"
import { type CardData, type EdgeState, layoutGraph, type ViewerGraph } from "./graph"

type CardNode = Node<CardData, "card">
type GateNode = Node<CardData, "gate">

const Chip = ({ status }: { status: string }) =>
	status ? (
		<span className="bv-chip" data-status={status}>
			{status}
		</span>
	) : null

/** Where a node's output handles sit down its right side: evenly, one per output. */
const portTop = (index: number, count: number) => `${((index + 1) / (count + 1)) * 100}%`

const Card = memo(({ data }: NodeProps<CardNode>) => (
	<div
		className="bv-card"
		data-kind={data.kind}
		data-status={data.status}
		title={data.target ? `${data.title}\n${data.target}` : data.title}>
		<Handle position={Position.Left} type="target" />
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
		{data.ports ? (
			data.ports.map((port, index, all) => (
				<Handle
					id={port}
					key={port}
					position={Position.Right}
					style={{ top: portTop(index, all.length) }}
					title={port}
					type="source">
					<span className="bv-port-label">{port}</span>
				</Handle>
			))
		) : (
			<Handle position={Position.Right} type="source" />
		)}
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
	/** A pipeline the person can edit: wiring, deleting and the palette (phase 4). */
	edit?: CanvasEdit
}

export interface CanvasEdit {
	/** The cards it edits: a pipeline's nodes (the default), or a board's tasks. */
	kind?: "node" | "task"
	/** The palette's add; none on a board, whose tasks are added from the bar above. */
	onAdd?: (type: string) => void
	onConnect: (source: string, port: string | undefined, target: string) => void
	onDeleteNode: (id: string) => void
	onDeleteEdge: (id: string) => void
}

const DRAG_TYPE = "application/x-cerebriline-node"

function Flow({ graph, selected, onSelect, fitKey, edit }: CanvasProps) {
	const [picked, setPicked] = useState<string>()
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
				connectable: !!edit && node.data.kind === (edit.kind ?? "node"),
			})),
		[graph, positions, selected, edit],
	)
	const ported = useMemo(() => new Set(graph.nodes.filter((node) => node.data.ports).map((node) => node.id)), [graph])
	const edges = useMemo<Edge[]>(
		() =>
			graph.edges.map((edge) => ({
				id: edge.id,
				source: edge.source,
				target: edge.target,
				...(ported.has(edge.source) && edge.port ? { sourceHandle: edge.port } : {}),
				selected: edge.id === picked,
				// A card with several outputs names them beside their handles.
				...(edge.label && !ported.has(edge.source) ? { label: edge.label } : {}),
				animated: edge.state === "active",
				focusable: false,
				markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
				style: {
					stroke: EDGE_STROKE[edge.state],
					strokeWidth: edge.state === "done" || edge.state === "active" ? 1.6 : 1.2,
					...(EDGE_DASH[edge.state] ? { strokeDasharray: EDGE_DASH[edge.state] } : {}),
					...(edge.state === "untaken" ? { opacity: 0.5 } : {}),
					...(edge.id === picked ? { stroke: "var(--bv-accent)", strokeWidth: 2.4 } : {}),
				},
			})),
		[graph, ported, picked],
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

	// An edge picked on another graph is not this one's.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the shown graph changes
	useEffect(() => setPicked(undefined), [fitKey])

	const editableCard = (id: string) =>
		!!edit && graph.nodes.some((node) => node.id === id && node.data.kind === (edit.kind ?? "node"))
	const remove = () => {
		if (!edit) return
		if (picked) {
			edit.onDeleteEdge(picked)
			setPicked(undefined)
		} else if (selected && editableCard(selected)) {
			edit.onDeleteNode(selected)
			onSelect(undefined)
		}
	}
	const onKeyDown = (event: KeyboardEvent) => {
		// Typing in the palette's buttons or an input is not a delete.
		if (!edit || (event.key !== "Delete" && event.key !== "Backspace")) return
		const target = event.target as HTMLElement
		if (target.closest("input, textarea, select")) return
		event.preventDefault()
		remove()
	}
	const onDrop = (event: DragEvent) => {
		const type = event.dataTransfer.getData(DRAG_TYPE)
		if (!edit?.onAdd || !type) return
		event.preventDefault()
		edit.onAdd(type)
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: the canvas's delete key and drop target; xyflow's pane is the focusable part
		<div className="bv-flow" onDragOver={(event) => edit && event.preventDefault()} onDrop={onDrop} onKeyDown={onKeyDown}>
			<ReactFlow
				attributionPosition="top-right"
				colorMode={colorMode()}
				deleteKeyCode={null}
				edges={edges}
				edgesFocusable={!!edit}
				elementsSelectable
				fitView
				fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
				maxZoom={2}
				minZoom={0.15}
				nodes={nodes}
				nodesConnectable={!!edit}
				nodesDraggable={false}
				nodeTypes={nodeTypes}
				onConnect={(connection) =>
					edit?.onConnect(connection.source, connection.sourceHandle ?? undefined, connection.target)
				}
				onEdgeClick={(_, clicked) => {
					if (!edit) return
					setPicked(clicked.id)
					onSelect(undefined)
				}}
				onNodeClick={(_, node) => {
					setPicked(undefined)
					onSelect(node.id)
				}}
				onPaneClick={() => {
					setPicked(undefined)
					onSelect(undefined)
				}}>
				<Background gap={20} size={1} />
				<Controls position="bottom-left" showInteractive={false} />
				<MiniMap pannable position="bottom-right" zoomable />
				{edit && (
					<Panel className="bv-palette" position="top-left">
						{edit.onAdd && <span className="bv-palette-label">Add</span>}
						{(edit.onAdd ? PALETTE_TYPES : []).map((type) => (
							<button
								className="bv-palette-item"
								draggable
								key={type}
								onClick={() => edit.onAdd?.(type)}
								onDragStart={(event) => {
									event.dataTransfer.setData(DRAG_TYPE, type)
									event.dataTransfer.effectAllowed = "copy"
								}}
								title={selected ? `Add a ${type} node after ${selected}` : `Add a ${type} node`}
								type="button">
								{type}
							</button>
						))}
						{!edit.onAdd && !picked && !(selected && editableCard(selected)) && (
							<span className="bv-palette-label bv-palette-hint">
								Drag from a task to another: the second waits on the first
							</span>
						)}
						{(picked || (selected && editableCard(selected))) && (
							<button className="bv-palette-item bv-palette-delete" onClick={remove} type="button">
								{picked ? "Delete edge" : `Delete ${selected}`}
							</button>
						)}
					</Panel>
				)}
			</ReactFlow>
		</div>
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
