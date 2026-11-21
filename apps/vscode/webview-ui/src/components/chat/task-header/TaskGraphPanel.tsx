import type { ClineMessage } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { memo, useCallback, useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { StateServiceClient } from "@/services/grpc-client"

/**
 * The conversation's task graph, under the context window. The person can
 * change it from here: start, finish, cancel or reopen a task, tick its
 * acceptance, add a task. Each change goes to the running session's board as
 * the person's, and the model is told what changed with its next look.
 *
 * Core sends the whole board as a `say: "task_graph"` row after every change,
 * and the newest one wins, as the checklist's does. The shape mirrors core's
 * `TaskGraphSnapshot`; it is restated rather than imported because the
 * webview does not depend on `@cline/core`, and read defensively because a
 * persisted row outlives the version that wrote it.
 */

export interface TaskGraphPanelTask {
	id: string
	title: string
	description?: string
	status: "pending" | "active" | "waiting" | "done" | "cancelled"
	priority: "H" | "M" | "L"
	parent?: string
	depends: string[]
	openDepends: string[]
	acceptance: { text: string; done: boolean }[]
	later: boolean
	claimedBy?: string
	files: string[]
	notes: string[]
	outcome?: string
	ready: boolean
	blocked: boolean
}

export interface TaskGraphPanelSnapshot {
	tasks: TaskGraphPanelTask[]
	layers: string[][]
}

/** The newest board in the transcript, or undefined. */
export function findLatestTaskGraph(messages: ClineMessage[]): TaskGraphPanelSnapshot | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message.say !== "task_graph" || !message.text) {
			continue
		}
		try {
			const parsed = JSON.parse(message.text) as Partial<TaskGraphPanelSnapshot>
			if (!Array.isArray(parsed.tasks)) {
				return undefined
			}
			return {
				tasks: parsed.tasks.filter(
					(task): task is TaskGraphPanelTask =>
						typeof task?.id === "string" && typeof task?.title === "string" && typeof task?.status === "string",
				),
				layers: Array.isArray(parsed.layers) ? parsed.layers : [],
			}
		} catch {
			return undefined
		}
	}
	return undefined
}

const isClosed = (task: TaskGraphPanelTask) => task.status === "done" || task.status === "cancelled"

function statusChip(task: TaskGraphPanelTask): { glyph: string; label: string; className: string } {
	if (task.status === "done") return { glyph: "✓", label: "done", className: "text-success" }
	if (task.status === "cancelled") return { glyph: "✕", label: "cancelled", className: "opacity-60" }
	if (task.status === "active") return { glyph: "▶", label: "active", className: "text-link" }
	if (task.status === "waiting") return { glyph: "⏸", label: "waiting", className: "text-warning" }
	if (task.later) return { glyph: "…", label: "parked", className: "opacity-60" }
	if (task.blocked) return { glyph: "○", label: `after ${task.openDepends.join(", ")}`, className: "opacity-70" }
	if (task.ready) return { glyph: "●", label: "ready", className: "" }
	return { glyph: "○", label: "pending", className: "opacity-70" }
}

export function taskGraphHeader(tasks: TaskGraphPanelTask[]): string {
	const closed = tasks.filter(isClosed).length
	const parts = [`${closed}/${tasks.length}`]
	const active = tasks.filter((task) => task.status === "active").length
	const blocked = tasks.filter((task) => task.blocked).length
	if (active) parts.push(`${active} active`)
	if (blocked) parts.push(`${blocked} blocked`)
	return parts.join(" · ")
}

/** A change to the board, in `task_update`'s or `task_plan`'s shape. */
export type TaskGraphPanelAction =
	| { op: "update"; updates: Record<string, unknown>[] }
	| { op: "plan"; tasks: Record<string, unknown>[] }

export type SendTaskGraphAction = (action: TaskGraphPanelAction) => void

const linkButton = "bg-transparent border-0 p-0 cursor-pointer text-link text-xs hover:underline"

/** A one-line text box with a confirm, for an outcome, a reason or a title. */
const InlineText = ({
	label,
	placeholder,
	required,
	onSubmit,
	onCancel,
}: {
	label: string
	placeholder: string
	required: boolean
	onSubmit: (text: string) => void
	onCancel: () => void
}) => {
	const [text, setText] = useState("")
	const submit = () => {
		if (required && !text.trim()) return
		onSubmit(text.trim())
	}
	return (
		<form
			className="flex gap-1 items-center min-w-0"
			onSubmit={(event) => {
				event.preventDefault()
				submit()
			}}>
			<input
				aria-label={label}
				autoFocus
				className="min-w-0 flex-1 text-xs bg-input-background text-input-foreground border border-input-border rounded-xs px-1 py-0.5"
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") onCancel()
				}}
				placeholder={placeholder}
				value={text}
			/>
			<button className={linkButton} disabled={required && !text.trim()} type="submit">
				{label}
			</button>
			<button className={linkButton} onClick={onCancel} type="button">
				Back
			</button>
		</form>
	)
}

/** What can be done to a task from the panel. */
const TaskActions = ({ task, send }: { task: TaskGraphPanelTask; send: SendTaskGraphAction }) => {
	const [asking, setAsking] = useState<"done" | "cancelled" | undefined>(undefined)
	const update = (fields: Record<string, unknown>) => send({ op: "update", updates: [{ id: task.id, ...fields }] })
	if (asking) {
		return (
			<InlineText
				label={asking === "done" ? "Mark done" : "Cancel task"}
				onCancel={() => setAsking(undefined)}
				onSubmit={(note) => {
					update({ status: asking, ...(note ? { note } : {}) })
					setAsking(undefined)
				}}
				placeholder={asking === "done" ? "What was done (optional)" : "Why it is not needed"}
				required={asking === "cancelled"}
			/>
		)
	}
	return (
		<div className="flex gap-2 flex-wrap">
			{isClosed(task) ? (
				<button className={linkButton} onClick={() => update({ status: "pending" })} type="button">
					Reopen
				</button>
			) : (
				<>
					{task.status !== "active" && task.ready && (
						<button className={linkButton} onClick={() => update({ status: "active" })} type="button">
							Start
						</button>
					)}
					<button className={linkButton} onClick={() => setAsking("done")} type="button">
						Done…
					</button>
					<button className={linkButton} onClick={() => setAsking("cancelled")} type="button">
						Cancel…
					</button>
				</>
			)}
		</div>
	)
}

const TaskDetail = ({ task, send }: { task: TaskGraphPanelTask; send?: SendTaskGraphAction }) => (
	<div className="pl-4 pr-1 pb-1 flex flex-col gap-0.5 text-xs opacity-90">
		{task.description && <div className="break-words">{task.description}</div>}
		{task.depends.length > 0 && <div>after: {task.depends.join(", ")}</div>}
		{task.acceptance.length > 0 && (
			<ul className="list-none m-0 p-0">
				{task.acceptance.map((item, index) => (
					<li className="flex gap-1 items-baseline" key={`${index}-${item.text}`}>
						{send ? (
							<button
								aria-label={`${item.done ? "Untick" : "Tick"}: ${item.text}`}
								className="shrink-0 bg-transparent border-0 p-0 cursor-pointer text-description"
								onClick={() =>
									send({
										op: "update",
										updates: [{ id: task.id, [item.done ? "uncheck" : "check"]: [index + 1] }],
									})
								}
								type="button">
								{item.done ? "☑" : "☐"}
							</button>
						) : (
							<span className="shrink-0">{item.done ? "☑" : "☐"}</span>
						)}
						<span className="break-words min-w-0">{item.text}</span>
					</li>
				))}
			</ul>
		)}
		{task.outcome && <div className="break-words">outcome: {task.outcome}</div>}
		{task.files.length > 0 && <div className="break-words">files: {task.files.join(", ")}</div>}
		{task.notes.length > 0 && (
			<ul className="list-none m-0 p-0">
				{task.notes.slice(-5).map((note, index) => (
					<li className="break-words" key={`${index}-${note}`}>
						– {note}
					</li>
				))}
			</ul>
		)}
		{send && <TaskActions send={send} task={task} />}
	</div>
)

const TaskRow = ({
	task,
	depth,
	open,
	onToggle,
	send,
}: {
	task: TaskGraphPanelTask
	depth: number
	open: boolean
	onToggle: () => void
	send?: SendTaskGraphAction
}) => {
	const chip = statusChip(task)
	return (
		<li className="flex flex-col min-w-0">
			<button
				aria-expanded={open}
				className={cn(
					"flex items-baseline gap-1 min-w-0 w-full text-left text-xs bg-transparent border-0 p-0 cursor-pointer text-description",
					{ "line-through opacity-60": isClosed(task) },
				)}
				onClick={onToggle}
				style={{ paddingLeft: `${depth * 12}px` }}
				type="button">
				<span className={cn("shrink-0", chip.className)}>{chip.glyph}</span>
				<span className="shrink-0 font-mono opacity-80">{task.id}</span>
				<span className="break-words min-w-0">{task.title}</span>
				<span className={cn("shrink-0 opacity-70", chip.className)}>· {chip.label}</span>
				{task.claimedBy && <span className="shrink-0 opacity-70">· {task.claimedBy}</span>}
			</button>
			{open && <TaskDetail send={send} task={task} />}
		</li>
	)
}

interface TaskGraphPanelProps {
	clineMessages: ClineMessage[]
}

export const TaskGraphPanel = memo(({ clineMessages }: TaskGraphPanelProps) => {
	const [isExpanded, setIsExpanded] = useState(false)
	const [tab, setTab] = useState<"list" | "graph">("list")
	const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set())
	const [reply, setReply] = useState<{ ok: boolean; text: string } | undefined>(undefined)
	const [adding, setAdding] = useState(false)

	const send = useCallback<SendTaskGraphAction>((action) => {
		void (async () => {
			try {
				const response = await StateServiceClient.taskGraphAction(StringRequest.create({ value: JSON.stringify(action) }))
				const answer = JSON.parse(response.value) as { ok?: boolean; lines?: string[] }
				setReply({ ok: answer.ok === true, text: (answer.lines ?? []).join(" ") })
			} catch (error) {
				setReply({ ok: false, text: error instanceof Error ? error.message : String(error) })
			}
		})()
	}, [])

	const snapshot = useMemo(() => findLatestTaskGraph(clineMessages), [clineMessages])
	const tasks = snapshot?.tasks ?? []

	// Children under their parent, in creation order; a task whose parent is
	// missing from the snapshot is shown at the top rather than lost.
	const ordered = useMemo(() => {
		const ids = new Set(tasks.map((task) => task.id))
		const rows: { task: TaskGraphPanelTask; depth: number }[] = []
		const visit = (parent: string | undefined, depth: number) => {
			for (const task of tasks) {
				const effectiveParent = task.parent && ids.has(task.parent) ? task.parent : undefined
				if (effectiveParent === parent) {
					rows.push({ task, depth })
					visit(task.id, depth + 1)
				}
			}
		}
		visit(undefined, 0)
		return rows
	}, [tasks])

	if (tasks.length === 0) {
		return null
	}

	const byId = new Map(tasks.map((task) => [task.id, task]))
	const active = tasks.find((task) => task.status === "active")
	const allClosed = tasks.every(isClosed)
	const toggle = (id: string) =>
		setOpenIds((current) => {
			const next = new Set(current)
			if (next.has(id)) next.delete(id)
			else next.add(id)
			return next
		})

	return (
		<div className="flex flex-col mt-1 text-description" data-testid="task-graph-panel">
			<button
				aria-expanded={isExpanded}
				className="flex items-center gap-1 w-full text-left cursor-pointer bg-transparent border-0 p-0 text-description"
				onClick={() => setIsExpanded((value) => !value)}
				type="button">
				{isExpanded ? (
					<ChevronDownIcon className="!size-1 shrink-0" />
				) : (
					<ChevronRightIcon className="!size-1 shrink-0" />
				)}
				<span className="text-xs font-bold">Tasks</span>
				<span className={cn("text-xs", { "text-success": allClosed })}>{taskGraphHeader(tasks)}</span>
				{!isExpanded && active && (
					<span className="text-xs truncate min-w-0 opacity-80">
						{active.id} {active.title}
					</span>
				)}
			</button>

			{isExpanded && (
				<div className="flex flex-col gap-1 mt-0.5 pl-2">
					<div className="flex gap-2 text-xs" role="tablist">
						{(["list", "graph"] as const).map((name) => (
							<button
								aria-selected={tab === name}
								className={cn("bg-transparent border-0 p-0 cursor-pointer text-description", {
									"font-bold underline": tab === name,
									"opacity-70": tab !== name,
								})}
								key={name}
								onClick={() => setTab(name)}
								role="tab"
								type="button">
								{name === "list" ? "List" : "Graph"}
							</button>
						))}
					</div>
					{tab === "list" ? (
						<ul className="list-none m-0 p-0 flex flex-col gap-0.5">
							{ordered.map(({ task, depth }) => (
								<TaskRow
									depth={depth}
									key={task.id}
									onToggle={() => toggle(task.id)}
									open={openIds.has(task.id)}
									send={send}
									task={task}
								/>
							))}
							<li className="text-xs">
								{adding ? (
									<InlineText
										label="Add"
										onCancel={() => setAdding(false)}
										onSubmit={(title) => {
											send({ op: "plan", tasks: [{ title }] })
											setAdding(false)
										}}
										placeholder="New task"
										required
									/>
								) : (
									<button className={linkButton} onClick={() => setAdding(true)} type="button">
										+ Add task
									</button>
								)}
							</li>
						</ul>
					) : snapshot && snapshot.layers.length > 0 ? (
						<ol className="list-none m-0 p-0 flex flex-col gap-0.5 text-xs">
							{snapshot.layers.map((layer, index) => (
								<li className="break-words" key={layer.join(",")}>
									<span className="font-bold">Layer {index}</span>
									{index === 0 ? " (can start now)" : ""}:{" "}
									{layer.map((id) => `${id} ${byId.get(id)?.title ?? ""}`.trim()).join(" · ")}
								</li>
							))}
						</ol>
					) : (
						<div className="text-xs opacity-80">No open tasks.</div>
					)}
					{reply && (
						<div className={cn("text-xs break-words", reply.ok ? "opacity-80" : "text-error")} role="status">
							{reply.text}
						</div>
					)}
				</div>
			)}
		</div>
	)
})

TaskGraphPanel.displayName = "TaskGraphPanel"
