import { readBoardSnapshot, type ViewerSnapshot, type ViewerSnapshotTask } from "@shared/board-viewer"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { memo, useCallback, useMemo, useState } from "react"
import MermaidBlock from "@/components/common/MermaidBlock"
import { cn } from "@/lib/utils"
import { FileServiceClient, StateServiceClient } from "@/services/grpc-client"

/**
 * The conversation's task graph, under the context window. The person can
 * change it from here: start, finish, cancel or reopen a task, tick its
 * acceptance, add a task. Each change goes to the running session's board as
 * the person's, and the model is told what changed with its next look.
 *
 * Core sends the whole board as a `say: "task_graph"` row after every change,
 * and the newest one wins, as the checklist's does. The shape mirrors core's
 * `TaskGraphSnapshot`, as `@cline/taskboard/protocol` restates it for
 * clients, and is read with that protocol's defensive parser because a
 * persisted row outlives the version that wrote it.
 */

export type TaskGraphPanelTask = ViewerSnapshotTask
export type TaskGraphPanelSnapshot = ViewerSnapshot

/** The newest board in the transcript, or undefined. */
export function findLatestTaskGraph(messages: ClineMessage[]): TaskGraphPanelSnapshot | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message.say === "task_graph" && message.text) {
			return readBoardSnapshot(message.text)
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
	if (task.blocked)
		return { glyph: "○", label: `after ${(task.waitsOn ?? task.openDepends).join(", ")}`, className: "opacity-70" }
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

/** A Mermaid label: quotes and brackets would end it early. */
const mermaidLabel = (text: string) =>
	text
		.replace(/["[\]{}()<>|]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 40)

/**
 * The board as a Mermaid flowchart, drawn in the Graph tab: subtasks inside
 * their parent, dependencies as arrows, task links dotted, gates as their own
 * nodes. The same drawing `task_view mermaid` gives the model.
 */
export function taskGraphMermaid(tasks: TaskGraphPanelTask[]): string {
	const node = (id: string) => id.replace(/\./g, "_")
	const ids = new Set(tasks.map((task) => task.id))
	const lines = ["flowchart TD"]
	const label = (task: TaskGraphPanelTask) => `${node(task.id)}["${task.id} ${mermaidLabel(task.title)}"]:::${task.status}`
	const emit = (task: TaskGraphPanelTask, indent: string) => {
		const kids = tasks.filter((child) => child.parent === task.id)
		if (kids.length) {
			lines.push(`${indent}subgraph ${node(task.id)}_group["${task.id} ${mermaidLabel(task.title)}"]`)
			lines.push(`${indent}  ${label(task)}`)
			for (const kid of kids) emit(kid, `${indent}  `)
			lines.push(`${indent}end`)
		} else {
			lines.push(`${indent}${label(task)}`)
		}
	}
	for (const task of tasks) if (!task.parent || !ids.has(task.parent)) emit(task, "  ")
	let gateCount = 0
	for (const task of tasks) {
		for (const dep of task.depends) if (ids.has(dep)) lines.push(`  ${node(dep)} --> ${node(task.id)}`)
		for (const link of task.links ?? [])
			if (ids.has(link.target)) lines.push(`  ${node(link.target)} -. ${link.type} .-> ${node(task.id)}`)
		for (const gate of task.gates ?? []) {
			gateCount += 1
			lines.push(
				`  G${gateCount}{{"${mermaidLabel(gate.spec)}"}}:::${gate.open ? "gateopen" : "gate"} --> ${node(task.id)}`,
			)
		}
	}
	lines.push(
		"  classDef done fill:#2e7d32,color:#fff",
		"  classDef cancelled fill:#757575,color:#fff",
		"  classDef active fill:#1565c0,color:#fff",
		"  classDef waiting fill:#ef6c00,color:#fff",
		"  classDef pending fill:#fff,color:#000,stroke:#999",
		"  classDef gate fill:#fff3e0,color:#000,stroke:#ef6c00",
		"  classDef gateopen fill:#e8f5e9,color:#000,stroke:#2e7d32",
	)
	return lines.join("\n")
}

/** The task panel's own calls (templates), answered as JSON. */
async function callBoard(action: Record<string, unknown>) {
	const response = await StateServiceClient.taskGraphAction(StringRequest.create({ value: JSON.stringify(action) }))
	return JSON.parse(response.value) as {
		ok?: boolean
		lines?: string[]
		templates?: { name: string; description?: string; vars: string[]; tasks: number }[]
	}
}

/** "Saved plans": start from one, or save this board as one. */
const SavedPlans = ({ onReply }: { onReply: (reply: { ok: boolean; text: string }) => void }) => {
	const [mode, setMode] = useState<"closed" | "use" | "save">("closed")
	const [templates, setTemplates] = useState<{ name: string; vars: string[]; tasks: number }[]>([])
	const [chosen, setChosen] = useState("")
	const [vars, setVars] = useState("")
	const fail = (error: unknown) => onReply({ ok: false, text: error instanceof Error ? error.message : String(error) })
	const openUse = async () => {
		try {
			const answer = await callBoard({ op: "templates" })
			const list = answer.templates ?? []
			if (list.length === 0) {
				onReply({
					ok: false,
					text: "No saved plans yet. Save a board as one, or add JSON files under .cerebriline/task-templates/.",
				})
				return
			}
			setTemplates(list)
			setChosen(list[0]?.name ?? "")
			setMode("use")
		} catch (error) {
			fail(error)
		}
	}
	const use = async () => {
		const values = Object.fromEntries(
			vars
				.split(",")
				.map((pair) => pair.split("="))
				.filter((pair) => pair.length === 2 && pair[0]?.trim())
				.map(([key, value]) => [key?.trim(), value?.trim() ?? ""]),
		)
		try {
			const answer = await callBoard({ op: "template-use", name: chosen, vars: values })
			onReply({ ok: answer.ok === true, text: (answer.lines ?? []).join(" ") })
			setMode("closed")
		} catch (error) {
			fail(error)
		}
	}
	if (mode === "save") {
		return (
			<InlineText
				label="Save plan"
				onCancel={() => setMode("closed")}
				onSubmit={(name) => {
					void callBoard({ op: "template-save", name })
						.then((answer) => onReply({ ok: answer.ok === true, text: (answer.lines ?? []).join(" ") }))
						.catch(fail)
					setMode("closed")
				}}
				placeholder="Name for this plan"
				required
			/>
		)
	}
	if (mode === "use") {
		const vars0 = templates.find((template) => template.name === chosen)?.vars ?? []
		return (
			<div className="flex gap-2 items-center flex-wrap text-xs">
				<select
					aria-label="Saved plan to start from"
					className="text-xs bg-input-background text-input-foreground border border-input-border"
					onChange={(event) => setChosen(event.target.value)}
					value={chosen}>
					{templates.map((template) => (
						<option key={template.name} value={template.name}>
							{template.name} ({template.tasks} tasks)
						</option>
					))}
				</select>
				{vars0.length > 0 && (
					<input
						aria-label="Values for the plan"
						className="min-w-0 text-xs bg-input-background text-input-foreground border border-input-border rounded-xs px-1 py-0.5"
						onChange={(event) => setVars(event.target.value)}
						placeholder={vars0.map((name) => `${name}=…`).join(", ")}
						value={vars}
					/>
				)}
				<button className={linkButton} onClick={() => void use()} type="button">
					Add to board
				</button>
				<button className={linkButton} onClick={() => setMode("closed")} type="button">
					Back
				</button>
			</div>
		)
	}
	return (
		<span className="flex gap-2">
			<button
				className={linkButton}
				onClick={() => void callBoard({ op: "open-viewer" })}
				title="The board, the workspace's pipelines and their runs, in an editor tab"
				type="button">
				Open board
			</button>
			<button className={linkButton} onClick={() => void openUse()} type="button">
				Start from a saved plan…
			</button>
			<button className={linkButton} onClick={() => setMode("save")} type="button">
				Save as a plan…
			</button>
		</span>
	)
}

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

/** "Save to memory": which memory, and whether the saved board follows this conversation. */
const SaveToMemory = ({ onReply }: { onReply: (reply: { ok: boolean; text: string }) => void }) => {
	const [choice, setChoice] = useState<{ names: string[]; memory: string; keepUpdated: boolean } | undefined>(undefined)
	const call = async (action: Record<string, unknown>) => {
		const response = await StateServiceClient.taskGraphAction(StringRequest.create({ value: JSON.stringify(action) }))
		return JSON.parse(response.value) as {
			ok?: boolean
			lines?: string[]
			memories?: { enabled: boolean; names: string[]; preferred: string }
		}
	}
	const open = async () => {
		try {
			const answer = await call({ op: "memories" })
			if (!answer.memories?.enabled) {
				onReply({ ok: false, text: "Memory is off. Turn it on under Settings → Memory to save the board." })
				return
			}
			setChoice({ names: answer.memories.names, memory: answer.memories.preferred, keepUpdated: false })
		} catch (error) {
			onReply({ ok: false, text: error instanceof Error ? error.message : String(error) })
		}
	}
	const save = async () => {
		if (!choice) return
		try {
			const answer = await call({ op: "save", memory: choice.memory, keepUpdated: choice.keepUpdated })
			onReply({ ok: answer.ok === true, text: (answer.lines ?? []).join(" ") })
			setChoice(undefined)
		} catch (error) {
			onReply({ ok: false, text: error instanceof Error ? error.message : String(error) })
		}
	}
	if (!choice) {
		return (
			<button className={linkButton} onClick={() => void open()} type="button">
				Save to memory…
			</button>
		)
	}
	return (
		<div className="flex gap-2 items-center flex-wrap text-xs">
			<select
				aria-label="Memory to save the board in"
				className="text-xs bg-input-background text-input-foreground border border-input-border"
				onChange={(event) => setChoice({ ...choice, memory: event.target.value })}
				value={choice.memory}>
				{choice.names.map((name) => (
					<option key={name} value={name}>
						{name}
					</option>
				))}
			</select>
			<label className="flex items-center gap-1 cursor-pointer">
				<input
					checked={choice.keepUpdated}
					onChange={(event) => setChoice({ ...choice, keepUpdated: event.target.checked })}
					type="checkbox"
				/>
				Keep it updated
			</label>
			<button className={linkButton} onClick={() => void save()} type="button">
				Save
			</button>
			<button className={linkButton} onClick={() => setChoice(undefined)} type="button">
				Back
			</button>
		</div>
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

/** A link's target as something to press: a task, a URL, a file. */
const LinkTarget = ({ link, onShowTask }: { link: { type: string; target: string }; onShowTask?: (id: string) => void }) => {
	if (/^T\d+(?:\.\d+)*$/.test(link.target) && onShowTask) {
		return (
			<button className={linkButton} onClick={() => onShowTask(link.target)} type="button">
				{link.target}
			</button>
		)
	}
	if (link.type === "url") {
		return (
			<a className="text-link break-all" href={link.target}>
				{link.target}
			</a>
		)
	}
	return <span className="break-all">{link.target}</span>
}

/**
 * The chat rows of the calls that put tasks on the board, by call id: where
 * each task was planned. Rows written before the id was stamped have none.
 */
export function plannedRows(messages: readonly ClineMessage[]): Map<string, number> {
	const rows = new Map<string, number>()
	for (const message of messages) {
		if ((message.say !== "tool" && message.ask !== "tool") || !message.text?.includes('"callId"')) continue
		try {
			const callId = (JSON.parse(message.text) as { callId?: unknown }).callId
			if (typeof callId === "string" && !rows.has(callId)) rows.set(callId, message.ts)
		} catch {
			// Not a tool row's JSON.
		}
	}
	return rows
}

const TaskDetail = ({
	task,
	send,
	onShowTask,
	onShowPlanned,
}: {
	task: TaskGraphPanelTask
	send?: SendTaskGraphAction
	onShowTask?: (id: string) => void
	/** Scrolls the chat to the call that created the task. */
	onShowPlanned?: () => void
}) => (
	<div className="pl-4 pr-1 pb-1 flex flex-col gap-0.5 text-xs opacity-90">
		{task.description && <div className="break-words">{task.description}</div>}
		{onShowPlanned && (
			<div>
				<button className={linkButton} onClick={onShowPlanned} type="button">
					Show where it was planned
				</button>
			</div>
		)}
		{task.depends.length > 0 && <div>after: {task.depends.join(", ")}</div>}
		{(task.gates ?? []).length > 0 && (
			<ul aria-label="Waits on" className="list-none m-0 p-0">
				{(task.gates ?? []).map((gate) => (
					<li className="flex gap-1 items-baseline flex-wrap" key={gate.spec}>
						<span
							className={cn("shrink-0", gate.open ? "text-success" : gate.failed ? "text-error" : "text-warning")}>
							{gate.open ? "◆" : "◇"}
						</span>
						<span className="break-words min-w-0">{gate.spec}</span>
						<span className="opacity-70">
							{gate.open ? "· open" : gate.failed ? `· cannot open: ${gate.failed}` : "· waiting"}
						</span>
						{send && !gate.open && !isClosed(task) && (
							<button
								className={linkButton}
								onClick={() => send({ op: "update", updates: [{ id: task.id, gate_open: [gate.spec] }] })}
								type="button">
								Resolve
							</button>
						)}
						{send && !isClosed(task) && (
							<button
								className={linkButton}
								onClick={() => send({ op: "update", updates: [{ id: task.id, gate_remove: [gate.spec] }] })}
								type="button">
								Remove
							</button>
						)}
					</li>
				))}
			</ul>
		)}
		{(task.links ?? []).length > 0 && (
			<div className="flex gap-1 flex-wrap items-baseline">
				links:
				{(task.links ?? []).map((link) => (
					<span className="flex gap-1" key={`${link.type} ${link.target}`}>
						<span className="opacity-70">{link.type}</span>
						<LinkTarget link={link} onShowTask={onShowTask} />
					</span>
				))}
			</div>
		)}
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
		{task.files.length > 0 && (
			<div className="flex gap-1 flex-wrap items-baseline">
				files:
				{task.files.map((file) => (
					<button
						className={linkButton}
						key={file}
						onClick={() => void FileServiceClient.openFileRelativePath({ value: file }).catch(() => undefined)}
						type="button">
						{file}
					</button>
				))}
			</div>
		)}
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
	onShowTask,
	onShowPlanned,
}: {
	task: TaskGraphPanelTask
	depth: number
	open: boolean
	onToggle: () => void
	send?: SendTaskGraphAction
	onShowTask?: (id: string) => void
	onShowPlanned?: () => void
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
			{open && <TaskDetail onShowPlanned={onShowPlanned} onShowTask={onShowTask} send={send} task={task} />}
		</li>
	)
}

interface TaskGraphPanelProps {
	clineMessages: ClineMessage[]
	/** Scrolls the chat to the message with this timestamp. */
	onShowMessage?: (ts: number) => void
}

export const TaskGraphPanel = memo(({ clineMessages, onShowMessage }: TaskGraphPanelProps) => {
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
	const planned = useMemo(
		() => (onShowMessage ? plannedRows(clineMessages) : new Map<string, number>()),
		[clineMessages, onShowMessage],
	)

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
					<div className="flex gap-2 text-xs items-center flex-wrap" role="tablist">
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
						<span className="ml-auto flex gap-2 flex-wrap">
							<SavedPlans onReply={setReply} />
							<SaveToMemory onReply={setReply} />
						</span>
					</div>
					{tab === "list" ? (
						<ul className="list-none m-0 p-0 flex flex-col gap-0.5">
							{ordered.map(({ task, depth }) => (
								<TaskRow
									depth={depth}
									key={task.id}
									onShowPlanned={
										onShowMessage && task.createdCall && planned.has(task.createdCall)
											? () => onShowMessage(planned.get(task.createdCall as string) as number)
											: undefined
									}
									onShowTask={(id) => setOpenIds((current) => new Set(current).add(id))}
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
					) : (
						<div className="flex flex-col gap-1">
							{snapshot && snapshot.layers.length > 0 ? (
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
							<MermaidBlock code={taskGraphMermaid(tasks)} />
						</div>
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
