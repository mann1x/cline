import { type ReactNode, useState } from "react"
import type { TaskGraphPanelTask } from "@/components/chat/task-header/TaskGraphPanel"
import { nodeJson } from "./edit"
import { taskStatus } from "./graph"
import { formatDuration, type ViewerEvent, type ViewerNodeState, type ViewerPipelineNode, type ViewerReply } from "./model"
import { eventSummary } from "./report"

/** What the inspector shows: the selected card, and how it is edited when it can be (phase 4). */
export type InspectorSubject =
	| { kind: "node"; id: string; node?: ViewerPipelineNode; state?: ViewerNodeState; events: ViewerEvent[]; runStart?: number }
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

export function Inspector({
	subject,
	onOpenRun,
	nodeEdit,
	taskEdit,
}: {
	subject: InspectorSubject
	onOpenRun: (run: string) => void
	nodeEdit?: NodeEdit
	taskEdit?: TaskEdit
}) {
	switch (subject.kind) {
		case "node":
			return <NodeInspector edit={nodeEdit} key={subject.node ? nodeJson(subject.node) : subject.id} subject={subject} />
		case "task":
			return <TaskInspector edit={taskEdit} key={subject.task.id} onOpenRun={onOpenRun} task={subject.task} />
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

function NodeInspector({ subject, edit }: { subject: Extract<InspectorSubject, { kind: "node" }>; edit?: NodeEdit }) {
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
			</dl>
			{!node && <div className="bv-note">This node is not in the definition shown.</div>}
			{(state?.error || state?.lastError) && (
				<Section title="Error">
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
}: {
	label: string
	placeholder: string
	initial?: string
	action: string
	onSend: (value: string) => Promise<boolean>
}) {
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
				onChange={(event) => setValue(event.target.value)}
				placeholder={placeholder}
				value={value}
			/>
			<button className="bv-button" disabled={busy || !value.trim() || value.trim() === initial} type="submit">
				{action}
			</button>
		</form>
	)
}

function TaskControls({ task, edit }: { task: TaskGraphPanelTask; edit: TaskEdit }) {
	const [answer, setAnswer] = useState<ViewerReply>()
	const send = async (fields: Record<string, unknown>) => {
		const reply = await edit({ id: task.id, ...fields })
		setAnswer(reply)
		return reply.ok
	}
	const held = task.claimedBy?.startsWith("pipeline:")
	const statuses: { label: string; status: string }[] =
		task.status === "done" || task.status === "cancelled"
			? [{ label: "Reopen", status: "pending" }]
			: [
					...(task.status !== "active" ? [{ label: "Start", status: "active" }] : []),
					{ label: "Done", status: "done" },
					{ label: "Cancel", status: "cancelled" },
				]
	return (
		<Section title="Change">
			{held ? (
				<div className="bv-note">A pipeline run holds this task: its status is the run's.</div>
			) : (
				<div className="bv-actions">
					{statuses.map(({ label, status }) => (
						<button className="bv-button" key={status} onClick={() => void send({ status })} type="button">
							{label}
						</button>
					))}
				</div>
			)}
			<FieldForm
				action="Rename"
				initial={task.title}
				label="Title"
				onSend={(title) => send({ title })}
				placeholder="Title"
			/>
			<FieldForm
				action="Add"
				label="New acceptance item"
				onSend={(item) => send({ acceptance_add: [item] })}
				placeholder="Done when…"
			/>
			<FieldForm action="Add" label="New gate" onSend={(gate) => send({ gate: [gate] })} placeholder="human:Ship it?" />
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
}: {
	task: TaskGraphPanelTask
	onOpenRun: (run: string) => void
	edit?: TaskEdit
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
			{task.description && (
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
						{task.gates.map((gate) => (
							<li key={gate.spec}>
								<span className="bv-chip" data-status={gate.open ? "open" : gate.failed ? "failed" : "waiting"}>
									{gate.open ? "open" : gate.failed ? "failed" : "waiting"}
								</span>{" "}
								<span className="bv-mono">{gate.spec}</span>
								{gate.failed && <div className="bv-error">{gate.failed}</div>}
							</li>
						))}
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
			{edit && <TaskControls edit={edit} task={task} />}
		</div>
	)
}
