import { type ReactNode, useId, useState } from "react"
import type { TaskGraphPanelTask } from "@/components/chat/task-header/TaskGraphPanel"
import { nodeJson } from "./edit"
import { taskStatus } from "./graph"
import {
	formatDuration,
	type ViewerEvent,
	type ViewerNodeState,
	type ViewerPipelineNode,
	type ViewerReply,
	type ViewerRunOp,
} from "./model"
import { eventSummary } from "./report"

/** What the inspector shows: the selected card, and how it is edited when it can be (phase 4). */
export type InspectorSubject =
	| {
			kind: "node"
			id: string
			node?: ViewerPipelineNode
			state?: ViewerNodeState
			events: ViewerEvent[]
			runStart?: number
			/** The run shown, when it is a run: what the run controls act on. */
			run?: { id: string; status: string; parent?: string }
	  }
	| { kind: "task"; task: TaskGraphPanelTask }
	| { kind: "gate"; spec: string; status: string; task: string }

const MAX_TEXT = 6000

/** JSON for a pre, cut at a size the panel can still scroll. */
export function shortJson(value: unknown, max = MAX_TEXT): string {
	let text: string
	try {
		text = JSON.stringify(value, null, 2) ?? String(value)
	} catch {
		text = String(value)
	}
	return text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more characters` : text
}

const cut = (text: string, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max)}\n… ${text.length - max} more` : text)

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
	<section className="bv-section">
		<h3 className="bv-h">{title}</h3>
		{children}
	</section>
)

const Pair = ({ label, children }: { label: string; children: ReactNode }) => (
	<>
		<dt>{label}</dt>
		<dd>{children}</dd>
	</>
)

/** Editing a pipeline node: its JSON replaces it in the draft. Returns why it did not, or undefined. */
export interface NodeEdit {
	onApply: (json: string) => string | undefined
	onDelete: () => void
}

/** A change to a task, as the task panel sends it. */
export type TaskEdit = (fields: Record<string, unknown>) => Promise<ViewerReply>

/** Retry, Skip, Re-run from a node, or Stop, on the run shown. */
export type RunAction = (op: ViewerRunOp, node?: string) => void

/** What the person can do to a task beyond a field change: its steps, deleting it, the other tasks to pick from. */
export interface TaskTools {
	tasks: { id: string; title: string }[]
	addStep: (parent: string, title: string) => Promise<boolean>
	deleteTask: (id: string) => void
}

/**
 * What a gate can wait on, offered as the person types one (owner,
 * 2026-11-27: "everything that can be auto-completed in ui should have it").
 */
export const GATE_SUGGESTIONS: { value: string; label: string }[] = [
	{ value: "human:", label: "Waits for your answer: Resolve opens it" },
	{ value: "timer:+30m", label: "Waits a while (+10m, +2h, +1d)" },
	{ value: "timer:2026-12-01T09:00", label: "Waits until a time" },
	{ value: "commit:<sha>@main", label: "Waits until the branch has the commit" },
	{ value: "gh-pr:owner/repo#1", label: "Waits until the pull request is merged" },
	{ value: "gh-run:owner/repo/123", label: "Waits until the Actions run succeeds" },
	{ value: "run:", label: "Waits until a teammate run or delegated agent ends" },
	{ value: "command:", label: "Waits until a background command exits" },
	{ value: "pipeline:", label: "Waits until a pipeline run ends" },
]

export function Inspector({
	subject,
	onOpenRun,
	nodeEdit,
	taskEdit,
	taskTools,
	runAction,
	busy = false,
	pipelines = [],
}: {
	subject: InspectorSubject
	onOpenRun: (run: string) => void
	nodeEdit?: NodeEdit
	taskEdit?: TaskEdit
	taskTools?: TaskTools
	runAction?: RunAction
	busy?: boolean
	/** The workspace's pipelines a task can be done by (their names). */
	pipelines?: string[]
}) {
	switch (subject.kind) {
		case "node":
			return (
				<NodeInspector
					act={runAction}
					busy={busy}
					edit={nodeEdit}
					key={subject.node ? nodeJson(subject.node) : subject.id}
					subject={subject}
				/>
			)
		case "task":
			return (
				<TaskInspector
					edit={taskEdit}
					key={subject.task.id}
					onOpenRun={onOpenRun}
					pipelines={pipelines}
					task={subject.task}
					tools={taskTools}
				/>
			)
		case "gate":
			return (
				<div>
					<div className="bv-title bv-mono">{subject.spec}</div>
					<dl className="bv-kv">
						<Pair label="Gate">
							<span className="bv-chip" data-status={subject.status}>
								{subject.status}
							</span>
						</Pair>
						<Pair label="Holds">
							<span className="bv-mono">{subject.task}</span>
						</Pair>
					</dl>
				</div>
			)
	}
}

function NodeEditor({ node, edit }: { node: ViewerPipelineNode; edit: NodeEdit }) {
	const [text, setText] = useState(() => nodeJson(node))
	const [error, setError] = useState<string>()
	const changed = text !== nodeJson(node)
	return (
		<Section title="Edit">
			<textarea
				aria-label={`${node.id} as JSON`}
				className="bv-editor"
				onChange={(event) => {
					setText(event.target.value)
					setError(undefined)
				}}
				rows={Math.min(24, Math.max(6, text.split("\n").length + 1))}
				spellCheck={false}
				value={text}
			/>
			{error && <div className="bv-error">{error}</div>}
			<div className="bv-actions">
				<button
					className="bv-button bv-primary"
					disabled={!changed}
					onClick={() => setError(edit.onApply(text))}
					type="button">
					Apply
				</button>
				<button className="bv-button" disabled={!changed} onClick={() => setText(nodeJson(node))} type="button">
					Undo
				</button>
				<span className="bv-spacer" />
				<button className="bv-button bv-danger" onClick={edit.onDelete} type="button">
					Delete node
				</button>
			</div>
			<div className="bv-note">Changes go to the draft. Save it from the bar above the canvas.</div>
		</Section>
	)
}

/** A node that picks one of its outputs: skipping it would leave no output to go on through. */
const PICKS_AN_OUTPUT = new Set(["if", "switch", "approval"])

/**
 * The person's actions on the run shown (ol-177): Stop while it runs;
 * Retry or Skip a node that failed; Re-run from any node once it ended.
 * The extension confirms each and the run's conversation carries it out.
 */
function RunControls({
	id,
	node,
	state,
	run,
	act,
	busy,
}: {
	id: string
	node?: ViewerPipelineNode
	state?: ViewerNodeState
	run: { id: string; status: string; parent?: string }
	act: RunAction
	busy: boolean
}) {
	if (run.parent) {
		return (
			<Section title="Run">
				<div className="bv-note">This is a sub-run of {run.parent}: act on that run's node.</div>
			</Section>
		)
	}
	if (run.status === "running" || run.status === "waiting") {
		return (
			<Section title="Run">
				<div className="bv-actions">
					<button className="bv-button bv-danger" disabled={busy} onClick={() => act("stop")} type="button">
						Stop run
					</button>
				</div>
				<div className="bv-note">The run is going. Stop it to retry, skip or re-run a node.</div>
			</Section>
		)
	}
	const failed = state?.status === "failed" && run.status !== "done"
	const picks = !!node && PICKS_AN_OUTPUT.has(node.type)
	return (
		<Section title="Run">
			<div className="bv-actions">
				{failed && (
					<button className="bv-button bv-primary" disabled={busy} onClick={() => act("retry", id)} type="button">
						Retry
					</button>
				)}
				{failed && (
					<button
						className="bv-button"
						disabled={busy || picks}
						onClick={() => act("skip", id)}
						title={picks ? `${node?.type} picks one of its outputs: retry it or re-run from it` : undefined}
						type="button">
						Skip
					</button>
				)}
				<button className="bv-button" disabled={busy || !node} onClick={() => act("rerun", id)} type="button">
					Re-run from here
				</button>
			</div>
			<div className="bv-note">
				{failed
					? picks
						? `Retry runs ${id} again and the run goes on. An ${node?.type} picks an output, so it is not skipped.`
						: `Retry runs ${id} again; Skip passes its input on without running it. Either way the run resumes.`
					: "Re-run from here starts a new run that reuses what came before this node."}
			</div>
		</Section>
	)
}

function NodeInspector({
	subject,
	edit,
	act,
	busy,
}: {
	subject: Extract<InspectorSubject, { kind: "node" }>
	edit?: NodeEdit
	act?: RunAction
	busy: boolean
}) {
	const { id, node, state, events, runStart } = subject
	const fields = node
		? Object.fromEntries(Object.entries(node).filter(([key]) => !["id", "type", "after", "name"].includes(key)))
		: undefined
	const output = state?.output
	const status = state ? (state.waitingOn ? "waiting" : state.status) : undefined
	return (
		<div>
			<div className="bv-title">{typeof node?.name === "string" ? node.name : id}</div>
			<dl className="bv-kv">
				<Pair label="Node">
					<span className="bv-mono">{id}</span>
				</Pair>
				{node && (
					<Pair label="Type">
						<span className="bv-mono">{node.type}</span>
					</Pair>
				)}
				{node?.after && node.after.length > 0 && (
					<Pair label="After">
						<span className="bv-mono">{node.after.join(", ")}</span>
					</Pair>
				)}
				{status && (
					<Pair label="Status">
						<span className="bv-chip" data-status={status}>
							{status}
						</span>
					</Pair>
				)}
				{state && state.attempts > 0 && <Pair label="Attempts">{state.attempts}</Pair>}
				{state?.startedAt !== undefined && runStart !== undefined && (
					<Pair label="Started">+{formatDuration(state.startedAt - runStart) || "0 ms"}</Pair>
				)}
				{state?.startedAt !== undefined && state.endedAt !== undefined && (
					<Pair label="Took">{formatDuration(state.endedAt - state.startedAt)}</Pair>
				)}
				{state?.waitingOn && (
					<Pair label="Waits on">
						<span className="bv-mono">{state.waitingOn}</span>
					</Pair>
				)}
				{state?.reused && <Pair label="Reused from">{state.reused}</Pair>}
				{state?.reason && <Pair label="Skipped">{state.reason}</Pair>}
				{state?.bypassed && <Pair label="Skipped">by you, after it failed; its input went on</Pair>}
			</dl>
			{subject.run && act && <RunControls act={act} busy={busy} id={id} node={node} run={subject.run} state={state} />}
			{!node && <div className="bv-note">This node is not in the definition shown.</div>}
			{(state?.error || state?.lastError) && (
				<Section title={state.bypassed ? "Failed with, before it was skipped" : "Error"}>
					<div className="bv-error">{state.error ?? `Last attempt: ${state.lastError}`}</div>
				</Section>
			)}
			{node && edit && <NodeEditor edit={edit} node={node} />}
			{!edit && fields && Object.keys(fields).length > 0 && (
				<Section title="Fields">
					<pre className="bv-pre">{shortJson(fields)}</pre>
				</Section>
			)}
			{output && (
				<Section title="Output">
					<dl className="bv-kv">
						<Pair label="Port">
							<span className="bv-mono">{output.port}</span>
						</Pair>
						<Pair label="Items">{Array.isArray(output.items) ? output.items.length : 0}</Pair>
						{output.exit !== undefined && <Pair label="Exit">{output.exit}</Pair>}
						{output.status !== undefined && <Pair label="HTTP">{output.status}</Pair>}
						{output.run && <Pair label="Sub-run">{output.run}</Pair>}
					</dl>
					{Array.isArray(output.items) && output.items.length > 0 && (
						<pre className="bv-pre" style={{ marginTop: 8 }}>
							{shortJson(output.items.slice(0, 20))}
						</pre>
					)}
					{output.text && <pre className="bv-pre bv-wrap">{cut(output.text)}</pre>}
					{output.stdout && (
						<>
							<h4 className="bv-h" style={{ marginTop: 8 }}>
								stdout
							</h4>
							<pre className="bv-pre">{cut(output.stdout)}</pre>
						</>
					)}
					{output.stderr && (
						<>
							<h4 className="bv-h" style={{ marginTop: 8 }}>
								stderr
							</h4>
							<pre className="bv-pre">{cut(output.stderr)}</pre>
						</>
					)}
				</Section>
			)}
			{events.length > 0 && (
				<Section title="Journal">
					<ul className="bv-list">
						{events.map((event, index) => (
							<li key={`${event.ts}-${index}`}>
								<span className="bv-event-kind" data-kind={event.t}>
									{event.t}
								</span>{" "}
								{eventSummary(event)}
							</li>
						))}
					</ul>
				</Section>
			)}
		</div>
	)
}

/** One line to send: a title, an acceptance item, a gate, a note. */
function FieldForm({
	label,
	placeholder,
	initial = "",
	action,
	onSend,
	options,
	help,
}: {
	label: string
	placeholder: string
	initial?: string
	action: string
	onSend: (value: string) => Promise<boolean>
	/** Completions offered as the person types: the value, and what it means. */
	options?: { value: string; label: string }[]
	/** Said on hover. */
	help?: string
}) {
	const listId = useId()
	const [value, setValue] = useState(initial)
	const [busy, setBusy] = useState(false)
	return (
		<form
			className="bv-form"
			onSubmit={async (event) => {
				event.preventDefault()
				if (!value.trim() || busy) return
				setBusy(true)
				const done = await onSend(value.trim())
				setBusy(false)
				if (done && !initial) setValue("")
			}}>
			<input
				aria-label={label}
				className="bv-input"
				list={options ? listId : undefined}
				onChange={(event) => setValue(event.target.value)}
				placeholder={placeholder}
				title={help}
				value={value}
			/>
			{options && (
				<datalist id={listId}>
					{options.map((option) => (
						<option key={option.value} label={option.label} value={option.value} />
					))}
				</datalist>
			)}
			<button className="bv-button" disabled={busy || !value.trim() || value.trim() === initial} type="submit">
				{action}
			</button>
		</form>
	)
}

/** `use-pipeline:<name>`: the task is done by running that pipeline. */
const USE_PIPELINE = /^use-pipeline:\s*(.+)$/

/** Pick a pipeline the task is done by: the model runs it for the task when it starts it. */
function UsePipeline({ pipelines, onUse }: { pipelines: string[]; onUse: (name: string) => Promise<boolean> }) {
	const [name, setName] = useState(pipelines[0] ?? "")
	const [busy, setBusy] = useState(false)
	return (
		<form
			className="bv-form"
			onSubmit={async (event) => {
				event.preventDefault()
				if (!name || busy) return
				setBusy(true)
				await onUse(name)
				setBusy(false)
			}}>
			<select
				aria-label="Pipeline the task is done by"
				className="bv-input"
				onChange={(event) => setName(event.target.value)}
				value={name}>
				{pipelines.map((candidate) => (
					<option key={candidate} value={candidate}>
						{candidate}
					</option>
				))}
			</select>
			<button className="bv-button" disabled={busy || !name} type="submit">
				Use pipeline
			</button>
		</form>
	)
}

/** A task id from what was typed or picked: "T3", or "T3 · Build". */
function taskIdOf(value: string): string {
	return value.trim().split(/\s/)[0] ?? ""
}

function TaskControls({
	task,
	edit,
	pipelines,
	tools,
}: {
	task: TaskGraphPanelTask
	edit: TaskEdit
	pipelines: string[]
	tools?: TaskTools
}) {
	const [answer, setAnswer] = useState<ViewerReply>()
	const [description, setDescription] = useState(task.description ?? "")
	const send = async (fields: Record<string, unknown>) => {
		const reply = await edit({ id: task.id, ...fields })
		setAnswer(reply)
		return reply.ok
	}
	const held = task.claimedBy?.startsWith("pipeline:")
	const closed = task.status === "done" || task.status === "cancelled"
	const statuses: { label: string; status: string; help: string }[] = closed
		? [{ label: "Reopen", status: "pending", help: "Back on the board as not started" }]
		: [
				...(task.status !== "active"
					? [{ label: "Start", status: "active", help: "Mark it as being worked on now" }]
					: []),
				{ label: "Done", status: "done", help: "Close it as done" },
				{ label: "Cancel", status: "cancelled", help: "Close it as not to be done; it stays on the board" },
			]
	// A task can come after any other but itself and its own steps.
	const candidates = (tools?.tasks ?? []).filter(
		(other) => other.id !== task.id && !other.id.startsWith(`${task.id}.`) && !task.depends.includes(other.id),
	)
	return (
		<Section title="Change">
			<div className="bv-actions">
				{held ? (
					<span className="bv-note">A pipeline run holds this task: its status is the run's.</span>
				) : (
					statuses.map(({ label, status, help }) => (
						<button
							className="bv-button"
							key={status}
							onClick={() => void send({ status })}
							title={help}
							type="button">
							{label}
						</button>
					))
				)}
				<span className="bv-spacer" />
				{tools && (
					<button
						className="bv-button bv-danger"
						onClick={() => tools.deleteTask(task.id)}
						title="Delete it for good, with its steps; the tasks after it stop waiting on it"
						type="button">
						Delete
					</button>
				)}
			</div>
			<FieldForm
				action="Rename"
				initial={task.title}
				label="Title"
				onSend={(title) => send({ title })}
				placeholder="Title"
			/>
			<form
				className="bv-form bv-form-stacked"
				onSubmit={(event) => {
					event.preventDefault()
					void send({ description })
				}}>
				<textarea
					aria-label="Description"
					className="bv-input bv-textarea"
					onChange={(event) => setDescription(event.target.value)}
					placeholder="What the task is, for whoever does it"
					rows={3}
					value={description}
				/>
				<button
					className="bv-button"
					disabled={description === (task.description ?? "")}
					title="Save the description"
					type="submit">
					Save
				</button>
			</form>
			<div className="bv-form">
				<label className="bv-field-label" title="High goes first among the tasks that can start">
					Priority
					<select
						aria-label="Priority"
						className="bv-input"
						onChange={(event) => void send({ priority: event.target.value })}
						value={task.priority}>
						<option value="H">High</option>
						<option value="M">Medium</option>
						<option value="L">Low</option>
					</select>
				</label>
				<label className="bv-field-label" title="Later: kept on the board but not started until the rest is done">
					<input
						checked={!!task.later}
						onChange={(event) => void send({ later: event.target.checked })}
						type="checkbox"
					/>
					Later
				</label>
			</div>
			<div className="bv-subhead" title="This task starts only once these are done">
				After
			</div>
			{task.depends.length > 0 ? (
				<ul className="bv-list">
					{task.depends.map((dep) => (
						<li className="bv-chip-row" key={dep}>
							<span className="bv-mono">{dep}</span>{" "}
							<span className="bv-muted">{tools?.tasks.find((other) => other.id === dep)?.title ?? ""}</span>
							<button
								aria-label={`${task.id} no longer waits on ${dep}`}
								className="bv-row-button"
								onClick={() => void send({ depends_remove: [dep] })}
								title="Stop waiting on it"
								type="button">
								Remove
							</button>
						</li>
					))}
				</ul>
			) : (
				<div className="bv-note">
					Nothing: it can start any time. Add a task it waits for, or drag from that task to this one on the canvas.
				</div>
			)}
			{candidates.length > 0 && (
				<FieldForm
					action="Add"
					help="Type a task's id or title and pick it"
					label="Task it waits for"
					onSend={(value) => send({ depends: [taskIdOf(value)] })}
					options={candidates.map((other) => ({ value: `${other.id} · ${other.title}`, label: other.title }))}
					placeholder="After… (T2)"
				/>
			)}
			{tools && (
				<FieldForm
					action="Add step"
					help={`A step of ${task.id}: ${task.id}.1, ${task.id}.2, …`}
					label="New step"
					onSend={(title) => tools.addStep(task.id, title)}
					placeholder="A step of this task"
				/>
			)}
			<FieldForm
				action="Add"
				label="New acceptance item"
				onSend={(item) => send({ acceptance_add: [item] })}
				placeholder="Done when…"
			/>
			<FieldForm
				action="Add"
				help="What the task waits on besides other tasks. Type or pick a kind: human:, timer:, commit:, gh-pr:, gh-run:, run:, command:, pipeline:"
				label="New gate"
				onSend={(gate) => send({ gate: [gate] })}
				options={GATE_SUGGESTIONS}
				placeholder="human:Ship it?"
			/>
			{pipelines.length > 0 && !closed && (
				<>
					<UsePipeline onUse={(name) => send({ gate: [`use-pipeline:${name}`] })} pipelines={pipelines} />
					<div className="bv-note">
						The model runs the pipeline for this task when it starts it, and the task waits on the run.
					</div>
				</>
			)}
			<FieldForm action="Note" label="Note" onSend={(note) => send({ note })} placeholder="A note on the task" />
			{answer && (answer.lines.length > 0 || answer.errors.length > 0) && (
				<ul className="bv-list bv-reply" data-ok={answer.ok}>
					{[...answer.errors, ...answer.lines].map((line, index) => (
						<li key={index}>{line}</li>
					))}
				</ul>
			)}
		</Section>
	)
}

function TaskInspector({
	task,
	onOpenRun,
	edit,
	pipelines,
	tools,
}: {
	task: TaskGraphPanelTask
	onOpenRun: (run: string) => void
	edit?: TaskEdit
	pipelines: string[]
	tools?: TaskTools
}) {
	const run = task.claimedBy?.startsWith("pipeline:") ? task.claimedBy.slice("pipeline:".length) : undefined
	const status = taskStatus(task)
	return (
		<div>
			<div className="bv-title">{task.title}</div>
			<dl className="bv-kv">
				<Pair label="Task">
					<span className="bv-mono">{task.id}</span>
				</Pair>
				<Pair label="Status">
					<span className="bv-chip" data-status={status}>
						{status}
					</span>
				</Pair>
				<Pair label="Priority">{task.later ? `${task.priority}, later` : task.priority}</Pair>
				{task.parent && (
					<Pair label="Part of">
						<span className="bv-mono">{task.parent}</span>
					</Pair>
				)}
				{task.claimedBy && (
					<Pair label="Held by">
						{run ? (
							<button className="bv-row-button" onClick={() => onOpenRun(run)} type="button">
								pipeline run {run}
							</button>
						) : (
							task.claimedBy
						)}
					</Pair>
				)}
				{task.depends.length > 0 && (
					<Pair label="After">
						<span className="bv-mono">{task.depends.join(", ")}</span>
					</Pair>
				)}
				{(task.waitsOn ?? task.openDepends).length > 0 && (
					<Pair label="Waits on">
						<span className="bv-mono">{(task.waitsOn ?? task.openDepends).join(", ")}</span>
					</Pair>
				)}
			</dl>
			{edit && <TaskControls edit={edit} pipelines={pipelines} task={task} tools={tools} />}
			{task.description && !edit && (
				<Section title="Description">
					<div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{task.description}</div>
				</Section>
			)}
			{task.acceptance.length > 0 && (
				<Section title="Acceptance">
					<ul className="bv-list">
						{task.acceptance.map((check, index) => (
							<li key={index}>
								{edit ? (
									<button
										aria-label={check.done ? `Mark "${check.text}" not met` : `Mark "${check.text}" met`}
										className={`bv-check codicon codicon-${check.done ? "pass-filled" : "circle-large-outline"}`}
										onClick={() =>
											void edit({ id: task.id, [check.done ? "uncheck" : "check"]: [index + 1] })
										}
										type="button"
									/>
								) : (
									<span
										aria-label={check.done ? "met" : "not met"}
										className={`codicon codicon-${check.done ? "pass-filled" : "circle-large-outline"}`}
										style={{ fontSize: 12, marginRight: 6, verticalAlign: "-2px" }}
									/>
								)}
								{check.text}
							</li>
						))}
					</ul>
				</Section>
			)}
			{task.gates && task.gates.length > 0 && (
				<Section title="Gates">
					<ul className="bv-list">
						{task.gates.map((gate) => {
							const uses = USE_PIPELINE.exec(gate.spec)?.[1]
							const state = gate.open ? "open" : gate.failed ? "failed" : uses ? "pending" : "waiting"
							return (
								<li key={gate.spec}>
									<span className="bv-chip" data-status={state}>
										{uses && state === "pending" ? "uses" : state}
									</span>{" "}
									{uses ? (
										<span>
											pipeline <span className="bv-mono">{uses}</span>, run when the task starts
										</span>
									) : (
										<span className="bv-mono">{gate.spec}</span>
									)}
									{gate.failed && <div className="bv-error">{gate.failed}</div>}
									{edit && (
										<span className="bv-gate-actions">
											{!gate.open && !uses && (
												<button
													className="bv-row-button"
													onClick={() => void edit({ id: task.id, gate_open: [gate.spec] })}
													title="Open it now: the task stops waiting on it"
													type="button">
													Resolve
												</button>
											)}
											<button
												className="bv-row-button"
												onClick={() => void edit({ id: task.id, gate_remove: [gate.spec] })}
												title="Take it off the task"
												type="button">
												Remove
											</button>
										</span>
									)}
								</li>
							)
						})}
					</ul>
				</Section>
			)}
			{task.links && task.links.length > 0 && (
				<Section title="Links">
					<ul className="bv-list">
						{task.links.map((link) => (
							<li key={`${link.type}:${link.target}`}>
								<span className="bv-muted">{link.type}</span> <span className="bv-mono">{link.target}</span>
							</li>
						))}
					</ul>
				</Section>
			)}
			{task.files.length > 0 && (
				<Section title="Files">
					<ul className="bv-list bv-mono">
						{task.files.map((file) => (
							<li key={file}>{file}</li>
						))}
					</ul>
				</Section>
			)}
			{task.outcome && (
				<Section title="Outcome">
					<div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{task.outcome}</div>
				</Section>
			)}
			{task.notes.length > 0 && (
				<Section title="Notes">
					<ul className="bv-list">
						{task.notes.map((note, index) => (
							<li key={index}>{note}</li>
						))}
					</ul>
				</Section>
			)}
		</div>
	)
}
