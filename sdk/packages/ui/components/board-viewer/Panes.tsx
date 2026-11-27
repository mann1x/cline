import type {
	ViewerSnapshot,
	ViewerSnapshotTask,
} from "@cline/taskboard/protocol";
import { useMemo, useState } from "react";
import { lineDiff } from "./edit.js";
import { taskStatus } from "./graph.js";
import { shortJson } from "./Inspector.js";
import {
	formatDuration,
	type ViewerPipeline,
	type ViewerPipelineDefinition,
	type ViewerRun,
} from "./model.js";
import { eventSummary, runNodeOrder, runReport } from "./report.js";

const clock = (ts: number | undefined) => {
	if (ts === undefined) return "";
	const date = new Date(ts);
	const pad = (n: number) => String(n).padStart(2, "0");
	const today = new Date();
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	return date.toDateString() === today.toDateString()
		? time
		: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${time}`;
};

const Chip = ({ status }: { status: string }) => (
	<span className="bv-chip" data-status={status}>
		{status}
	</span>
);

/** Plan: the board as a list, one column of the canvas per step. */
export function PlanPane({
	board,
	onSelect,
}: {
	board: ViewerSnapshot;
	onSelect: (task: string) => void;
}) {
	const byId = new Map(board.tasks.map((task) => [task.id, task]));
	const placed = new Set(board.layers.flat());
	const steps = board.layers
		.map((layer) =>
			layer
				.map((id) => byId.get(id))
				.filter((task): task is ViewerSnapshotTask => !!task),
		)
		.filter((layer) => layer.length > 0);
	const rest = board.tasks.filter((task) => !placed.has(task.id));
	const groups = [
		...steps.map((tasks, index) => ({ title: `Step ${index + 1}`, tasks })),
		...(rest.length > 0
			? [{ title: steps.length > 0 ? "Not placed" : "Tasks", tasks: rest }]
			: []),
	];
	return (
		<div className="bv-pane">
			{groups.map((group) => (
				<section className="bv-section" key={group.title}>
					<h3 className="bv-h">{group.title}</h3>
					<div className="bv-table-wrap">
						<table className="bv-table">
							<tbody>
								{group.tasks.map((task) => (
									<tr key={task.id}>
										<td className="bv-mono" style={{ width: 72 }}>
											{task.id}
										</td>
										<td style={{ width: 96 }}>
											<Chip status={taskStatus(task)} />
										</td>
										<td>
											<button
												className="bv-row-button"
												onClick={() => onSelect(task.id)}
												type="button"
											>
												{task.title}
											</button>
										</td>
										<td
											className="bv-mono"
											style={{ color: "var(--bv-muted)" }}
										>
											{(task.waitsOn ?? task.openDepends).join(", ")}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
			))}
		</div>
	);
}

/** Definition: the file as it is, with its validation and approval. */
/** The whole definition as JSON, applied to the draft (phase 4). */
export interface DefinitionEdit {
	/** The definition shown: the draft's, or the file's. */
	definition: ViewerPipelineDefinition;
	onApply: (json: string) => string | undefined;
}

function DefinitionEditor({ edit }: { edit: DefinitionEdit }) {
	const shown = JSON.stringify(edit.definition, null, "\t");
	const [text, setText] = useState(shown);
	const [error, setError] = useState<string>();
	return (
		<section className="bv-section">
			<h3 className="bv-h">Edit as JSON</h3>
			<textarea
				aria-label="The pipeline as JSON"
				className="bv-editor bv-tall"
				onChange={(event) => {
					setText(event.target.value);
					setError(undefined);
				}}
				spellCheck={false}
				value={text}
			/>
			{error && <div className="bv-error">{error}</div>}
			<div className="bv-actions">
				<button
					className="bv-button bv-primary"
					disabled={text === shown}
					onClick={() => setError(edit.onApply(text))}
					type="button"
				>
					Apply to the draft
				</button>
				<button
					className="bv-button"
					disabled={text === shown}
					onClick={() => setText(shown)}
					type="button"
				>
					Undo
				</button>
			</div>
		</section>
	);
}

export function DefinitionPane({
	pipeline,
	run,
	onOpenFile,
	edit,
}: {
	pipeline?: ViewerPipeline;
	run?: ViewerRun;
	onOpenFile: (path: string) => void;
	edit?: DefinitionEdit;
}) {
	if (run) {
		const changed = pipeline && run.hash && pipeline.hash !== run.hash;
		return (
			<div className="bv-pane">
				<div className="bv-actions">
					{pipeline && (
						<button
							className="bv-button"
							onClick={() => onOpenFile(pipeline.path)}
							type="button"
						>
							Open {pipeline.name}'s file
						</button>
					)}
				</div>
				{run.definition ? (
					<>
						<div className="bv-note">
							The definition this run used
							{run.hash ? ` (version ${run.hash})` : ""}
							{changed
								? `. The file has changed since: it is now version ${pipeline.hash}.`
								: "."}
						</div>
						<pre className="bv-pre bv-tall">
							{shortJson(run.definition, 200_000)}
						</pre>
					</>
				) : (
					<div className="bv-note">
						This run's journal did not record its definition (runs before
						4.100.302 did not).
					</div>
				)}
			</div>
		);
	}
	if (!pipeline) return null;
	return (
		<div className="bv-pane">
			<div className="bv-actions">
				<button
					className="bv-button"
					onClick={() => onOpenFile(pipeline.path)}
					type="button"
				>
					Open file
				</button>
			</div>
			<dl className="bv-kv" style={{ marginBottom: 12 }}>
				<dt>Version</dt>
				<dd className="bv-mono">{pipeline.hash}</dd>
				<dt>Approval</dt>
				<dd>
					{pipeline.isApproved ? (
						<Chip status="approved" />
					) : pipeline.approved ? (
						`Changed since version ${pipeline.approved.hash} was approved. Approve it again to run it.`
					) : (
						"Not approved. Approve it in the bar above, or with Cerebriline: Approve Pipeline."
					)}
				</dd>
			</dl>
			{pipeline.errors.length > 0 && (
				<section className="bv-section" style={{ marginBottom: 12 }}>
					<h3 className="bv-h">Does not validate</h3>
					<ul className="bv-list">
						{pipeline.errors.map((error) => (
							<li className="bv-error" key={error}>
								{error}
							</li>
						))}
					</ul>
				</section>
			)}
			{edit ? (
				<DefinitionEditor edit={edit} key={JSON.stringify(edit.definition)} />
			) : (
				<pre className="bv-pre bv-tall">{pipeline.text}</pre>
			)}
		</div>
	);
}

const when = (iso: string | undefined) => {
	if (!iso) return "";
	const ts = Date.parse(iso);
	return Number.isFinite(ts) ? clock(ts) : iso;
};

/** Versions: the proposal against the approved version, and the versions kept. */
export function VersionsPane({ pipeline }: { pipeline: ViewerPipeline }) {
	const diff = useMemo(
		() =>
			pipeline.approvedText !== undefined && !pipeline.isApproved
				? lineDiff(pipeline.approvedText, pipeline.text)
				: undefined,
		[pipeline.approvedText, pipeline.text, pipeline.isApproved],
	);
	const versions = pipeline.versions ?? [];
	return (
		<div className="bv-pane">
			{pipeline.isApproved ? (
				<div className="bv-note">
					The file is the approved version {pipeline.hash}.
				</div>
			) : diff ? (
				<section className="bv-section">
					<h3 className="bv-h">
						Version {pipeline.hash} against the approved{" "}
						{pipeline.approved?.hash}
					</h3>
					<pre className="bv-pre bv-diff bv-tall">
						{diff.map((line, index) => (
							<span className="bv-diff-line" data-kind={line.kind} key={index}>
								{line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
								{line.text}
								{"\n"}
							</span>
						))}
					</pre>
				</section>
			) : pipeline.approved ? (
				<div className="bv-note">
					The approved version {pipeline.approved.hash} was not kept here (it
					was approved before versions were kept), so there is nothing to
					compare against: Git has it.
				</div>
			) : (
				<div className="bv-note">Never approved: the whole file is new.</div>
			)}
			<section className="bv-section">
				<h3 className="bv-h">Kept versions</h3>
				{versions.length === 0 ? (
					<div className="bv-note">
						None kept yet: a version is kept when it is saved or approved.
					</div>
				) : (
					<table className="bv-table">
						<thead>
							<tr>
								<th>Version</th>
								<th>By</th>
								<th>Saved</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{versions.map((version) => (
								<tr key={version.hash}>
									<td className="bv-mono">{version.hash}</td>
									<td>{version.by === "model" ? "the model" : "you"}</td>
									<td>{when(version.at)}</td>
									<td>
										{version.hash === pipeline.approved?.hash && (
											<Chip status="approved" />
										)}
										{version.hash === pipeline.hash && (
											<Chip status="current" />
										)}
										{version.rejected && <Chip status="rejected" />}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			</section>
		</div>
	);
}

/** A pipeline's runs. */
export function RunsPane({
	runs,
	onOpenRun,
}: {
	runs: ViewerRun[];
	onOpenRun: (run: string) => void;
}) {
	if (runs.length === 0) {
		return (
			<div className="bv-pane">
				<div className="bv-note">No runs of this pipeline yet.</div>
			</div>
		);
	}
	return (
		<div className="bv-pane">
			<div className="bv-table-wrap">
				<table className="bv-table">
					<thead>
						<tr>
							<th>Run</th>
							<th>Status</th>
							<th>Started</th>
							<th>Took</th>
							<th>Version</th>
							<th>From</th>
						</tr>
					</thead>
					<tbody>
						{runs.map((run) => (
							<tr key={run.id}>
								<td>
									<button
										className="bv-row-button bv-mono"
										onClick={() => onOpenRun(run.id)}
										type="button"
									>
										{run.id}
									</button>
								</td>
								<td>
									<Chip status={run.status} />
								</td>
								<td>{clock(run.startedAt)}</td>
								<td>
									{run.startedAt !== undefined && run.endedAt !== undefined
										? formatDuration(run.endedAt - run.startedAt)
										: ""}
								</td>
								<td className="bv-mono">{run.hash}</td>
								<td className="bv-mono">{run.from ?? run.parent ?? ""}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

/** Run monitor: one row per node, a bar over the run's span for each. */
export function RunMonitorPane({
	run,
	definition,
	onSelect,
}: {
	run: ViewerRun;
	definition?: ViewerPipelineDefinition;
	onSelect: (node: string) => void;
}) {
	const order = runNodeOrder(run, definition);
	const types = new Map(
		(definition?.nodes ?? []).map((node) => [node.id, node.type]),
	);
	const lastTs = run.events.at(-1)?.ts;
	const start =
		run.startedAt ??
		Math.min(
			...order.map(
				(id) => run.nodes[id]?.startedAt ?? Number.POSITIVE_INFINITY,
			),
		);
	const end = run.endedAt ?? lastTs ?? start;
	const span = Math.max(end - start, 1);
	const pct = (ts: number) =>
		`${Math.min(100, Math.max(0, ((ts - start) / span) * 100))}%`;
	return (
		<div className="bv-pane">
			<dl className="bv-kv" style={{ marginBottom: 14 }}>
				<dt>Status</dt>
				<dd>
					<Chip status={run.status} />{" "}
					{run.error && <span className="bv-error">{run.error}</span>}
				</dd>
				<dt>Pipeline</dt>
				<dd>
					{run.pipeline}
					{run.hash && <span className="bv-mono"> · {run.hash}</span>}
				</dd>
				{run.startedAt !== undefined && (
					<>
						<dt>Started</dt>
						<dd>
							{clock(run.startedAt)}
							{run.endedAt !== undefined &&
								`, took ${formatDuration(run.endedAt - run.startedAt)}`}
						</dd>
					</>
				)}
				{Object.keys(run.inputs).length > 0 && (
					<>
						<dt>Inputs</dt>
						<dd className="bv-mono">{JSON.stringify(run.inputs)}</dd>
					</>
				)}
				{run.from && (
					<>
						<dt>Re-run of</dt>
						<dd className="bv-mono">{run.from}</dd>
					</>
				)}
				{run.parent && (
					<>
						<dt>Sub-run of</dt>
						<dd className="bv-mono">{run.parent}</dd>
					</>
				)}
				{run.task && (
					<>
						<dt>Board task</dt>
						<dd className="bv-mono">{run.task}</dd>
					</>
				)}
			</dl>
			{order.length === 0 ? (
				<div className="bv-note">No node has started yet.</div>
			) : (
				<div className="bv-timeline" role="table">
					<div className="bv-timeline-head" role="columnheader">
						Node
					</div>
					<div className="bv-timeline-head" role="columnheader">
						Status
					</div>
					<div className="bv-timeline-head" role="columnheader">
						{clock(start)} → {formatDuration(span)}
					</div>
					<div
						className="bv-timeline-head"
						role="columnheader"
						style={{ textAlign: "right" }}
					>
						Took
					</div>
					{order.map((id) => {
						const state = run.nodes[id];
						const status = state
							? state.waitingOn
								? "waiting"
								: state.status
							: "pending";
						const from = state?.startedAt;
						const to =
							state?.endedAt ??
							(status === "running" || status === "waiting" ? end : undefined);
						return (
							<div key={id} role="row" style={{ display: "contents" }}>
								<div className="bv-timeline-name" role="cell">
									<button
										className="bv-row-button bv-mono"
										onClick={() => onSelect(id)}
										type="button"
									>
										{id}
									</button>{" "}
									<span style={{ color: "var(--bv-muted)" }}>
										{types.get(id) ?? ""}
									</span>
								</div>
								<div role="cell">
									<Chip status={status} />
									{state && state.attempts > 1 && (
										<span style={{ color: "var(--bv-muted)", marginLeft: 4 }}>
											×{state.attempts}
										</span>
									)}
								</div>
								<div className="bv-track" role="cell">
									{from !== undefined && to !== undefined && (
										<div
											className="bv-bar"
											data-status={status}
											style={{
												left: pct(from),
												width: `calc(${pct(to)} - ${pct(from)})`,
											}}
											title={`${id}: ${status}`}
										/>
									)}
								</div>
								<div className="bv-timeline-time" role="cell">
									{from !== undefined && state?.endedAt !== undefined
										? formatDuration(state.endedAt - from)
										: ""}
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

/** Activity: the journal, oldest first, with each event's time into the run. */
export function ActivityPane({ run }: { run: ViewerRun }) {
	const [node, setNode] = useState("");
	const start = run.startedAt ?? run.events[0]?.ts ?? 0;
	const nodes = useMemo(
		() => [
			...new Set(
				run.events
					.map((event) => event.node)
					.filter((id): id is string => typeof id === "string"),
			),
		],
		[run.events],
	);
	const events = node
		? run.events.filter((event) => event.node === node)
		: run.events;
	return (
		<div className="bv-pane">
			<div className="bv-actions" style={{ alignItems: "center" }}>
				<label htmlFor="bv-activity-node" style={{ color: "var(--bv-muted)" }}>
					Node
				</label>
				<select
					id="bv-activity-node"
					onChange={(event) => setNode(event.target.value)}
					value={node}
				>
					<option value="">All</option>
					{nodes.map((id) => (
						<option key={id} value={id}>
							{id}
						</option>
					))}
				</select>
				{run.eventCount > run.events.length && (
					<span className="bv-note" style={{ margin: 0 }}>
						The last {run.events.length} of {run.eventCount} events.
					</span>
				)}
			</div>
			<div className="bv-table-wrap">
				<table className="bv-table">
					<thead>
						<tr>
							<th>Time</th>
							<th>Event</th>
							<th>Node</th>
							<th>What happened</th>
						</tr>
					</thead>
					<tbody>
						{events.map((event, index) => (
							<tr key={`${event.ts}-${index}`}>
								<td className="bv-event-time">
									+{formatDuration(event.ts - start) || "0 ms"}
								</td>
								<td className="bv-event-kind" data-kind={event.t}>
									{event.t}
								</td>
								<td className="bv-mono">{event.node ?? ""}</td>
								<td style={{ overflowWrap: "anywhere" }}>
									{eventSummary(event)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}

/** Report: the run's summary as Markdown, to copy or save. */
export function ReportPane({
	run,
	definition,
	onSave,
}: {
	run: ViewerRun;
	definition?: ViewerPipelineDefinition;
	onSave: (name: string, text: string) => void;
}) {
	const text = useMemo(() => runReport(run, definition), [run, definition]);
	const [copied, setCopied] = useState(false);
	return (
		<div className="bv-pane">
			<div className="bv-actions" style={{ alignItems: "center" }}>
				<button
					className="bv-button"
					onClick={() => {
						void navigator.clipboard?.writeText(text).then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						});
					}}
					type="button"
				>
					Copy
				</button>
				<button
					className="bv-button"
					onClick={() => onSave(run.id, text)}
					type="button"
				>
					Save…
				</button>
				{copied && (
					<span className="bv-note" style={{ margin: 0 }}>
						Copied.
					</span>
				)}
			</div>
			<pre className="bv-pre bv-wrap bv-tall">{text}</pre>
		</div>
	);
}
