import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { PLATFORM_CONFIG } from "@/config/platform.config"
import "./board-viewer.css"
import { Canvas, type CanvasEdit } from "./Canvas"
import { addNode, boardTasks, connect, removeEdge, removeNodes, replaceNode } from "./edit"
import { boardGraph, pipelineGraph, type ViewerGraph } from "./graph"
import { Inspector, type InspectorSubject, type NodeEdit, type RunAction, type TaskEdit } from "./Inspector"
import {
	ask,
	initialSource,
	readBoard,
	readViewerMessage,
	runBelongsTo,
	settleReply,
	type ViewerData,
	type ViewerPipeline,
	type ViewerPipelineDefinition,
	type ViewerReply,
	type ViewerRequest,
	type ViewerRun,
	type ViewerSource,
} from "./model"
import {
	ActivityPane,
	type DefinitionEdit,
	DefinitionPane,
	PlanPane,
	ReportPane,
	RunMonitorPane,
	RunsPane,
	VersionsPane,
} from "./Panes"

/**
 * The board viewer (pipelines plan phases 3 and 4): the conversation's board,
 * the workspace's pipelines and their runs, on one canvas, in an editor-area
 * panel. A pipeline is edited here as a draft (the canvas, the inspector, its
 * JSON) that the extension validates as it changes; saving it is the
 * person's version and approves it. The model's proposals are approved or
 * rejected here, against the approved version.
 */

type Tab = "workflow" | "plan" | "definition" | "versions" | "runs" | "monitor" | "activity" | "report"

const TAB_LABEL: Record<Tab, string> = {
	workflow: "Workflow",
	plan: "Plan",
	definition: "Definition",
	versions: "Versions",
	runs: "Runs",
	monitor: "Run monitor",
	activity: "Activity",
	report: "Report",
}

const TABS: Record<ViewerSource["kind"], Tab[]> = {
	board: ["workflow", "plan"],
	pipeline: ["workflow", "definition", "versions", "runs"],
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

/** The person's unsaved edit of one pipeline: what it started from, and what it is now. */
interface Draft {
	slug: string
	/** The file's version the edit started from: a save is refused when the file moved on. */
	base: string
	definition: ViewerPipelineDefinition
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

export function BoardViewer() {
	const [data, setData] = useState<ViewerData>()
	const [source, setSource] = useState<ViewerSource>()
	const [tabs, setTabs] = useState<Partial<Record<ViewerSource["kind"], Tab>>>({})
	const [selected, setSelected] = useState<string>()
	const [draft, setDraft] = useState<Draft>()
	const [problems, setProblems] = useState<{ checked: ViewerPipelineDefinition; errors: string[] }>()
	const [notice, setNotice] = useState<{ ok: boolean; lines: string[] }>()
	const [busy, setBusy] = useState(false)

	const show = useCallback((next: ViewerSource | undefined) => {
		setSource(next)
		setSelected(undefined)
	}, [])

	useEffect(() => {
		const receive = (event: MessageEvent) => {
			if (settleReply(event.data)) return
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
	const drafting = !!pipeline && draft?.slug === pipeline.slug
	const definition = run ? (run.definition ?? runPipeline?.definition) : drafting ? draft?.definition : pipeline?.definition
	// A pipeline can be edited when it has a definition to start from, and no other pipeline has an unsaved draft.
	const editable = !!pipeline && (drafting || (!draft && !!pipeline.definition))
	const pipelineRuns = useMemo(
		() => (pipeline && data ? data.runs.filter((candidate) => runBelongsTo(candidate, pipeline)) : []),
		[data, pipeline],
	)

	const graph: ViewerGraph = useMemo(() => {
		if (source?.kind === "board") return boardGraph(board)
		if (source?.kind === "pipeline") return pipelineGraph(definition)
		if (source?.kind === "run") return pipelineGraph(definition, run)
		return { nodes: [], edges: [] }
	}, [source, board, definition, run])

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
			...(source?.kind === "run" && run
				? { run: { id: run.id, status: run.status, ...(run.parent ? { parent: run.parent } : {}) } }
				: {}),
		}
	}, [selected, source, graph, board, definition, run])

	// The draft is checked by the extension as it changes; the last answer for the draft on screen counts.
	const draftDefinition = draft?.definition
	useEffect(() => {
		if (!draftDefinition) {
			setProblems(undefined)
			return
		}
		let current = true
		const timer = setTimeout(() => {
			void ask(post, { type: "boardViewer/validate", definition: draftDefinition }).then((reply) => {
				if (current) setProblems({ checked: draftDefinition, errors: reply.errors })
			})
		}, 250)
		return () => {
			current = false
			clearTimeout(timer)
		}
	}, [draftDefinition])
	const draftErrors = problems && problems.checked === draftDefinition ? problems.errors : undefined

	const change = useCallback(
		(edit: (definition: ViewerPipelineDefinition) => ViewerPipelineDefinition) => {
			if (!pipeline) return
			setNotice(undefined)
			setDraft((current) => {
				const start =
					current?.slug === pipeline.slug
						? current
						: pipeline.definition
							? { slug: pipeline.slug, base: pipeline.hash, definition: pipeline.definition }
							: undefined
				return start ? { ...start, definition: edit(start.definition) } : current
			})
		},
		[pipeline],
	)

	const report = (reply: ViewerReply) => {
		if (!reply.ok && reply.errors.length === 0) return
		setNotice({ ok: reply.ok, lines: [...reply.errors, ...reply.lines] })
	}
	const request = async (send: () => Promise<ViewerReply>): Promise<ViewerReply> => {
		setBusy(true)
		setNotice(undefined)
		try {
			const reply = await send()
			report(reply)
			return reply
		} finally {
			setBusy(false)
		}
	}

	const selectedRef = useRef(selected)
	selectedRef.current = selected
	const canvasEdit: CanvasEdit | undefined = useMemo(
		() =>
			editable && source?.kind === "pipeline"
				? {
						onAdd: (type) => {
							let added: string | undefined
							change((current) => {
								const next = addNode(current, type, selectedRef.current)
								added = next.id
								return next.definition
							})
							// The new node is picked, so its fields are in the inspector to fill in.
							setTimeout(() => added && setSelected(added), 0)
						},
						onConnect: (from, port, to) => change((current) => connect(current, from, port, to)),
						onDeleteNode: (id) => change((current) => removeNodes(current, [id])),
						onDeleteEdge: (id) => change((current) => removeEdge(current, id)),
					}
				: undefined,
		[editable, source, change],
	)

	const nodeEdit: NodeEdit | undefined =
		editable && source?.kind === "pipeline" && subject?.kind === "node" && subject.node && definition
			? {
					onApply: (json) => {
						const next = replaceNode(definition, subject.id, json)
						if ("error" in next) return next.error
						change(() => next.definition)
						const renamed = next.definition.nodes.find(
							(node) => !definition.nodes.some((old) => old.id === node.id),
						)?.id
						if (renamed) setSelected(renamed)
						return undefined
					},
					onDelete: () => {
						change((current) => removeNodes(current, [subject.id]))
						setSelected(undefined)
					},
				}
			: undefined

	const definitionEdit: DefinitionEdit | undefined =
		editable && pipeline && definition
			? {
					definition,
					onApply: (json) => {
						let parsed: unknown
						try {
							parsed = JSON.parse(json)
						} catch (error) {
							return `Not JSON: ${error instanceof Error ? error.message : String(error)}`
						}
						if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { nodes?: unknown }).nodes)) {
							return "A pipeline is an object with a `nodes` list."
						}
						change(() => parsed as ViewerPipelineDefinition)
						return undefined
					},
				}
			: undefined

	// What a request made (a re-run's new run, a new pipeline) is shown once the data has it.
	const [pending, setPending] = useState<ViewerSource>()
	useEffect(() => {
		if (pending && data && exists(data, pending)) {
			setPending(undefined)
			show(pending)
		}
	}, [pending, data, show])
	const runAction: RunAction | undefined =
		source?.kind === "run" && run
			? (op, node) => {
					void request(() =>
						ask(post, { type: "boardViewer/runAction", op, run: run.id, ...(node !== undefined ? { node } : {}) }),
					).then((reply) => {
						if (reply.ok && reply.run && reply.run !== run.id) setPending({ kind: "run", id: reply.run })
					})
				}
			: undefined

	const taskEdit: TaskEdit | undefined =
		source?.kind === "board" ? (fields) => ask(post, { type: "boardViewer/editTask", updates: [fields] }) : undefined
	const deleteTask = (task: string) =>
		void request(() => ask(post, { type: "boardViewer/deleteTask", task })).then((reply) => {
			if (reply.ok) setSelected(undefined)
		})
	const addStep = async (parent: string, title: string) =>
		(await request(() => ask(post, { type: "boardViewer/addTask", title, parent }))).ok
	// The board's own canvas edits: a drag from a task to another makes the
	// second wait on the first; deleting an edge drops that dependency (or the
	// gate it comes from), and deleting a card deletes the task, after asking.
	const boardCanvasEdit: CanvasEdit | undefined =
		source?.kind === "board" && board && board.tasks.length > 0
			? {
					kind: "task",
					onConnect: (from, _port, to) => {
						if (from === to) return
						void request(() => ask(post, { type: "boardViewer/editTask", updates: [{ id: to, depends: [from] }] }))
					},
					onDeleteNode: (id) => deleteTask(id),
					onDeleteEdge: (id) => {
						const gate = /^gate:(.+):(\d+)->/.exec(id)
						if (gate) {
							const spec = board.tasks.find((task) => task.id === gate[1])?.gates?.[Number(gate[2])]?.spec
							if (spec)
								void request(() =>
									ask(post, { type: "boardViewer/editTask", updates: [{ id: gate[1], gate_remove: [spec] }] }),
								)
							return
						}
						const [from, to] = id.split("->")
						if (from && to)
							void request(() =>
								ask(post, { type: "boardViewer/editTask", updates: [{ id: to, depends_remove: [from] }] }),
							)
					},
				}
			: undefined

	const save = async () => {
		if (!draft) return
		const reply = await request(() =>
			ask(post, { type: "boardViewer/save", slug: draft.slug, base: draft.base, definition: draft.definition }),
		)
		if (reply.ok) {
			setDraft(undefined)
			setNotice({ ok: true, lines: ["Saved and approved."] })
		}
	}

	const newPipeline = () =>
		void request(() => ask(post, { type: "boardViewer/newPipeline" })).then((reply) => {
			if (reply.ok && reply.pipeline) setPending({ kind: "pipeline", slug: reply.pipeline })
		})
	const addTask = async (title: string) => (await request(() => ask(post, { type: "boardViewer/addTask", title }))).ok
	const boardDraft = data?.boardDraft === true

	const kind = source?.kind
	const tabList = kind ? TABS[kind] : []
	const tab: Tab = (kind && tabs[kind] && tabList.includes(tabs[kind] as Tab) ? tabs[kind] : tabList[0]) ?? "workflow"
	const openRun = (id: string) => show({ kind: "run", id })
	const withInspector = !!subject && INSPECTOR_TABS.has(tab)

	const title =
		kind === "board"
			? boardDraft
				? "Draft board"
				: "Conversation board"
			: kind === "pipeline"
				? (pipeline?.name ?? "Pipeline")
				: kind === "run"
					? `Run ${run?.id ?? ""}`
					: "Board"
	const workspaceName = data?.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? ""
	const subtitle = [
		run ? `${run.pipeline} · ${run.status}` : undefined,
		pipeline
			? drafting
				? `editing, from version ${draft?.base}`
				: pipeline.isApproved
					? `approved, version ${pipeline.hash}`
					: `version ${pipeline.hash}`
			: undefined,
		kind === "board" && boardDraft ? "for your next conversation" : undefined,
		kind === "board" && board && !boardDraft
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
					<option value="board">{boardDraft ? "Draft board" : "Conversation board"}</option>
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
			<ActionBar
				board={board}
				boardDraft={boardDraft}
				busy={busy}
				draft={draft}
				draftErrors={draftErrors}
				drafting={drafting}
				notice={notice}
				onAddTask={addTask}
				onApprove={() =>
					pipeline &&
					void request(() => ask(post, { type: "boardViewer/approve", slug: pipeline.slug, hash: pipeline.hash }))
				}
				onBoardToPipeline={() =>
					board && void request(() => ask(post, { type: "boardViewer/boardToPipeline", tasks: boardTasks(board) }))
				}
				onChanges={() => kind && setTabs((current) => ({ ...current, [kind]: "versions" }))}
				onDiscard={() => {
					setDraft(undefined)
					setNotice(undefined)
				}}
				onDiscardBoardDraft={() => void request(() => ask(post, { type: "boardViewer/discardDraft" }))}
				onExportBoard={() => void request(() => ask(post, { type: "boardViewer/exportBoard" }))}
				onLoadBoard={() => void request(() => ask(post, { type: "boardViewer/loadBoard" }))}
				onReject={() =>
					pipeline &&
					void request(() => ask(post, { type: "boardViewer/reject", slug: pipeline.slug, hash: pipeline.hash }))
				}
				onSave={() => void save()}
				onShowDraft={() => draft && show({ kind: "pipeline", slug: draft.slug })}
				onStartFromBoardDraft={() => void request(() => ask(post, { type: "boardViewer/startFromDraft" }))}
				onToTemplate={() =>
					pipeline && void request(() => ask(post, { type: "boardViewer/toTemplate", slug: pipeline.slug }))
				}
				pipeline={pipeline}
				source={source}
			/>
			<div className={`bv-body${withInspector ? " bv-with-inspector" : ""}`}>
				<nav aria-label="Boards, pipelines and runs" className="bv-rail">
					<div className="bv-rail-heading">{boardDraft ? "Next conversation" : "Conversation"}</div>
					<button
						aria-current={kind === "board"}
						className="bv-source"
						onClick={() => show({ kind: "board" })}
						type="button">
						<span className="bv-source-name">Board</span>
						<span className="bv-source-meta">
							{board
								? `${board.tasks.length} task${board.tasks.length === 1 ? "" : "s"}${boardDraft ? " · draft" : ""}`
								: boardDraft
									? "Add tasks for your next conversation"
									: "No board yet"}
						</span>
					</button>
					<div className="bv-rail-heading">
						Pipelines
						<button className="bv-row-button bv-rail-action" disabled={busy} onClick={newPipeline} type="button">
							+ New
						</button>
					</div>
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
									{draft?.slug === candidate.slug ? "unsaved edit · " : ""}
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
						boardDraft={boardDraft}
						canvasEdit={canvasEdit ?? boardCanvasEdit}
						definition={definition}
						definitionEdit={definitionEdit}
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
						<Inspector
							busy={busy}
							nodeEdit={nodeEdit}
							onOpenRun={openRun}
							pipelines={data.pipelines.filter((candidate) => candidate.valid).map((candidate) => candidate.name)}
							runAction={runAction}
							subject={subject}
							taskEdit={taskEdit}
							taskTools={
								taskEdit && board
									? {
											tasks: board.tasks.map((task) => ({ id: task.id, title: task.title })),
											addStep,
											deleteTask,
										}
									: undefined
							}
						/>
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
	boardDraft,
	graph,
	fitKey,
	canvasEdit,
	definitionEdit,
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
	boardDraft: boolean
	graph: ViewerGraph
	fitKey: string
	canvasEdit: CanvasEdit | undefined
	definitionEdit: DefinitionEdit | undefined
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
				<strong>{boardDraft ? "An empty draft board" : "No board yet"}</strong>
				<span>
					{boardDraft
						? "No conversation is open. Add tasks above, give a task a pipeline from its inspector, then start a conversation with this board: the model works from it."
						: "The conversation's board appears here once the model plans tasks, a saved plan is started, or you add a task above."}
				</span>
			</div>
		)
	}
	if (source.kind === "run" && !run) {
		return <div className="bv-empty">This run's journal is gone.</div>
	}
	switch (tab) {
		case "workflow":
			if (graph.nodes.length === 0 && !canvasEdit) {
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
			return <Canvas edit={canvasEdit} fitKey={fitKey} graph={graph} onSelect={onSelect} selected={selected} />
		case "plan":
			return board ? <PlanPane board={board} onSelect={onSelect} /> : null
		case "definition":
			return (
				<DefinitionPane
					edit={source.kind === "pipeline" ? definitionEdit : undefined}
					onOpenFile={(path) => post({ type: "boardViewer/openFile", path })}
					pipeline={pipeline}
					run={source.kind === "run" ? run : undefined}
				/>
			)
		case "versions":
			return pipeline ? <VersionsPane pipeline={pipeline} /> : null
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

/**
 * What can be done with what is shown: save or discard a draft, approve or
 * reject a proposal, save a pipeline as a template or the board as a
 * pipeline. Says what the last request answered.
 */
/** A new task on the board shown: its title; the rest is set from its inspector. */
function AddTask({ busy, onAdd }: { busy: boolean; onAdd: (title: string) => Promise<boolean> }) {
	const [title, setTitle] = useState("")
	return (
		<form
			className="bv-form bv-add-task"
			onSubmit={async (event) => {
				event.preventDefault()
				if (!title.trim() || busy) return
				if (await onAdd(title.trim())) setTitle("")
			}}>
			<input
				aria-label="New task"
				className="bv-input"
				onChange={(event) => setTitle(event.target.value)}
				placeholder="New task…"
				value={title}
			/>
			<button className="bv-button" disabled={busy || !title.trim()} type="submit">
				Add task
			</button>
		</form>
	)
}

function ActionBar({
	source,
	pipeline,
	board,
	draft,
	drafting,
	draftErrors,
	busy,
	notice,
	onSave,
	onDiscard,
	onShowDraft,
	onApprove,
	onReject,
	onChanges,
	onToTemplate,
	onBoardToPipeline,
	onLoadBoard,
	onExportBoard,
	boardDraft,
	onAddTask,
	onStartFromBoardDraft,
	onDiscardBoardDraft,
}: {
	source: ViewerSource | undefined
	pipeline: ViewerPipeline | undefined
	board: ReturnType<typeof readBoard>
	boardDraft: boolean
	onAddTask: (title: string) => Promise<boolean>
	onStartFromBoardDraft: () => void
	onDiscardBoardDraft: () => void
	draft: Draft | undefined
	drafting: boolean
	draftErrors: string[] | undefined
	busy: boolean
	notice: { ok: boolean; lines: string[] } | undefined
	onSave: () => void
	onDiscard: () => void
	onShowDraft: () => void
	onApprove: () => void
	onReject: () => void
	onChanges: () => void
	onToTemplate: () => void
	onBoardToPipeline: () => void
	/** Add tasks from a saved board, a saved plan or a file; write the board to a file. */
	onLoadBoard: () => void
	onExportBoard: () => void
}) {
	let left: ReactNode = null
	let right: ReactNode = null
	if (source?.kind === "pipeline" && pipeline) {
		if (drafting && draft) {
			const moved = pipeline.hash !== draft.base
			left = (
				<>
					<span className="bv-chip" data-status="draft">
						unsaved edit
					</span>
					<span className="bv-actionbar-text">
						{draftErrors === undefined
							? "Checking…"
							: draftErrors.length === 0
								? "Valid. Saving approves it as your version."
								: plural(draftErrors.length, "problem")}
						{moved ? ` The file changed to version ${pipeline.hash} since you started: saving will be refused.` : ""}
					</span>
				</>
			)
			right = (
				<>
					<button
						className="bv-button bv-primary"
						disabled={busy || !draftErrors || draftErrors.length > 0}
						onClick={onSave}
						type="button">
						Save
					</button>
					<button className="bv-button" disabled={busy} onClick={onDiscard} type="button">
						Discard
					</button>
				</>
			)
		} else {
			const author = pipeline.author === "model" ? "the model" : pipeline.author === "person" ? "you" : undefined
			left = draft ? (
				<span className="bv-actionbar-text">
					{`${draft.slug} has an unsaved edit: save or discard it before editing another pipeline.`}{" "}
					<button className="bv-row-button" onClick={onShowDraft} type="button">
						Show it
					</button>
				</span>
			) : !pipeline.valid ? (
				<span className="bv-actionbar-text">Does not validate: fix it in its file (Definition shows why).</span>
			) : pipeline.isApproved ? (
				<>
					<span className="bv-chip" data-status="approved">
						approved
					</span>
					<span className="bv-actionbar-text">
						Version {pipeline.hash}
						{author ? `, written by ${author}` : ""}. Edit it on the canvas, in the inspector or as JSON.
					</span>
				</>
			) : (
				<>
					<span className="bv-chip" data-status="proposed">
						{pipeline.approved ? "changed" : "proposed"}
					</span>
					<span className="bv-actionbar-text">
						Version {pipeline.hash}
						{author ? ` by ${author}` : ""}
						{pipeline.approved ? `, against the approved ${pipeline.approved.hash}` : ", never approved"}. It runs
						once approved.
					</span>
				</>
			)
			right = (
				<>
					{pipeline.valid && !pipeline.isApproved && (
						<>
							<button className="bv-button" onClick={onChanges} type="button">
								Changes
							</button>
							<button className="bv-button bv-primary" disabled={busy} onClick={onApprove} type="button">
								Approve
							</button>
							{pipeline.approved && (
								<button className="bv-button bv-danger" disabled={busy} onClick={onReject} type="button">
									Reject
								</button>
							)}
						</>
					)}
					{pipeline.valid && (
						<button className="bv-button" disabled={busy} onClick={onToTemplate} type="button">
							Save as task template
						</button>
					)}
				</>
			)
		}
	} else if (source?.kind === "board") {
		const tasks = board?.tasks.length ?? 0
		left = <AddTask busy={busy} onAdd={onAddTask} />
		const io = (
			<>
				<button
					className="bv-button"
					disabled={busy}
					onClick={onLoadBoard}
					title="Add tasks from a board saved in Memory, a saved plan, or a file"
					type="button">
					Load…
				</button>
				<button
					className="bv-button"
					disabled={busy || tasks === 0}
					onClick={onExportBoard}
					title="Write this board to a file another board can load"
					type="button">
					Export…
				</button>
			</>
		)
		const actions = boardDraft ? (
			<>
				<button
					className="bv-button bv-primary"
					disabled={busy || tasks === 0}
					onClick={onStartFromBoardDraft}
					type="button">
					Start a conversation with this board
				</button>
				<button className="bv-button" disabled={busy || tasks === 0} onClick={onDiscardBoardDraft} type="button">
					Discard
				</button>
			</>
		) : tasks > 0 ? (
			<button className="bv-button" disabled={busy} onClick={onBoardToPipeline} type="button">
				Save as a pipeline
			</button>
		) : null
		right = (
			<>
				{io}
				{actions}
			</>
		)
	}
	const errors = drafting && draftErrors && draftErrors.length > 0 ? draftErrors : []
	if (!left && !right && !notice) return null
	return (
		<div className="bv-actionbar">
			<div className="bv-actionbar-row">
				{left}
				<span className="bv-spacer" />
				{right}
			</div>
			{errors.length > 0 && (
				<ul className="bv-list bv-actionbar-errors">
					{errors.slice(0, 6).map((error) => (
						<li className="bv-error" key={error}>
							{error}
						</li>
					))}
					{errors.length > 6 && <li className="bv-muted">and {errors.length - 6} more</li>}
				</ul>
			)}
			{notice && (
				<ul className="bv-list bv-reply" data-ok={notice.ok}>
					{notice.lines.map((line, index) => (
						<li key={index}>{line}</li>
					))}
				</ul>
			)}
		</div>
	)
}
