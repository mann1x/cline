/**
 * The conversation's task log and the operations that write it.
 *
 * Every change is one event, appended to `<session>.tasks.jsonl` beside the
 * transcript, and the board is the fold of the events. The tools and the
 * replay of an old transcript go through the same `plan` and `update`, so a
 * board rebuilt from history is the board the model built: same ids, same
 * refusals.
 *
 * Why a log and not a file rewritten in place: each event names the tool call
 * that made it, so a conversation cut back to an earlier message (an
 * edit-and-resend, a checkpoint restore, a fork) can drop exactly the events
 * made after the cut -- the board then matches the conversation the model now
 * sees. And it never goes through compaction, so the summarizer no longer has
 * to carry the plan.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { shortTitle } from "./board";
import {
	applyTaskEvent,
	dependentsOf,
	emptyTaskGraphState,
	foldTaskEvents,
	isClosed,
	isReady,
	nextTaskId,
	openDependencies,
	readyTasks,
	type Task,
	type TaskAuthor,
	type TaskCreateFields,
	type TaskEvent,
	type TaskGraphState,
	type TaskUpdateFields,
	taskLayers,
	wouldCycle,
} from "./model";
import {
	normalizeTaskId,
	type PlanItem,
	readBatchRef,
	readPlanInput,
	readUpdateInput,
	type UpdateItem,
} from "./readers";

export const TASK_PLAN_TOOL_NAME = "task_plan";
export const TASK_UPDATE_TOOL_NAME = "task_update";
export const TASK_VIEW_TOOL_NAME = "task_view";
export const TASK_GRAPH_TOOL_NAMES: ReadonlySet<string> = new Set([
	TASK_PLAN_TOOL_NAME,
	TASK_UPDATE_TOOL_NAME,
	TASK_VIEW_TOOL_NAME,
]);

/** Who and where a change came from. */
export interface TaskChangeOrigin {
	by?: TaskAuthor;
	call?: string;
}

/** What an operation did, for the tool's result. */
export interface TaskOperationOutcome {
	/** Lines for the model, in order. */
	lines: string[];
	/** Whether anything changed. */
	changed: boolean;
	/** Ids that became ready because of this call. */
	readyNow: string[];
}

/** A serialisable view of one task, with what the graph says about it. */
export interface TaskSnapshot {
	id: string;
	title: string;
	description?: string;
	status: Task["status"];
	priority: Task["priority"];
	parent?: string;
	depends: string[];
	openDepends: string[];
	acceptance: { text: string; done: boolean }[];
	later: boolean;
	claimedBy?: string;
	files: string[];
	notes: string[];
	outcome?: string;
	ready: boolean;
	blocked: boolean;
}

export interface TaskGraphSnapshot {
	tasks: TaskSnapshot[];
	layers: string[][];
	counts: {
		total: number;
		closed: number;
		active: number;
		ready: number;
		blocked: number;
	};
}

interface HistoryToolCall {
	id?: string;
	name: string;
	input: unknown;
}

/**
 * Tool calls in a transcript, in order. Both shapes a history can hold: the
 * persisted `tool_use` part and the runtime's `tool-call` part.
 */
export function toolCallsInHistory(
	messages: readonly unknown[] | undefined,
): HistoryToolCall[] {
	const calls: HistoryToolCall[] = [];
	for (const message of messages ?? []) {
		const content = (message as { content?: unknown })?.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const p = part as Record<string, unknown>;
			if (p.type === "tool_use" && typeof p.name === "string") {
				calls.push({
					...(typeof p.id === "string" ? { id: p.id } : {}),
					name: p.name,
					input: p.input,
				});
			} else if (p.type === "tool-call" && typeof p.toolName === "string") {
				calls.push({
					...(typeof p.toolCallId === "string" ? { id: p.toolCallId } : {}),
					name: p.toolName,
					input: p.input,
				});
			}
		}
	}
	return calls;
}

function historyIsCompacted(messages: readonly unknown[] | undefined): boolean {
	return (messages ?? []).some(
		(message) =>
			(message as { metadata?: { kind?: unknown } })?.metadata?.kind ===
			"compaction_summary",
	);
}

/** Whether `ancestor` is `id`'s parent, grandparent, and so on. */
function isAncestorOf(
	state: TaskGraphState,
	ancestor: string,
	id: string,
): boolean {
	let current =
		state.tasks.get(id)?.parent ??
		(id.includes(".") ? id.slice(0, id.lastIndexOf(".")) : undefined);
	const seen = new Set<string>();
	while (current && !seen.has(current)) {
		if (current === ancestor) return true;
		seen.add(current);
		current = state.tasks.get(current)?.parent;
	}
	return false;
}

const ANCESTOR_REFUSAL =
	"a subtask cannot wait on a task it is part of (the parent closes after its subtasks)";

export interface TaskGraphStoreOptions {
	/** Where the log lives. Without one the store keeps the events in memory. */
	logPath?: string;
	/** Called after every change, with the new state. */
	onChange?: (store: TaskGraphStore) => void;
	now?: () => number;
}

export class TaskGraphStore {
	private events: TaskEvent[] = [];
	private state: TaskGraphState = emptyTaskGraphState();
	private readonly logPath: string | undefined;
	private readonly onChange: ((store: TaskGraphStore) => void) | undefined;
	private readonly now: () => number;

	constructor(options: TaskGraphStoreOptions = {}) {
		this.logPath = options.logPath;
		this.onChange = options.onChange;
		this.now = options.now ?? Date.now;
	}

	getState(): TaskGraphState {
		return this.state;
	}

	getEvents(): readonly TaskEvent[] {
		return this.events;
	}

	isEmpty(): boolean {
		return this.state.order.length === 0;
	}

	// -------------------------------------------------------------------------
	// Loading and reconciling with the conversation
	// -------------------------------------------------------------------------

	private readLog(): TaskEvent[] {
		if (!this.logPath || !existsSync(this.logPath)) return [];
		const events: TaskEvent[] = [];
		for (const line of readFileSync(this.logPath, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const event = JSON.parse(line) as TaskEvent;
				if (event && (event.op === "create" || event.op === "update")) {
					events.push(event);
				}
			} catch {
				// A torn last line from a crash mid-write: the events before it
				// stand, and the next append starts a clean line.
			}
		}
		return events;
	}

	private rewriteLog(): void {
		if (!this.logPath) return;
		mkdirSync(dirname(this.logPath), { recursive: true });
		const tmp = `${this.logPath}.tmp`;
		writeFileSync(
			tmp,
			this.events.map((event) => `${JSON.stringify(event)}\n`).join(""),
		);
		renameSync(tmp, this.logPath);
	}

	private persist(event: TaskEvent): void {
		if (!this.logPath) return;
		mkdirSync(dirname(this.logPath), { recursive: true });
		appendFileSync(this.logPath, `${JSON.stringify(event)}\n`);
	}

	/**
	 * Make the board match the conversation the session starts from.
	 *
	 * - **A log exists** (a resume): keep the events up to the last one whose
	 *   tool call is still in the history. Later ones were made in a part of
	 *   the conversation that was cut away -- an edit-and-resend or a restore
	 *   -- and go. When no call of the log survives: after a compaction that
	 *   is because the calls were summarised away, and every event stays;
	 *   without one, the history was cut back to before the plan, and only
	 *   events no call made (imports) stay.
	 * - **No log, but task calls in the history** (a fork, which starts a new
	 *   session from a copy of the transcript): replay those calls.
	 * - **Neither, but a checklist** (a conversation from before the graph):
	 *   import its items once, keeping the ticks.
	 *
	 * Returns what happened, for the log line.
	 */
	reconcile(
		history: readonly unknown[] | undefined,
		legacyChecklist?: { text: string; done: boolean }[],
	): "resumed" | "rewound" | "replayed" | "imported" | "empty" {
		const logged = this.readLog();
		const calls = toolCallsInHistory(history);
		if (logged.length > 0) {
			const present = new Set(
				calls.map((call) => call.id).filter((id): id is string => !!id),
			);
			let keep = logged.length;
			let lastPresent = -1;
			logged.forEach((event, index) => {
				if (event.call && present.has(event.call)) lastPresent = index;
			});
			if (lastPresent >= 0) {
				keep = lastPresent + 1;
			} else if (!historyIsCompacted(history)) {
				const firstCall = logged.findIndex((event) => event.call);
				keep = firstCall < 0 ? logged.length : firstCall;
			}
			this.events = logged.slice(0, keep);
			this.state = foldTaskEvents(this.events);
			if (keep < logged.length) {
				this.rewriteLog();
				return "rewound";
			}
			return "resumed";
		}
		const taskCalls = calls.filter(
			(call) =>
				call.name === TASK_PLAN_TOOL_NAME ||
				call.name === TASK_UPDATE_TOOL_NAME,
		);
		if (taskCalls.length > 0) {
			for (const call of taskCalls) {
				const origin = { by: "model", ...(call.id ? { call: call.id } : {}) };
				if (call.name === TASK_PLAN_TOOL_NAME) {
					this.plan(call.input, origin, { silent: true });
				} else {
					this.update(call.input, origin, { silent: true });
				}
			}
			this.onChange?.(this);
			return "replayed";
		}
		if (legacyChecklist && legacyChecklist.length > 0) {
			for (const item of legacyChecklist) {
				const id = nextTaskId(this.state);
				this.record(
					{ op: "create", task: { id, title: item.text } },
					{ by: "import" },
				);
				if (item.done) {
					this.record(
						{ op: "update", update: { id, status: "done" } },
						{ by: "import" },
					);
				}
			}
			this.onChange?.(this);
			return "imported";
		}
		return "empty";
	}

	private record(
		body:
			| { op: "create"; task: TaskCreateFields }
			| { op: "update"; update: TaskUpdateFields },
		origin: TaskChangeOrigin,
	): void {
		const event = {
			...body,
			seq: this.state.lastSeq + 1,
			ts: this.now(),
			by: origin.by ?? "model",
			...(origin.call ? { call: origin.call } : {}),
		} as TaskEvent;
		this.events.push(event);
		applyTaskEvent(this.state, event);
		this.persist(event);
	}

	// -------------------------------------------------------------------------
	// Operations
	// -------------------------------------------------------------------------

	/**
	 * Create the tasks a `task_plan` call lists, in order. `#n` in `depends`
	 * or `parent` is the n-th item of the same call, so a whole plan with its
	 * order goes in one call before any id exists.
	 */
	plan(
		input: unknown,
		origin: TaskChangeOrigin = {},
		options: { silent?: boolean } = {},
	): TaskOperationOutcome {
		const { items, ignored } = readPlanInput(input);
		const lines: string[] = [];
		if (items.length === 0) {
			lines.push(
				"No tasks created: send `tasks` as a list of objects with at least a `title`.",
			);
			for (const note of ignored) lines.push(`Ignored: ${note}.`);
			return { lines, changed: false, readyNow: [] };
		}
		const readyBefore = new Set(readyTasks(this.state).map((task) => task.id));
		const batchIds: string[] = [];
		const created: string[] = [];
		items.forEach((item: PlanItem, index) => {
			const position = index + 1;
			const resolve = (ref: string, what: string): string | undefined => {
				const batch = readBatchRef(ref);
				if (batch !== undefined) {
					if (batch >= position || batch < 1) {
						lines.push(
							`${what} "${ref}" on item ${position} ignored: \`#n\` names an earlier item of this call.`,
						);
						return undefined;
					}
					return batchIds[batch - 1];
				}
				const id = normalizeTaskId(ref);
				if (!id || !this.state.tasks.has(id)) {
					lines.push(
						`${what} "${ref}" on item ${position} ignored: no such task.`,
					);
					return undefined;
				}
				return id;
			};
			const parent = item.parent ? resolve(item.parent, "parent") : undefined;
			const id = nextTaskId(this.state, parent);
			const depends = item.depends
				.map((ref) => resolve(ref, "dependency"))
				.filter((dep): dep is string => !!dep && dep !== id)
				.filter((dep) => {
					if (
						dep === parent ||
						(parent && isAncestorOf(this.state, dep, parent))
					) {
						lines.push(
							`${id}: not made to wait on ${dep}: ${ANCESTOR_REFUSAL}.`,
						);
						return false;
					}
					return true;
				});
			this.record(
				{
					op: "create",
					task: {
						id,
						title: item.title,
						...(item.description ? { description: item.description } : {}),
						...(item.acceptance.length ? { acceptance: item.acceptance } : {}),
						...(depends.length ? { depends } : {}),
						...(parent ? { parent } : {}),
						...(item.priority ? { priority: item.priority } : {}),
					},
				},
				origin,
			);
			batchIds.push(id);
			created.push(id);
			if (item.start) {
				const task = this.state.tasks.get(id) as Task;
				const open = openDependencies(this.state, task);
				if (open.length > 0) {
					lines.push(`${id} not started: it is after ${open.join(", ")}.`);
				} else {
					this.record(
						{ op: "update", update: { id, status: "active" } },
						origin,
					);
				}
			}
		});
		const summary = created.map((id) => {
			const task = this.state.tasks.get(id) as Task;
			const after = task.depends.length
				? ` (after ${task.depends.join(", ")})`
				: "";
			return `${id} ${shortTitle(task.title, 60)}${after}${
				task.status === "active" ? " [active]" : ""
			}`;
		});
		lines.unshift(`Created ${created.length}: ${summary.join("; ")}.`);
		for (const note of ignored) lines.push(`Ignored: ${note}.`);
		const layers = taskLayers(this.state);
		if (layers.length > 1) {
			lines.push(
				`Order: ${layers.map((layer) => layer.map((task) => task.id).join(", ")).join(" → ")}.`,
			);
		}
		const readyNow = readyTasks(this.state)
			.map((task) => task.id)
			.filter((taskId) => !readyBefore.has(taskId));
		if (!options.silent) this.onChange?.(this);
		return { lines, changed: true, readyNow };
	}

	/** Apply the changes a `task_update` call lists, each on its own. */
	update(
		input: unknown,
		origin: TaskChangeOrigin = {},
		options: { silent?: boolean } = {},
	): TaskOperationOutcome {
		const { items, ignored } = readUpdateInput(input);
		const lines: string[] = [];
		let changed = false;
		const readyBefore = new Set(readyTasks(this.state).map((task) => task.id));
		for (const item of items) {
			const result = this.applyUpdate(item, origin);
			lines.push(...result.lines);
			changed ||= result.changed;
		}
		if (items.length === 0) {
			lines.push(
				"Nothing updated: send `updates` as a list of objects, each with the task's `id`.",
			);
		}
		for (const note of ignored) lines.push(`Ignored: ${note}.`);
		const readyNow = readyTasks(this.state)
			.map((task) => task.id)
			.filter((id) => !readyBefore.has(id));
		if (readyNow.length > 0) {
			// S5: what the close made possible, and the call that starts it
			// when nothing else is under way.
			const anyActive = this.state.order.some(
				(id) => this.state.tasks.get(id)?.status === "active",
			);
			lines.push(
				`Ready now: ${readyNow
					.map(
						(id) =>
							`${id} ${shortTitle((this.state.tasks.get(id) as Task).title, 50)}`,
					)
					.join("; ")}.${
					anyActive
						? ""
						: ` Start the next one: \`task_update\` {"updates":[{"id":"${readyNow[0]}","status":"active"}]}.`
				}`,
			);
		}
		if (changed && !options.silent) this.onChange?.(this);
		return { lines, changed, readyNow };
	}

	private applyUpdate(
		item: UpdateItem,
		origin: TaskChangeOrigin,
	): { lines: string[]; changed: boolean } {
		const lines: string[] = [];
		const id = normalizeTaskId(item.id);
		const task = id ? this.state.tasks.get(id) : undefined;
		if (!id || !task) {
			const known = this.state.order.slice(-8).join(", ");
			return {
				lines: [
					`${item.id}: no such task${known ? ` (tasks: ${known})` : ""}. Create it with \`task_plan\`.`,
				],
				changed: false,
			};
		}
		const update: TaskUpdateFields = { id };
		if (item.title) update.title = item.title;
		if (item.description) update.description = item.description;
		if (item.priority) update.priority = item.priority;
		if (item.later !== undefined) update.later = item.later;
		if (item.files.length) update.files = item.files;
		if (item.acceptanceAdd.length) update.acceptanceAdd = item.acceptanceAdd;
		const acceptanceAfterAdd = [
			...task.acceptance.map((entry) => entry.text),
			...item.acceptanceAdd,
		];
		const resolveChecks = (refs: Array<number | string>): number[] => {
			const indexes: number[] = [];
			for (const ref of refs) {
				if (ref === "*" || ref === "all") {
					indexes.push(...acceptanceAfterAdd.map((_, index) => index));
					continue;
				}
				const asNumber = typeof ref === "number" ? ref : Number(ref);
				if (
					Number.isInteger(asNumber) &&
					asNumber >= 1 &&
					asNumber <= acceptanceAfterAdd.length
				) {
					indexes.push(asNumber - 1);
					continue;
				}
				const needle = String(ref).toLowerCase();
				const found = acceptanceAfterAdd.findIndex((text) =>
					text.toLowerCase().includes(needle),
				);
				if (found >= 0) indexes.push(found);
				else lines.push(`${id}: no acceptance item matches "${ref}".`);
			}
			return [...new Set(indexes)];
		};
		if (item.check.length) update.check = resolveChecks(item.check);
		if (item.uncheck.length) update.uncheck = resolveChecks(item.uncheck);
		if (item.dependsAdd.length) {
			const add: string[] = [];
			for (const ref of item.dependsAdd) {
				const dep = normalizeTaskId(ref);
				if (!dep || !this.state.tasks.has(dep)) {
					lines.push(`${id}: dependency "${ref}" ignored, no such task.`);
				} else if (isAncestorOf(this.state, dep, id)) {
					lines.push(`${id}: not made to wait on ${dep}: ${ANCESTOR_REFUSAL}.`);
				} else if (wouldCycle(this.state, id, dep, new Map([[id, add]]))) {
					lines.push(
						`${id}: not made to wait on ${dep}, because ${dep} already waits on ${id}; that would be a loop.`,
					);
				} else {
					add.push(dep);
				}
			}
			if (add.length) update.dependsAdd = add;
		}
		if (item.dependsRemove.length) {
			const remove = item.dependsRemove
				.map((ref) => normalizeTaskId(ref))
				.filter((dep): dep is string => !!dep);
			if (remove.length) update.dependsRemove = remove;
		}
		if (item.note) update.note = item.note;
		if (item.status && item.status !== task.status) {
			if (item.status === "active") {
				const open = openDependencies(this.state, {
					...task,
					depends: [
						...task.depends.filter(
							(dep) => !(update.dependsRemove ?? []).includes(dep),
						),
						...(update.dependsAdd ?? []),
					],
				});
				if (open.length > 0) {
					lines.push(
						`${id} not started: it is after ${open.join(", ")}, still open. Finish those first, or drop the dependency with \`depends_remove\`.`,
					);
				} else {
					update.status = "active";
				}
			} else {
				update.status = item.status;
			}
		}
		const keys = Object.keys(update).filter((key) => key !== "id");
		if (keys.length === 0) {
			if (lines.length === 0) lines.push(`${id}: nothing to change.`);
			return { lines, changed: false };
		}
		this.record({ op: "update", update }, origin);
		const after = this.state.tasks.get(id) as Task;
		const said: string[] = [];
		if (update.status) said.push(`now ${update.status}`);
		if (update.check?.length || update.uncheck?.length) {
			said.push(
				`checks ${after.acceptance.filter((entry) => entry.done).length}/${after.acceptance.length}`,
			);
		}
		if (update.dependsAdd) said.push(`after ${update.dependsAdd.join(", ")}`);
		if (update.note && !update.status) said.push("note added");
		if (said.length === 0) said.push("updated");
		lines.unshift(`${id} ${said.join(", ")}.`);
		if (update.status && isClosed(update.status)) {
			if (!update.note) {
				lines.push(
					`${id} closed without an outcome. Add one (\`note\`): the board shows it in place of the task from now on.`,
				);
			}
			const unticked = after.acceptance.filter((entry) => !entry.done);
			if (update.status === "done" && unticked.length > 0) {
				lines.push(
					`${id} has unticked acceptance: ${unticked
						.map((entry) => `"${entry.text}"`)
						.join(", ")}. Tick them with \`check\` if they are met.`,
				);
			}
			const openChildren = this.state.order
				.map((taskId) => this.state.tasks.get(taskId) as Task)
				.filter((child) => child.parent === id && !isClosed(child.status));
			if (openChildren.length > 0) {
				lines.push(
					`${id} still has open subtasks: ${openChildren.map((child) => child.id).join(", ")}.`,
				);
			}
		}
		return { lines, changed: true };
	}

	// -------------------------------------------------------------------------
	// Views
	// -------------------------------------------------------------------------

	/** Ids of tasks that `id` closing would make ready, for nudges. */
	wouldUnblock(id: string): string[] {
		return dependentsOf(this.state, id)
			.filter((task) =>
				openDependencies(this.state, task).every((dep) => dep === id),
			)
			.map((task) => task.id);
	}

	snapshot(): TaskGraphSnapshot {
		const state = this.state;
		const tasks = state.order.map((id) => {
			const task = state.tasks.get(id) as Task;
			const openDepends = openDependencies(state, task);
			const ready = isReady(state, task);
			return {
				id: task.id,
				title: task.title,
				...(task.description ? { description: task.description } : {}),
				status: task.status,
				priority: task.priority,
				...(task.parent ? { parent: task.parent } : {}),
				depends: [...task.depends],
				openDepends,
				acceptance: task.acceptance.map((entry) => ({ ...entry })),
				later: task.later,
				...(task.claimedBy ? { claimedBy: task.claimedBy } : {}),
				files: [...task.files],
				notes: task.notes.map((note) => note.text),
				...(task.outcome ? { outcome: task.outcome } : {}),
				ready,
				blocked:
					!isClosed(task.status) &&
					task.status !== "active" &&
					!ready &&
					openDepends.length > 0,
			};
		});
		return {
			tasks,
			layers: taskLayers(state).map((layer) => layer.map((task) => task.id)),
			counts: {
				total: tasks.length,
				closed: tasks.filter((task) => isClosed(task.status)).length,
				active: tasks.filter((task) => task.status === "active").length,
				ready: tasks.filter((task) => task.ready).length,
				blocked: tasks.filter((task) => task.blocked).length,
			},
		};
	}
}
