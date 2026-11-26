import type { ReactNode } from "react"
import type { TaskGraphPanelTask } from "@/components/chat/task-header/TaskGraphPanel"
import { taskStatus } from "./graph"
import { formatDuration, type ViewerEvent, type ViewerNodeState, type ViewerPipelineNode } from "./model"
import { eventSummary } from "./report"

/** What the inspector shows: the selected card. Read-only in phase 3; editing is phase 4. */
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

export function Inspector({ subject, onOpenRun }: { subject: InspectorSubject; onOpenRun: (run: string) => void }) {
	switch (subject.kind) {
		case "node":
			return <NodeInspector subject={subject} />
		case "task":
			return <TaskInspector onOpenRun={onOpenRun} task={subject.task} />
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

function NodeInspector({ subject }: { subject: Extract<InspectorSubject, { kind: "node" }> }) {
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
			{fields && Object.keys(fields).length > 0 && (
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

function TaskInspector({ task, onOpenRun }: { task: TaskGraphPanelTask; onOpenRun: (run: string) => void }) {
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
								<span
									aria-label={check.done ? "met" : "not met"}
									className={`codicon codicon-${check.done ? "pass-filled" : "circle-large-outline"}`}
									style={{ fontSize: 12, marginRight: 6, verticalAlign: "-2px" }}
								/>
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
		</div>
	)
}
