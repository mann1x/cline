import { useCallback, useEffect, useMemo, useState } from "react"
import { PLATFORM_CONFIG } from "@/config/platform.config"
import "./board-viewer.css"
import { Canvas } from "./Canvas"
import { boardGraph, pipelineGraph, type ViewerGraph } from "./graph"
import { Inspector, type InspectorSubject } from "./Inspector"
import {
	initialSource,
	readBoard,
	readViewerMessage,
	runBelongsTo,
	type ViewerData,
	type ViewerPipeline,
	type ViewerPipelineDefinition,
	type ViewerRequest,
	type ViewerRun,
	type ViewerSource,
} from "./model"
import { ActivityPane, DefinitionPane, PlanPane, ReportPane, RunMonitorPane, RunsPane } from "./Panes"

/**
 * The board viewer (pipelines plan phase 3): the conversation's board, the
 * workspace's pipelines and their runs, on one canvas, in an editor-area
 * panel. Read-only: editing and approval in the panel are phase 4.
 */

type Tab = "workflow" | "plan" | "definition" | "runs" | "monitor" | "activity" | "report"

const TAB_LABEL: Record<Tab, string> = {
	workflow: "Workflow",
	plan: "Plan",
	definition: "Definition",
	runs: "Runs",
	monitor: "Run monitor",
	activity: "Activity",
	report: "Report",
}

const TABS: Record<ViewerSource["kind"], Tab[]> = {
	board: ["workflow", "plan"],
	pipeline: ["workflow", "definition", "runs"],
	run: ["workflow", "monitor", "activity", "report", "definition"],
}

/** Tabs the inspector sits beside: the ones where a card can be picked. */
const INSPECTOR_TABS = new Set<Tab>(["workflow", "plan", "monitor"])

const post = (request: ViewerRequest) => PLATFORM_CONFIG.postMessage(request)

const sourceKey = (source: ViewerSource | undefined) =>
	!source ? "" : source.kind === "board" ? "board" : source.kind === "pipeline" ? `pipeline:${source.slug}` : `run:${source.id}`

const parseKey = (key: string): ViewerSource | undefined => {
	if (key === "board") return { kind: "board" }
	if (key.startsWith("pipeline:")) return { kind: "pipeline", slug: key.slice("pipeline:".length) }
	if (key.startsWith("run:")) return { kind: "run", id: key.slice("run:".length) }
	return undefined
}

function exists(data: ViewerData, source: ViewerSource): boolean {
	switch (source.kind) {
		case "board":
			return true
		case "pipeline":
			return data.pipelines.some((pipeline) => pipeline.slug === source.slug)
		case "run":
			return data.runs.some((run) => run.id === source.id)
	}
}

const ago = (ts: number | undefined) => {
	if (ts === undefined) return ""
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
	if (s < 60) return "just now"
	if (s < 3600) return `${Math.floor(s / 60)} min ago`
	if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
	return `${Math.floor(s / 86_400)} d ago`
}

export function BoardViewer() {
	const [data, setData] = useState<ViewerData>()
	const [source, setSource] = useState<ViewerSource>()
	const [tabs, setTabs] = useState<Partial<Record<ViewerSource["kind"], Tab>>>({})
	const [selected, setSelected] = useState<string>()

	const show = useCallback((next: ViewerSource | undefined) => {
		setSource(next)
		setSelected(undefined)
	}, [])

	useEffect(() => {
		const receive = (event: MessageEvent) => {
			const next = readViewerMessage(event.data)
			if (!next) return
			setData(next)
			if (next.focus) {
				show(initialSource(next))
				return
			}
			setSource((current) => (current && exists(next, current) ? current : initialSource(next)))
		}
		window.addEventListener("message", receive)
		post({ type: "boardViewer/ready" })
		return () => window.removeEventListener("message", receive)
	}, [show])

	const board = useMemo(() => readBoard(data), [data])
	const pipeline = source?.kind === "pipeline" ? data?.pipelines.find((candidate) => candidate.slug === source.slug) : undefined
	const run = source?.kind === "run" ? data?.runs.find((candidate) => candidate.id === source.id) : undefined
	const runPipeline = run ? data?.pipelines.find((candidate) => runBelongsTo(run, candidate)) : undefined
	const definition = run ? (run.definition ?? runPipeline?.definition) : pipeline?.definition
	const pipelineRuns = useMemo(
		() => (pipeline && data ? data.runs.filter((candidate) => runBelongsTo(candidate, pipeline)) : []),
		[data, pipeline],
	)

	const graph: ViewerGraph = useMemo(() => {
		if (source?.kind === "board") return boardGraph(board)
		if (source?.kind === "pipeline") return pipelineGraph(pipeline?.definition)
		if (source?.kind === "run") return pipelineGraph(definition, run)
		return { nodes: [], edges: [] }
	}, [source, board, pipeline, definition, run])

	const subject: InspectorSubject | undefined = useMemo(() => {
		if (!selected) return undefined
		if (source?.kind === "board") {
			const card = graph.nodes.find((node) => node.id === selected)?.data
			if (card?.kind === "gate") {
				return { kind: "gate", spec: card.ref, status: card.status, task: card.task ?? "" }
			}
			const task = board?.tasks.find((candidate) => candidate.id === selected)
			return task ? { kind: "task", task } : undefined
		}
		const node = definition?.nodes.find((candidate) => candidate.id === selected)
		const state = run?.nodes[selected]
		if (!node && !state) return undefined
		return {
			kind: "node",
			id: selected,
			...(node ? { node } : {}),
			...(state ? { state } : {}),
			events: run ? run.events.filter((event) => event.node === selected) : [],
			...(run?.startedAt !== undefined ? { runStart: run.startedAt } : {}),
		}
	}, [selected, source, graph, board, definition, run])

	const kind = source?.kind
	const tabList = kind ? TABS[kind] : []
	const tab: Tab = (kind && tabs[kind] && tabList.includes(tabs[kind] as Tab) ? tabs[kind] : tabList[0]) ?? "workflow"
	const openRun = (id: string) => show({ kind: "run", id })
	const withInspector = !!subject && INSPECTOR_TABS.has(tab)

	const title =
		kind === "board"
			? "Conversation board"
			: kind === "pipeline"
				? (pipeline?.name ?? "Pipeline")
				: kind === "run"
					? `Run ${run?.id ?? ""}`
					: "Board"
	const workspaceName = data?.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? ""
	const subtitle = [
		run ? `${run.pipeline} · ${run.status}` : undefined,
		pipeline ? (pipeline.isApproved ? `approved, version ${pipeline.hash}` : `version ${pipeline.hash}`) : undefined,
		kind === "board" && board
			? `${board.tasks.filter((task) => task.status === "done").length} of ${board.tasks.length} done`
			: undefined,
		workspaceName,
	]
		.filter(Boolean)
		.join(" · ")

	if (!data) {
		return (
			<div className="bv">
				<div className="bv-empty">Reading the workspace…</div>
			</div>
		)
	}

	return (
		<div className="bv">
			<header className="bv-header">
				<h1>{title}</h1>
				<span className="bv-sub">{subtitle}</span>
				<span className="bv-spacer" />
				<select
					aria-label="Show"
					className="bv-source-select"
					onChange={(event) => show(parseKey(event.target.value))}
					value={sourceKey(source)}>
					<option value="board">Conversation board</option>
					{data.pipelines.map((candidate) => (
						<option key={candidate.slug} value={`pipeline:${candidate.slug}`}>
							Pipeline {candidate.name}
						</option>
					))}
					{data.runs.map((candidate) => (
						<option key={candidate.id} value={`run:${candidate.id}`}>
							Run {candidate.id} ({candidate.status})
						</option>
					))}
				</select>
			</header>
			<div aria-label="Views" className="bv-tabs" role="tablist">
				{tabList.map((name) => (
					<button
						aria-selected={name === tab}
						className="bv-tab"
						key={name}
						onClick={() => kind && setTabs((current) => ({ ...current, [kind]: name }))}
						role="tab"
						type="button">
						{TAB_LABEL[name]}
					</button>
				))}
			</div>
			<div className={`bv-body${withInspector ? " bv-with-inspector" : ""}`}>
				<nav aria-label="Boards, pipelines and runs" className="bv-rail">
					<div className="bv-rail-heading">Conversation</div>
					<button
						aria-current={kind === "board"}
						className="bv-source"
						onClick={() => show({ kind: "board" })}
						type="button">
						<span className="bv-source-name">Board</span>
						<span className="bv-source-meta">
							{board ? `${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"}` : "No board yet"}
						</span>
					</button>
					<div className="bv-rail-heading">Pipelines</div>
					{data.pipelines.length === 0 && <div className="bv-rail-empty">None in .cerebriline/pipelines</div>}
					{data.pipelines.map((candidate) => {
						const runs = data.runs.filter((entry) => runBelongsTo(entry, candidate)).length
						const state = !candidate.valid
							? "does not validate"
							: candidate.isApproved
								? "approved"
								: candidate.approved
									? "changed since approval"
									: "not approved"
						return (
							<button
								aria-current={
									kind === "pipeline" && source?.kind === "pipeline" && source.slug === candidate.slug
								}
								className="bv-source"
								key={candidate.slug}
								onClick={() => show({ kind: "pipeline", slug: candidate.slug })}
								type="button">
								<span className="bv-source-name">{candidate.name}</span>
								<span className="bv-source-meta">
									{state}
									{runs > 0 ? ` · ${runs} run${runs === 1 ? "" : "s"}` : ""}
								</span>
							</button>
						)
					})}
					<div className="bv-rail-heading">Runs</div>
					{data.runs.length === 0 && <div className="bv-rail-empty">No runs yet</div>}
					{data.runs.map((candidate) => (
						<button
							aria-current={source?.kind === "run" && source.id === candidate.id}
							className="bv-source"
							key={candidate.id}
							onClick={() => show({ kind: "run", id: candidate.id })}
							type="button">
							<span className="bv-source-name bv-mono">{candidate.id}</span>
							<span className="bv-chip" data-status={candidate.status}>
								{candidate.status}
							</span>
							<span className="bv-source-meta">{ago(candidate.endedAt ?? candidate.startedAt)}</span>
						</button>
					))}
				</nav>
				<main className={`bv-main${tab === "workflow" ? " bv-main-canvas" : ""}`}>
					<TabBody
						board={board}
						definition={definition}
						// The inspector opening or closing resizes the canvas: fit it again then, not on every pick.
						fitKey={`${sourceKey(source)}|${withInspector}`}
						graph={graph}
						onOpenRun={openRun}
						onSelect={setSelected}
						pipeline={pipeline ?? runPipeline}
						pipelineRuns={pipelineRuns}
						run={run}
						selected={selected}
						source={source}
						tab={tab}
					/>
				</main>
				{withInspector && subject && (
					<aside aria-label="Inspector" className="bv-inspector">
						<Inspector onOpenRun={openRun} subject={subject} />
					</aside>
				)}
			</div>
		</div>
	)
}

function TabBody({
	tab,
	source,
	board,
	graph,
	fitKey,
	definition,
	pipeline,
	pipelineRuns,
	run,
	selected,
	onSelect,
	onOpenRun,
}: {
	tab: Tab
	source: ViewerSource | undefined
	board: ReturnType<typeof readBoard>
	graph: ViewerGraph
	fitKey: string
	definition: ViewerPipelineDefinition | undefined
	pipeline: ViewerPipeline | undefined
	pipelineRuns: ViewerRun[]
	run: ViewerRun | undefined
	selected: string | undefined
	onSelect: (id: string | undefined) => void
	onOpenRun: (id: string) => void
}) {
	if (!source) {
		return (
			<div className="bv-empty">
				<strong>Nothing to show yet</strong>
				<span>
					The board fills in when the model plans tasks in a conversation; pipelines live in .cerebriline/pipelines.
				</span>
			</div>
		)
	}
	if (source.kind === "board" && !board) {
		return (
			<div className="bv-empty">
				<strong>No board yet</strong>
				<span>The conversation's board appears here once the model plans tasks, or a saved plan is started.</span>
			</div>
		)
	}
	if (source.kind === "run" && !run) {
		return <div className="bv-empty">This run's journal is gone.</div>
	}
	switch (tab) {
		case "workflow":
			if (graph.nodes.length === 0) {
				return (
					<div className="bv-empty">
						<strong>Nothing to draw</strong>
						<span>
							{source.kind === "pipeline" && pipeline && !pipeline.valid
								? "This pipeline does not validate: see Definition."
								: source.kind === "run"
									? "Neither this run nor its pipeline file has a definition to draw."
									: "The board has no tasks."}
						</span>
					</div>
				)
			}
			return <Canvas fitKey={fitKey} graph={graph} onSelect={onSelect} selected={selected} />
		case "plan":
			return board ? <PlanPane board={board} onSelect={onSelect} /> : null
		case "definition":
			return (
				<DefinitionPane
					onOpenFile={(path) => post({ type: "boardViewer/openFile", path })}
					pipeline={pipeline}
					run={source.kind === "run" ? run : undefined}
				/>
			)
		case "runs":
			return <RunsPane onOpenRun={onOpenRun} runs={pipelineRuns} />
		case "monitor":
			return run ? <RunMonitorPane definition={definition} onSelect={onSelect} run={run} /> : null
		case "activity":
			return run ? <ActivityPane run={run} /> : null
		case "report":
			return run ? (
				<ReportPane
					definition={definition}
					onSave={(name, text) => post({ type: "boardViewer/saveReport", name, text })}
					run={run}
				/>
			) : null
	}
}
