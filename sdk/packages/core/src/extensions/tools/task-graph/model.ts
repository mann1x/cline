/**
 * The conversation's task graph: what a task is, how the log folds into a
 * board, and the questions asked of it (ready, blocked, layers, cycles).
 *
 * Pure data and functions. Nothing here touches a file or a tool; the store
 * persists the events and the tools validate what the model sends before an
 * event is ever made, so folding the log never has to refuse anything.
 *
 * Adapted from claude-hooks' task store (the beads-style dependency graph),
 * scoped to one conversation: ids are `T<n>` and `T<n>.<m>`, never reused,
 * and the whole state is the fold of an append-only event log.
 */

export type TaskStatus =
	| "pending"
	| "active"
	| "waiting"
	| "done"
	| "cancelled";
export type TaskPriority = "H" | "M" | "L";

/** Who made a change: the model, the person, an agent id, or an import. */
export type TaskAuthor = string;

export interface AcceptanceItem {
	text: string;
	done: boolean;
}

/**
 * What a task waits on besides other tasks (plan section 6). The kind is the
 * part before the first colon:
 *
 * | gate | opens when |
 * |---|---|
 * | `run:<id>` | a teammate run or delegated agent finishes |
 * | `command:<id>` | a background command exits |
 * | `human:<what>` | the person answers: a reply to the question naming it, or "Resolve" |
 * | `commit:<sha>@<branch>` | the branch contains the commit |
 * | `timer:<ISO time>` | the time passes |
 * | `gh-pr:<owner/repo#n>` / `gh-run:<owner/repo/id>` | merged / succeeded |
 * | `pipeline:<run>` | a pipeline run ends (fails when the run fails) |
 *
 * `use-pipeline:<name>` is not a wait: it says the task is done by running
 * that pipeline. The task starts as any other, the model is told to run the
 * pipeline for it, and the run's start turns the gate into `pipeline:<run>`.
 *
 * A gate that can no longer open (the run failed, the PR was closed) is
 * marked failed once and stays, for the model or the person to remove.
 */
export interface TaskGate {
	spec: string;
	open: boolean;
	/** Why it can no longer open. */
	failed?: string;
}

export const GATE_KINDS = [
	"run",
	"command",
	"human",
	"commit",
	"timer",
	"gh-pr",
	"gh-run",
	"pipeline",
	"use-pipeline",
] as const;
export type GateKind = (typeof GATE_KINDS)[number];

/** `use-pipeline:<name>`: how the task is done, not what it waits on. */
export function isPipelineUseGate(spec: string): boolean {
	return parseGate(spec)?.kind === "use-pipeline";
}

/**
 * What the model is told when a task that uses a pipeline is active: run it
 * for the task. Undefined when the task uses none (or its run started).
 */
export function pipelineUseLine(task: Task): string | undefined {
	const names = (task.gates ?? [])
		.filter((gate) => !gate.open && isPipelineUseGate(gate.spec))
		.map((gate) => parseGate(gate.spec)?.value as string);
	if (names.length === 0) return undefined;
	return `${task.id} is done by running pipeline ${names.map((name) => `"${name}"`).join(" and ")}: \`pipeline run\` with that name and task "${task.id}". ${task.id} then waits on the run, and is yours again when it ends.`;
}

/** A gate's kind and the rest, or undefined when it names no known kind. */
export function parseGate(
	spec: string,
): { kind: GateKind; value: string } | undefined {
	const match = /^\s*([a-z][a-z-]*)\s*:\s*([\s\S]*)$/i.exec(spec);
	if (!match) return undefined;
	const kind = (match[1] as string).toLowerCase() as GateKind;
	if (!GATE_KINDS.includes(kind)) return undefined;
	const value = (match[2] as string).trim();
	return value ? { kind, value } : undefined;
}

/** A gate written the one way the board stores it: `kind:value`. */
export function normalizeGate(spec: string): string | undefined {
	const parsed = parseGate(spec);
	return parsed ? `${parsed.kind}:${parsed.value}` : undefined;
}

/**
 * Typed links between tasks (from claude-hooks and beads), and attachments.
 * `supersedes` and `duplicate-of` close the replaced task.
 */
export const TASK_LINK_TYPES = [
	"discovered-from",
	"related",
	"caused-by",
	"supersedes",
	"duplicate-of",
] as const;
export const ATTACHMENT_TYPES = ["url", "commit", "message", "plan"] as const;
export type TaskLinkType =
	| (typeof TASK_LINK_TYPES)[number]
	| (typeof ATTACHMENT_TYPES)[number];

export interface TaskLink {
	type: TaskLinkType;
	/** A task id for a task link; the url, sha, message or plan otherwise. */
	target: string;
}

export function isTaskLinkType(type: string): boolean {
	return (TASK_LINK_TYPES as readonly string[]).includes(type);
}

export interface TaskNote {
	seq: number;
	by: TaskAuthor;
	text: string;
}

export interface Task {
	id: string;
	title: string;
	description?: string;
	status: TaskStatus;
	priority: TaskPriority;
	/** Ids this task waits on until each is done or cancelled. */
	depends: string[];
	parent?: string;
	acceptance: AcceptanceItem[];
	/** Parked by choice: neither ready nor nagged about, children included. */
	later: boolean;
	claimedBy?: string;
	/**
	 * The teammate the plan gave it to (phase 6): started on it once it is
	 * ready. Unlike a claim it outlives the teammate's runs.
	 */
	assignee?: string;
	files: string[];
	gates: TaskGate[];
	links: TaskLink[];
	notes: TaskNote[];
	/** The note given with `done` or `cancelled`: what the board decays to. */
	outcome?: string;
	createdSeq: number;
	/** The event that last changed the task, for "stale" questions. */
	touchedSeq: number;
	/** The tool call that created it: where in the chat it was planned. */
	createdCall?: string;
}

/** The fields a create event carries; everything else starts at its default. */
export interface TaskCreateFields {
	id: string;
	title: string;
	description?: string;
	acceptance?: string[];
	depends?: string[];
	parent?: string;
	priority?: TaskPriority;
	status?: TaskStatus;
	gates?: string[];
	links?: TaskLink[];
	assignee?: string;
}

/** One change to one task. Every field optional; applied in this order. */
export interface TaskUpdateFields {
	id: string;
	title?: string;
	description?: string;
	priority?: TaskPriority;
	status?: TaskStatus;
	note?: string;
	/** Acceptance items by index (0-based), as resolved by the tool. */
	check?: number[];
	uncheck?: number[];
	acceptanceAdd?: string[];
	dependsAdd?: string[];
	dependsRemove?: string[];
	later?: boolean;
	files?: string[];
	claimedBy?: string | null;
	assignee?: string | null;
	gatesAdd?: string[];
	gatesRemove?: string[];
	/** Gates that opened. */
	gatesOpen?: string[];
	/** Gates that can no longer open, and why. */
	gatesFailed?: { gate: string; reason: string }[];
	linksAdd?: TaskLink[];
	linksRemove?: TaskLink[];
}

interface TaskEventBase {
	/** Position in the log, from 1. */
	seq: number;
	/** Milliseconds since the epoch. */
	ts: number;
	by: TaskAuthor;
	/**
	 * The tool call that made it, which is what ties the log to the
	 * conversation: a history cut before that call (an edit-and-resend, a
	 * checkpoint restore) no longer has it, and the event goes with it.
	 */
	call?: string;
}

export type TaskEvent =
	| (TaskEventBase & { op: "create"; task: TaskCreateFields })
	| (TaskEventBase & { op: "update"; update: TaskUpdateFields })
	/**
	 * The person deleted tasks (the store lists a task's steps with it). They
	 * leave the board, and the tasks after them stop waiting on them. Ids are
	 * never handed out again.
	 */
	| (TaskEventBase & { op: "remove"; ids: string[] });

/** A logged event's change: what `record` takes and a saved board replays. */
export type TaskEventBody =
	| { op: "create"; task: TaskCreateFields }
	| { op: "update"; update: TaskUpdateFields }
	| { op: "remove"; ids: string[] };

/** The tasks an event is about, for readers that follow one task. */
export function taskEventTargets(event: TaskEvent): string[] {
	if (event.op === "create") return [event.task.id];
	if (event.op === "update") return [event.update.id];
	return event.ids;
}

/** Whether a parsed log line is an event this build folds. */
export function isTaskEvent(value: unknown): value is TaskEvent {
	if (!value || typeof value !== "object") return false;
	const op = (value as { op?: unknown }).op;
	if (op === "create" || op === "update") return true;
	return op === "remove" && Array.isArray((value as { ids?: unknown }).ids);
}

export interface TaskGraphState {
	tasks: Map<string, Task>;
	/** In creation order, which is also id order within a parent. */
	order: string[];
	nextTop: number;
	nextChild: Map<string, number>;
	lastSeq: number;
}

export function emptyTaskGraphState(): TaskGraphState {
	return {
		tasks: new Map(),
		order: [],
		nextTop: 1,
		nextChild: new Map(),
		lastSeq: 0,
	};
}

export function isClosed(status: TaskStatus): boolean {
	return status === "done" || status === "cancelled";
}

/** The id the next task gets, under `parent` or at the top. */
export function nextTaskId(state: TaskGraphState, parent?: string): string {
	if (parent) {
		return `${parent}.${state.nextChild.get(parent) ?? 1}`;
	}
	return `T${state.nextTop}`;
}

function uniq(values: Iterable<string>): string[] {
	return [...new Set(values)];
}

function linkKey(link: TaskLink): string {
	return `${link.type} ${link.target}`;
}

function uniqLinks(links: readonly TaskLink[]): TaskLink[] {
	const seen = new Set<string>();
	return links.filter((link) => {
		const key = linkKey(link);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Apply one event. Mutates `state`; the store owns the only copy. */
export function applyTaskEvent(state: TaskGraphState, event: TaskEvent): void {
	state.lastSeq = Math.max(state.lastSeq, event.seq);
	if (event.op === "create") {
		const fields = event.task;
		if (state.tasks.has(fields.id)) {
			return;
		}
		state.tasks.set(fields.id, {
			id: fields.id,
			title: fields.title,
			...(fields.description ? { description: fields.description } : {}),
			status: fields.status ?? "pending",
			priority: fields.priority ?? "M",
			depends: uniq(fields.depends ?? []),
			...(fields.parent ? { parent: fields.parent } : {}),
			acceptance: (fields.acceptance ?? []).map((text) => ({
				text,
				done: false,
			})),
			later: false,
			files: [],
			gates: uniq(fields.gates ?? []).map((spec) => ({ spec, open: false })),
			links: uniqLinks(fields.links ?? []),
			...(fields.assignee ? { assignee: fields.assignee } : {}),
			notes: [],
			createdSeq: event.seq,
			touchedSeq: event.seq,
			...(event.call ? { createdCall: event.call } : {}),
		});
		state.order.push(fields.id);
		// Counters follow the ids actually created, so a log replayed from any
		// source hands out the same next id it did the first time.
		const parent = fields.parent;
		const tail = Number(fields.id.slice(fields.id.lastIndexOf(".") + 1));
		if (parent) {
			state.nextChild.set(
				parent,
				Math.max(state.nextChild.get(parent) ?? 1, tail + 1),
			);
		} else {
			const top = Number(fields.id.slice(1));
			if (Number.isFinite(top)) {
				state.nextTop = Math.max(state.nextTop, top + 1);
			}
		}
		return;
	}
	if (event.op === "remove") {
		const gone = new Set(event.ids.filter((id) => state.tasks.has(id)));
		if (gone.size === 0) return;
		for (const id of gone) state.tasks.delete(id);
		state.order = state.order.filter((id) => !gone.has(id));
		for (const task of state.tasks.values()) {
			if (task.depends.some((id) => gone.has(id))) {
				task.depends = task.depends.filter((id) => !gone.has(id));
				task.touchedSeq = event.seq;
			}
		}
		return;
	}
	const update = event.update;
	const task = state.tasks.get(update.id);
	if (!task) {
		return;
	}
	if (update.title !== undefined) task.title = update.title;
	if (update.description !== undefined) task.description = update.description;
	if (update.priority !== undefined) task.priority = update.priority;
	if (update.acceptanceAdd) {
		for (const text of update.acceptanceAdd) {
			task.acceptance.push({ text, done: false });
		}
	}
	for (const index of update.check ?? []) {
		const item = task.acceptance[index];
		if (item) item.done = true;
	}
	for (const index of update.uncheck ?? []) {
		const item = task.acceptance[index];
		if (item) item.done = false;
	}
	if (update.dependsAdd) {
		task.depends = uniq([...task.depends, ...update.dependsAdd]);
	}
	if (update.dependsRemove) {
		const drop = new Set(update.dependsRemove);
		task.depends = task.depends.filter((id) => !drop.has(id));
	}
	if (update.later !== undefined) task.later = update.later;
	if (update.files) task.files = uniq([...task.files, ...update.files]);
	// Logs written before gates and links existed fold to empty lists.
	task.gates ??= [];
	task.links ??= [];
	for (const spec of update.gatesAdd ?? []) {
		if (!task.gates.some((gate) => gate.spec === spec)) {
			task.gates.push({ spec, open: false });
		}
	}
	if (update.gatesRemove) {
		const drop = new Set(update.gatesRemove);
		task.gates = task.gates.filter((gate) => !drop.has(gate.spec));
	}
	for (const spec of update.gatesOpen ?? []) {
		const gate = task.gates.find((entry) => entry.spec === spec);
		if (gate) {
			gate.open = true;
			delete gate.failed;
		}
	}
	for (const { gate: spec, reason } of update.gatesFailed ?? []) {
		const gate = task.gates.find((entry) => entry.spec === spec);
		if (gate && !gate.open) gate.failed = reason;
	}
	if (update.linksAdd)
		task.links = uniqLinks([...task.links, ...update.linksAdd]);
	if (update.linksRemove) {
		const drop = new Set(update.linksRemove.map(linkKey));
		task.links = task.links.filter((link) => !drop.has(linkKey(link)));
	}
	if (update.claimedBy !== undefined) {
		if (update.claimedBy === null) delete task.claimedBy;
		else task.claimedBy = update.claimedBy;
	}
	if (update.assignee !== undefined) {
		if (update.assignee === null) delete task.assignee;
		else task.assignee = update.assignee;
	}
	if (update.note) {
		task.notes.push({ seq: event.seq, by: event.by, text: update.note });
	}
	if (update.status !== undefined) {
		task.status = update.status;
		if (isClosed(update.status)) {
			if (update.note) task.outcome = update.note;
		} else {
			delete task.outcome;
		}
	}
	task.touchedSeq = event.seq;
}

export function foldTaskEvents(events: Iterable<TaskEvent>): TaskGraphState {
	const state = emptyTaskGraphState();
	for (const event of events) {
		applyTaskEvent(state, event);
	}
	return state;
}

// ---------------------------------------------------------------------------
// Questions asked of the graph
// ---------------------------------------------------------------------------

export function childrenOf(state: TaskGraphState, id: string): Task[] {
	return state.order
		.map((taskId) => state.tasks.get(taskId))
		.filter((task): task is Task => task?.parent === id);
}

/** Whether the task or an ancestor is parked with `later`. */
export function isParked(state: TaskGraphState, task: Task): boolean {
	let current: Task | undefined = task;
	const seen = new Set<string>();
	while (current && !seen.has(current.id)) {
		if (current.later) return true;
		seen.add(current.id);
		current = current.parent ? state.tasks.get(current.parent) : undefined;
	}
	return false;
}

/**
 * The dependencies still open, which is what "blocked" means -- the task's
 * own and its ancestors': a subtask of a task that waits on T2 waits on T2
 * too, or it would be offered as ready work under a parent that cannot start.
 */
export function openDependencies(state: TaskGraphState, task: Task): string[] {
	const open: string[] = [];
	let current: Task | undefined = task;
	const seen = new Set<string>();
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		for (const id of current.depends) {
			const dep = state.tasks.get(id);
			if (dep !== undefined && !isClosed(dep.status) && !open.includes(id)) {
				open.push(id);
			}
		}
		current = current.parent ? state.tasks.get(current.parent) : undefined;
	}
	return open;
}

/**
 * The gates still closed, the task's own and its ancestors', as dependencies
 * are: a subtask of a task waiting on the person waits on the person too.
 */
export function openGates(state: TaskGraphState, task: Task): string[] {
	const open: string[] = [];
	let current: Task | undefined = task;
	const seen = new Set<string>();
	while (current && !seen.has(current.id)) {
		seen.add(current.id);
		for (const gate of current.gates ?? []) {
			if (gate.open || open.includes(gate.spec)) continue;
			// Not a wait: how the task is done (it starts, and runs the pipeline).
			if (isPipelineUseGate(gate.spec)) continue;
			open.push(gate.spec);
		}
		current = current.parent ? state.tasks.get(current.parent) : undefined;
	}
	return open;
}

/** What a task waits on, deps first: `T3`, `human:approve the schema`. */
export function waitsOn(state: TaskGraphState, task: Task): string[] {
	return [...openDependencies(state, task), ...openGates(state, task)];
}

export function isBlocked(state: TaskGraphState, task: Task): boolean {
	return (
		!isClosed(task.status) &&
		(openDependencies(state, task).length > 0 ||
			openGates(state, task).length > 0 ||
			isParked(state, task))
	);
}

/**
 * Open, not started, nothing in its way. A task with open children is not
 * ready itself: its children are the work, and it closes after them.
 */
export function isReady(state: TaskGraphState, task: Task): boolean {
	return (
		task.status === "pending" &&
		!isBlocked(state, task) &&
		!childrenOf(state, task.id).some((child) => !isClosed(child.status))
	);
}

const PRIORITY_RANK: Record<TaskPriority, number> = { H: 0, M: 1, L: 2 };

/** Ready tasks, highest priority first, then in creation order. */
export function readyTasks(state: TaskGraphState): Task[] {
	return state.order
		.map((id) => state.tasks.get(id) as Task)
		.filter((task) => isReady(state, task))
		.sort(
			(a, b) =>
				PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
				a.createdSeq - b.createdSeq,
		);
}

/** Open tasks that list `id` among their dependencies. */
export function dependentsOf(state: TaskGraphState, id: string): Task[] {
	return state.order
		.map((taskId) => state.tasks.get(taskId) as Task)
		.filter((task) => !isClosed(task.status) && task.depends.includes(id));
}

/**
 * Whether making `from` depend on `to` closes a loop: true when `from` is
 * already reachable from `to` along dependency edges (or they are the same).
 */
export function wouldCycle(
	state: TaskGraphState,
	from: string,
	to: string,
	extra: ReadonlyMap<string, readonly string[]> = new Map(),
): boolean {
	const stack = [to];
	const seen = new Set<string>();
	while (stack.length > 0) {
		const id = stack.pop() as string;
		if (id === from) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		const deps = [
			...(state.tasks.get(id)?.depends ?? []),
			...(extra.get(id) ?? []),
		];
		stack.push(...deps);
	}
	return false;
}

/**
 * Open tasks in dependency layers: layer 0 waits on nothing open, layer n on
 * something in layer n-1. What can run side by side is one layer.
 */
export function taskLayers(state: TaskGraphState): Task[][] {
	const open = state.order
		.map((id) => state.tasks.get(id) as Task)
		.filter((task) => !isClosed(task.status));
	const layerOf = new Map<string, number>();
	const visiting = new Set<string>();
	const depth = (task: Task): number => {
		const known = layerOf.get(task.id);
		if (known !== undefined) return known;
		if (visiting.has(task.id)) return 0;
		visiting.add(task.id);
		let layer = 0;
		for (const depId of openDependencies(state, task)) {
			const dep = state.tasks.get(depId);
			if (dep) layer = Math.max(layer, depth(dep) + 1);
		}
		visiting.delete(task.id);
		layerOf.set(task.id, layer);
		return layer;
	};
	const layers: Task[][] = [];
	for (const task of open) {
		const layer = depth(task);
		const row = layers[layer] ?? [];
		row.push(task);
		layers[layer] = row;
	}
	return layers.filter(Boolean);
}

export interface TaskGraphCounts {
	total: number;
	done: number;
	cancelled: number;
	active: number;
	ready: number;
	blocked: number;
	waiting: number;
}

export function countTasks(state: TaskGraphState): TaskGraphCounts {
	const counts: TaskGraphCounts = {
		total: 0,
		done: 0,
		cancelled: 0,
		active: 0,
		ready: 0,
		blocked: 0,
		waiting: 0,
	};
	for (const id of state.order) {
		const task = state.tasks.get(id) as Task;
		counts.total += 1;
		if (task.status === "done") counts.done += 1;
		else if (task.status === "cancelled") counts.cancelled += 1;
		else if (task.status === "active") counts.active += 1;
		else if (task.status === "waiting") counts.waiting += 1;
		else if (isBlocked(state, task)) counts.blocked += 1;
		else if (isReady(state, task)) counts.ready += 1;
	}
	return counts;
}

/** Tasks the run should not end on: active ones, and ready ones. */
export function openWork(state: TaskGraphState): Task[] {
	return state.order
		.map((id) => state.tasks.get(id) as Task)
		.filter(
			(task) =>
				!isParked(state, task) &&
				!isPipelineHeld(task) &&
				(task.status === "active" || isReady(state, task)),
		);
}

/** The holder a pipeline run claims its task as: `pipeline:<run id>`. */
export const PIPELINE_HOLDER_PREFIX = "pipeline:";

/**
 * A task a pipeline run holds: the run is doing it, asynchronously. It is
 * not the model's active work, so it neither blocks the auto-start nor is
 * asked to be closed at the end of a run; the run closes it.
 */
export function isPipelineHeld(task: Task): boolean {
	return (
		!!task.claimedBy?.startsWith(PIPELINE_HOLDER_PREFIX) &&
		!isClosed(task.status)
	);
}
