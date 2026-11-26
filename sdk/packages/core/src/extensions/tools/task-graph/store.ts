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
import { absoluteGate } from "./gates";
import {
	applyTaskEvent,
	dependentsOf,
	emptyTaskGraphState,
	foldTaskEvents,
	isClosed,
	isReady,
	isTaskLinkType,
	nextTaskId,
	openDependencies,
	openGates,
	readyTasks,
	type Task,
	type TaskAuthor,
	type TaskCreateFields,
	type TaskEvent,
	type TaskGate,
	type TaskGraphState,
	type TaskLink,
	type TaskUpdateFields,
	taskLayers,
	waitsOn,
	wouldCycle,
} from "./model";
import {
	normalizeTaskId,
	type PlanItem,
	readBatchRef,
	readPlanInput,
	readUpdateInput,
	type UpdateItem,
	unquoteArgument,
} from "./readers";

export const TASK_PLAN_TOOL_NAME = "task_plan";
export const TASK_UPDATE_TOOL_NAME = "task_update";
export const TASK_VIEW_TOOL_NAME = "task_view";
/**
 * The optional argument the working tools carry so a task can be closed on a
 * call the model is making anyway. Phase 1 measured every `task_update` as a
 * request of its own -- the models never batch two calls in one turn -- and
 * 6.7 to 7.8 of them a run took total input from 504k to 741-799k tokens
 * (tg-bench, 2026-11-20). The checklist rode on other calls; this lets the
 * close do the same, for a few dozen tokens per tool instead of 2,320.
 */
export const TASK_DONE_PARAM = "task_done";
/** The tools that carry it: the ones a task is finished with. */
export const TASK_DONE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"editor",
	"apply_patch",
	"run_commands",
	"check_file",
]);

/** A task id with its prefix: what a second id in one `task_done` must carry. */
const PREFIXED_TASK_ID = String.raw`(?:task\s*|[#tT])\s*\d+(?:\.\d+)*`;
const LEADING_TASK_ID = /^\s*((?:task\s*)?[#tT]?\s*\d+(?:\.\d+)*)/i;
const RANGE_TO = new RegExp(
	String.raw`^\s*(?:\.\.|-|\u2013|\u2014|to)\s*(${PREFIXED_TASK_ID})(?![\w.])`,
	"i",
);
const ALSO_ID = new RegExp(
	String.raw`^\s*(?:,|&|\+|/|and\b)?\s*(${PREFIXED_TASK_ID})(?![\w.])`,
	"i",
);
/** At most this many ids from one range, so "T1-T999" is not a mass close. */
const MAX_RANGE = 20;

/** "T2".."T5" as T2, T3, T4, T5; dotted ids name only their ends. */
function expandRange(from: string, to: string): string[] {
	const a = /^T(\d+)$/.exec(from);
	const b = /^T(\d+)$/.exec(to);
	if (!a || !b) return [from, to];
	const lo = Number(a[1]);
	const hi = Number(b[1]);
	if (hi < lo || hi - lo >= MAX_RANGE) return [from, to];
	return Array.from({ length: hi - lo + 1 }, (_, i) => `T${lo + i}`);
}

/**
 * `task_done` as sent: "T3", "T3: what was done", several ids before the
 * note ("T2, T3: …", "T2 and T3 …", "T2-T5: …"), an array of those, or
 * `{id, note}`, quoted or not. Ids after the first carry their `T`, so
 * "T3, 2 tests added" closes T3 alone. Anything else names no task and is
 * reported, never guessed.
 */
export function readTaskDone(
	value: unknown,
): Array<{ id: string; note?: string; raw: string }> {
	const out: Array<{ id: string; note?: string; raw: string }> = [];
	const one = (entry: unknown): void => {
		if (typeof entry === "string") {
			const text = unquoteArgument(entry);
			const first = LEADING_TASK_ID.exec(text);
			const firstId = first ? normalizeTaskId(first[1]) : undefined;
			if (!first || !firstId) {
				out.push({ id: "", raw: entry });
				return;
			}
			const ids = [firstId];
			let rest = text.slice(first[0].length);
			for (;;) {
				const range = RANGE_TO.exec(rest);
				const to = range ? normalizeTaskId(range[1]) : undefined;
				if (range && to) {
					const last = ids.pop() as string;
					ids.push(...expandRange(last, to));
					rest = rest.slice(range[0].length);
					continue;
				}
				const also = ALSO_ID.exec(rest);
				const next = also ? normalizeTaskId(also[1]) : undefined;
				if (also && next) {
					ids.push(next);
					rest = rest.slice(also[0].length);
					continue;
				}
				break;
			}
			const note = rest.replace(/^\s*[:\-\u2013\u2014,]?\s*/, "").trim();
			for (const id of [...new Set(ids)]) {
				out.push({ id, ...(note ? { note } : {}), raw: entry });
			}
		} else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
			const record = entry as { id?: unknown; note?: unknown };
			const id = normalizeTaskId(record.id);
			const note = typeof record.note === "string" ? record.note.trim() : "";
			out.push({
				id: id ?? "",
				...(note ? { note } : {}),
				raw: JSON.stringify(entry),
			});
		}
	};
	const unwrapped = typeof value === "string" ? unquoteArgument(value) : value;
	if (Array.isArray(unwrapped)) unwrapped.forEach(one);
	else if (typeof unwrapped === "string" && unwrapped.startsWith("[")) {
		try {
			const parsed = JSON.parse(unwrapped);
			if (Array.isArray(parsed)) parsed.forEach(one);
			else one(value);
		} catch {
			one(value);
		}
	} else one(value);
	return out;
}

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

/** Authors that are not an agent of their own: the lead, the person, imports. */
const NON_AGENT_AUTHORS = new Set(["model", "user", "import", "gate", "host"]);

/**
 * Whether a change was made by a teammate or delegated agent: their starts
 * are claims, and nothing is started for them.
 */
export function isAgentAuthor(by: TaskAuthor | undefined): boolean {
	return !!by && !NON_AGENT_AUTHORS.has(by) && !by.startsWith("memory:");
}

/** What a gate check decided about one gate. */
export type GateDecision = { open: true } | { failed: string } | undefined;

/** A saved board a new conversation starts from: its events, and who to author them as. */
export interface TaskGraphSeed {
	events: readonly unknown[];
	/** As `memory:m12`. */
	by: string;
	/** Where it came from, for the model: as `m12, "ledger", saved 2026-11-21`. */
	about?: string;
}

/** A saved event's change, without its log position, time, author or call. */
function seedEventBody(
	raw: unknown,
):
	| { op: "create"; task: TaskCreateFields }
	| { op: "update"; update: TaskUpdateFields }
	| undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const event = raw as { op?: unknown; task?: unknown; update?: unknown };
	if (
		event.op === "create" &&
		event.task &&
		typeof (event.task as { id?: unknown }).id === "string" &&
		typeof (event.task as { title?: unknown }).title === "string"
	) {
		return { op: "create", task: event.task as TaskCreateFields };
	}
	if (
		event.op === "update" &&
		event.update &&
		typeof (event.update as { id?: unknown }).id === "string"
	) {
		return { op: "update", update: event.update as TaskUpdateFields };
	}
	return undefined;
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
	gates: TaskGate[];
	links: TaskLink[];
	/** What it waits on now: open dependencies, then closed gates. */
	waitsOn: string[];
	/** The tool call that created it, to find where it was planned. */
	createdCall?: string;
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
	/**
	 * A plan-mode session: the plan goes on the board and nothing is started,
	 * by `start` or by the auto-start. "T1 is active now (started for you)"
	 * read as "go": pandorum 2026-11-21 (sgwez, gemma4-26b-agentic) answered
	 * it with "Okay, I'm starting T1. I will use sed" in plan mode.
	 */
	planMode?: boolean;
	/**
	 * Whether an agent's claim still holds: its run is live. A task held by a
	 * live run is refused to anyone else unless forced (plan section 7).
	 * Without it every claim holds until released.
	 */
	isHolderLive?: (holder: string) => boolean;
	/** Said when a claim is taken by force, for the log. */
	onForcedClaim?: (id: string, from: string, to: string) => void;
}

export class TaskGraphStore {
	private events: TaskEvent[] = [];
	private state: TaskGraphState = emptyTaskGraphState();
	private readonly logPath: string | undefined;
	private readonly onChange: ((store: TaskGraphStore) => void) | undefined;
	private readonly now: () => number;
	readonly planMode: boolean;
	private isHolderLive: ((holder: string) => boolean) | undefined;
	private readonly onForcedClaim:
		| ((id: string, from: string, to: string) => void)
		| undefined;

	constructor(options: TaskGraphStoreOptions = {}) {
		this.planMode = options.planMode === true;
		this.isHolderLive = options.isHolderLive;
		this.onForcedClaim = options.onForcedClaim;
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
		seed?: TaskGraphSeed,
	): "resumed" | "rewound" | "replayed" | "imported" | "seeded" | "empty" {
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
		// A working call's \`task_done\` is replayed too. Whether that call
		// succeeded is not in the call, so it is taken as sent: a refused edit
		// that also closed a task is the one case this gets wrong.
		const carriedDone = (call: HistoryToolCall): unknown =>
			TASK_DONE_TOOL_NAMES.has(call.name) &&
			call.input &&
			typeof call.input === "object"
				? (call.input as Record<string, unknown>)[TASK_DONE_PARAM]
				: undefined;
		const taskCalls = calls.filter(
			(call) =>
				call.name === TASK_PLAN_TOOL_NAME ||
				call.name === TASK_UPDATE_TOOL_NAME ||
				carriedDone(call) !== undefined,
		);
		if (taskCalls.some((call) => TASK_GRAPH_TOOL_NAMES.has(call.name))) {
			for (const call of taskCalls) {
				const origin = { by: "model", ...(call.id ? { call: call.id } : {}) };
				if (call.name === TASK_PLAN_TOOL_NAME) {
					this.plan(call.input, origin, { silent: true });
				} else if (call.name === TASK_UPDATE_TOOL_NAME) {
					this.update(call.input, origin, { silent: true });
				} else {
					this.finish(carriedDone(call), origin, { silent: true });
				}
			}
			this.onChange?.(this);
			return "replayed";
		}
		// A conversation started from a saved board: its events, ids kept, each
		// authored by where it came from. Made by no call, so a later cut-back
		// keeps them, as it keeps any import.
		if (seed && seed.events.length > 0) {
			let applied = 0;
			for (const raw of seed.events) {
				const body = seedEventBody(raw);
				if (!body) continue;
				this.record(body, { by: seed.by });
				applied += 1;
			}
			if (applied > 0) {
				this.onChange?.(this);
				return "seeded";
			}
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
		options: { silent?: boolean; autoStart?: boolean } = {},
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
						...(item.gates.length
							? {
									gates: item.gates.map((gate) =>
										absoluteGate(gate, this.now()),
									),
								}
							: {}),
						...(item.links.length
							? { links: this.resolveLinkTargets(item.links, id, lines) }
							: {}),
					},
				},
				origin,
			);
			if (item.files.length) {
				this.record(
					{ op: "update", update: { id, files: item.files } },
					origin,
				);
			}
			batchIds.push(id);
			created.push(id);
			this.applyLinkEffects(id, origin, lines);
			if (item.start && !this.planMode) {
				const task = this.state.tasks.get(id) as Task;
				const open = waitsOn(this.state, task);
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
			const wait = waitsOn(this.state, task);
			const after = wait.length ? ` (after ${wait.join(", ")})` : "";
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
		if (options.autoStart !== false) this.autoStart(origin, lines);
		if (this.planMode) {
			lines.push(
				"Plan mode: nothing is started. The work starts in act mode, once the user agrees. When the plan is complete, present it and ask the user how to proceed.",
			);
		}
		if (!options.silent) this.onChange?.(this);
		return { lines, changed: true, readyNow };
	}

	/**
	 * With nothing active, start the first ready task and say so.
	 *
	 * Starting a task was a request of its own: 29 of 101 `task_update`
	 * calls in phase 1b did nothing else, and S5 nudged for the rest. After a
	 * plan or a close with nothing else under way, the next ready task is the
	 * one the model takes up anyway; when it is not, one call moves it.
	 */
	private autoStart(origin: TaskChangeOrigin, lines: string[]): void {
		// A teammate's close starts nothing for it: it claims its next task,
		// and the lead hands the rest out.
		if (this.planMode || isAgentAuthor(origin.by)) return;
		const active = this.state.order.some(
			(id) => this.state.tasks.get(id)?.status === "active",
		);
		if (active) return;
		const next = readyTasks(this.state)[0];
		if (!next) return;
		this.record(
			{ op: "update", update: { id: next.id, status: "active" } },
			origin,
		);
		lines.push(
			`${next.id} is active now (started for you, since nothing else was): ${shortTitle(next.title, 60)}.`,
		);
	}

	/**
	 * Close tasks named by a working call's `task_done`: done, with the note
	 * as the outcome and its acceptance ticked, since saying it is done is
	 * saying those hold. The next ready task starts as after any close.
	 */
	finish(
		value: unknown,
		origin: TaskChangeOrigin = {},
		options: { silent?: boolean } = {},
	): TaskOperationOutcome {
		const entries = readTaskDone(value);
		const bad = entries.filter((entry) => !entry.id);
		const good = entries.filter((entry) => entry.id);
		const lines: string[] = bad.map(
			(entry) =>
				`\`task_done\` ${JSON.stringify(entry.raw)} names no task: send its id, as "T3: what was done".`,
		);
		if (entries.length === 0) {
			lines.push(
				'`task_done` names no task: send its id, as "T3: what was done".',
			);
		}
		if (good.length === 0) return { lines, changed: false, readyNow: [] };
		const outcome = this.update(
			{
				updates: good.map((entry) => ({
					id: entry.id,
					status: "done",
					check: ["*"],
					...(entry.note ? { note: entry.note } : {}),
				})),
			},
			origin,
			options,
		);
		return { ...outcome, lines: [...lines, ...outcome.lines] };
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
		const closedBefore = new Set(
			this.state.order.filter((id) =>
				isClosed((this.state.tasks.get(id) as Task).status),
			),
		);
		for (const item of items) {
			const result = this.applyUpdate(item, origin);
			lines.push(...result.lines);
			changed ||= result.changed;
		}
		const closedNow = this.state.order.some(
			(id) =>
				!closedBefore.has(id) &&
				isClosed((this.state.tasks.get(id) as Task).status),
		);
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
			// S5: what the close made possible.
			lines.push(
				`Ready now: ${readyNow
					.map(
						(id) =>
							`${id} ${shortTitle((this.state.tasks.get(id) as Task).title, 50)}`,
					)
					.join("; ")}.`,
			);
		}
		if (closedNow) this.autoStart(origin, lines);
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
		const gates = task.gates ?? [];
		const newGates = item.gatesAdd
			.map((spec) => absoluteGate(spec, this.now()))
			.filter((spec) => !gates.some((gate) => gate.spec === spec));
		if (newGates.length) update.gatesAdd = newGates;
		const removeGates = item.gatesRemove.filter((spec) =>
			gates.some((gate) => gate.spec === spec),
		);
		for (const spec of item.gatesRemove) {
			if (!removeGates.includes(spec))
				lines.push(`${id}: no gate ${spec} to remove.`);
		}
		if (removeGates.length) update.gatesRemove = removeGates;
		if (item.gatesOpen.length) {
			// The person resolves gates; the others open by themselves.
			if (origin.by === "user") {
				const opening = item.gatesOpen.filter((spec) =>
					gates.some((gate) => gate.spec === spec && !gate.open),
				);
				if (opening.length) update.gatesOpen = opening;
			} else {
				lines.push(
					`${id}: gates are not opened by a tool call: \`human:\` gates open when the person answers, the others when what they wait on happens. Remove one that no longer applies with \`gate_remove\`.`,
				);
			}
		}
		if (item.linksAdd.length) {
			const add = this.resolveLinkTargets(item.linksAdd, id, lines);
			if (add.length) update.linksAdd = add;
		}
		if (item.linksRemove.length) update.linksRemove = item.linksRemove;
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
		// Closing as done says the acceptance holds, as \`task_done\` does: tick
		// what is open unless the call ticks or unticks items itself. The
		// "unticked acceptance" reply this replaces was followed by a request
		// that only ticked: 23, 8 and 14 of them against 74, 64 and 59 closing
		// calls in tg-bench arms B, C and C2 (2026-11-20).
		if (
			item.status === "done" &&
			task.status !== "done" &&
			!item.check.length &&
			!item.uncheck.length
		) {
			const open = acceptanceAfterAdd
				.map((_, index) => index)
				.filter((index) => !task.acceptance[index]?.done);
			if (open.length) update.check = open;
		}
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
		// A task a live agent holds is refused to anyone else unless forced.
		// The person is never refused: the panel is their override.
		const holder = task.claimedBy;
		// A teammate starting a task the lead had active (the auto-start) is
		// still its claim.
		const claiming =
			item.status === "active" &&
			isAgentAuthor(origin.by) &&
			holder !== origin.by;
		const wantsStatus =
			(item.status && item.status !== task.status) || claiming;
		const heldByOther =
			holder !== undefined &&
			holder !== (origin.by ?? "model") &&
			origin.by !== "user" &&
			!isClosed(task.status) &&
			(this.isHolderLive?.(holder) ?? true);
		let statusAllowed = true;
		if (wantsStatus && heldByOther) {
			if (item.force) {
				this.onForcedClaim?.(id, holder as string, origin.by ?? "model");
				update.note = [
					update.note,
					`taken over from ${holder} by ${origin.by ?? "model"} (forced)`,
				]
					.filter(Boolean)
					.join("; ");
			} else {
				statusAllowed = false;
				lines.push(
					`${id} is held by ${holder}, whose run is still going: its status was not changed. Leave it to ${holder}, or send \`force: true\` with the update to take it over.`,
				);
			}
		}
		if (item.status && wantsStatus && statusAllowed) {
			if (item.status === "active") {
				const removed = new Set(update.gatesRemove ?? []);
				const open = waitsOn(this.state, {
					...task,
					depends: [
						...task.depends.filter(
							(dep) => !(update.dependsRemove ?? []).includes(dep),
						),
						...(update.dependsAdd ?? []),
					],
					gates: [
						...gates.filter((gate) => !removed.has(gate.spec)),
						...(update.gatesAdd ?? []).map((spec) => ({ spec, open: false })),
					].map((gate) =>
						(update.gatesOpen ?? []).includes(gate.spec)
							? { ...gate, open: true }
							: gate,
					),
				});
				if (open.length > 0) {
					lines.push(
						`${id} not started: it is after ${open.join(", ")}, still open. Finish those first, or drop the dependency with \`depends_remove\` (a gate with \`gate_remove\`).`,
					);
				} else {
					update.status = "active";
					// A teammate's start is its claim.
					if (isAgentAuthor(origin.by)) update.claimedBy = origin.by as string;
					else if (holder && item.force) update.claimedBy = null;
				}
			} else {
				update.status = item.status;
				// Put back: whoever held it lets it go.
				if (item.status === "pending" && holder) update.claimedBy = null;
			}
		} else if (
			!item.status &&
			task.status === "active" &&
			(update.gatesAdd ?? []).length > 0
		) {
			// Active work that now waits on something is waiting, so the
			// close-out does not ask for it and the next task can start.
			update.status = "waiting";
		}
		const keys = Object.keys(update).filter((key) => key !== "id");
		if (keys.length === 0) {
			if (lines.length === 0) lines.push(`${id}: nothing to change.`);
			return { lines, changed: false };
		}
		this.record({ op: "update", update }, origin);
		if (update.linksAdd) this.applyLinkEffects(id, origin, lines);
		if (update.gatesOpen) this.releaseGated(origin, lines);
		const after = this.state.tasks.get(id) as Task;
		const said: string[] = [];
		if (update.status) said.push(`now ${update.status}`);
		if (update.check?.length || update.uncheck?.length) {
			said.push(
				`checks ${after.acceptance.filter((entry) => entry.done).length}/${after.acceptance.length}`,
			);
		}
		if (update.dependsAdd) said.push(`after ${update.dependsAdd.join(", ")}`);
		if (update.gatesAdd) said.push(`waits on ${update.gatesAdd.join(", ")}`);
		if (update.gatesOpen) said.push(`${update.gatesOpen.join(", ")} resolved`);
		if (update.linksAdd)
			said.push(
				`linked ${update.linksAdd.map((link) => `${link.type} ${link.target}`).join(", ")}`,
			);
		if (update.claimedBy) said.push(`held by ${update.claimedBy}`);
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
	// Links, gates and claims
	// -------------------------------------------------------------------------

	/** Task links whose target exists and is not the task itself; the rest said. */
	private resolveLinkTargets(
		links: readonly TaskLink[],
		self: string,
		lines: string[],
	): TaskLink[] {
		return links.filter((link) => {
			if (!isTaskLinkType(link.type)) return true;
			if (link.target === self) {
				lines.push(
					`${self}: link ${link.type} ${link.target} ignored: a task cannot link to itself.`,
				);
				return false;
			}
			if (!this.state.tasks.has(link.target)) {
				lines.push(
					`${self}: link ${link.type} ${link.target} ignored: no such task.`,
				);
				return false;
			}
			return true;
		});
	}

	/**
	 * `supersedes` and `duplicate-of` close the replaced task (from beads): T5
	 * supersedes T3 cancels T3; T5 duplicate-of T3 cancels T5. What waited on
	 * the replaced task waits on its replacement instead, so nothing becomes
	 * ready because the work it needed was renamed.
	 */
	private applyLinkEffects(
		id: string,
		origin: TaskChangeOrigin,
		lines: string[],
	): void {
		const task = this.state.tasks.get(id);
		if (!task) return;
		for (const link of task.links ?? []) {
			let replaced: string;
			let replacement: string;
			if (link.type === "supersedes") {
				replaced = link.target;
				replacement = id;
			} else if (link.type === "duplicate-of") {
				replaced = id;
				replacement = link.target;
			} else {
				continue;
			}
			const old = this.state.tasks.get(replaced);
			if (!old || isClosed(old.status)) continue;
			for (const dependent of dependentsOf(this.state, replaced)) {
				if (dependent.id === replacement) continue;
				if (
					isAncestorOf(this.state, replacement, dependent.id) ||
					wouldCycle(this.state, dependent.id, replacement)
				)
					continue;
				this.record(
					{
						op: "update",
						update: { id: dependent.id, dependsAdd: [replacement] },
					},
					origin,
				);
				lines.push(
					`${dependent.id} now waits on ${replacement} in place of ${replaced}.`,
				);
			}
			const note =
				link.type === "supersedes"
					? `superseded by ${replacement}`
					: `duplicate of ${replacement}`;
			this.record(
				{
					op: "update",
					update: {
						id: replaced,
						status: "cancelled",
						note,
						...(old.claimedBy ? { claimedBy: null } : {}),
					},
				},
				origin,
			);
			lines.push(`${replaced} cancelled: ${note}.`);
		}
	}

	/**
	 * Tasks put on hold by gates that have all opened go back to pending,
	 * where they are ready if nothing else holds them.
	 */
	private releaseGated(origin: TaskChangeOrigin, lines: string[]): void {
		for (const id of this.state.order) {
			const task = this.state.tasks.get(id) as Task;
			if (task.status !== "waiting" || (task.gates ?? []).length === 0)
				continue;
			if (openGates(this.state, task).length > 0) continue;
			this.record(
				{ op: "update", update: { id, status: "pending" } },
				{ ...origin, by: origin.by ?? "gate" },
			);
			lines.push(`${id} no longer waits: its gates opened.`);
		}
	}

	/** Every closed gate on an open task, with the task. */
	closedGates(): { task: Task; gate: TaskGate }[] {
		const out: { task: Task; gate: TaskGate }[] = [];
		for (const id of this.state.order) {
			const task = this.state.tasks.get(id) as Task;
			if (isClosed(task.status)) continue;
			for (const gate of task.gates ?? []) {
				if (!gate.open) out.push({ task, gate });
			}
		}
		return out;
	}

	/**
	 * Ask `decide` about every closed gate and record what it says: opened,
	 * or failed (said once; a gate already failed for the same reason is not
	 * recorded again). Tasks whose gates all opened are released, and what
	 * became ready is said as a close says it.
	 */
	resolveGates(
		decide: (gate: TaskGate, task: Task) => GateDecision,
		origin: TaskChangeOrigin = { by: "gate" },
	): TaskOperationOutcome {
		const lines: string[] = [];
		const readyBefore = new Set(readyTasks(this.state).map((task) => task.id));
		let changed = false;
		for (const { task, gate } of this.closedGates()) {
			const decision = decide(gate, task);
			if (!decision) continue;
			if ("open" in decision) {
				this.record(
					{ op: "update", update: { id: task.id, gatesOpen: [gate.spec] } },
					origin,
				);
				lines.push(`${task.id}: ${gate.spec} opened.`);
				changed = true;
			} else if (gate.failed !== decision.failed) {
				this.record(
					{
						op: "update",
						update: {
							id: task.id,
							gatesFailed: [{ gate: gate.spec, reason: decision.failed }],
						},
					},
					origin,
				);
				lines.push(
					`${task.id}: ${gate.spec} can no longer open (${decision.failed}). Remove it with \`gate_remove\`, or replace it, if the task should go on.`,
				);
				changed = true;
			}
		}
		if (!changed) return { lines, changed, readyNow: [] };
		this.releaseGated(origin, lines);
		const readyNow = readyTasks(this.state)
			.map((task) => task.id)
			.filter((id) => !readyBefore.has(id));
		if (readyNow.length > 0) {
			lines.push(
				`Ready now: ${readyNow
					.map(
						(id) =>
							`${id} ${shortTitle((this.state.tasks.get(id) as Task).title, 50)}`,
					)
					.join("; ")}.`,
			);
			this.autoStart(origin, lines);
		}
		this.onChange?.(this);
		return { lines, changed, readyNow };
	}

	/**
	 * A claim ends with its run (plan section 7): what the holder left active
	 * goes back to pending, unheld, with why. Returns the ids put back.
	 */
	releaseClaims(holder: string, reason: string): string[] {
		const released: string[] = [];
		for (const id of this.state.order) {
			const task = this.state.tasks.get(id) as Task;
			if (task.claimedBy !== holder || isClosed(task.status)) continue;
			this.record(
				{
					op: "update",
					update: {
						id,
						claimedBy: null,
						...(task.status === "active" ? { status: "pending" } : {}),
						note: `${holder} let it go: ${reason}`,
					},
				},
				{ by: "host" },
			);
			released.push(id);
		}
		if (released.length) this.onChange?.(this);
		return released;
	}

	/**
	 * Hold a task for an agent without starting it: assigned at creation, it
	 * is that agent's to start once nothing holds it back.
	 */
	assign(id: string, holder: string, origin: TaskChangeOrigin = {}): void {
		const task = this.state.tasks.get(id);
		if (!task || isClosed(task.status)) return;
		this.record({ op: "update", update: { id, claimedBy: holder } }, origin);
		this.onChange?.(this);
	}

	/** Whether a holder's claim still stands. Set once the team exists. */
	setHolderLive(check: ((holder: string) => boolean) | undefined): void {
		this.isHolderLive = check;
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
				gates: (task.gates ?? []).map((gate) => ({ ...gate })),
				links: (task.links ?? []).map((link) => ({ ...link })),
				waitsOn: waitsOn(state, task),
				...(task.createdCall ? { createdCall: task.createdCall } : {}),
				notes: task.notes.map((note) => note.text),
				...(task.outcome ? { outcome: task.outcome } : {}),
				ready,
				blocked:
					!isClosed(task.status) &&
					task.status !== "active" &&
					!ready &&
					(openDepends.length > 0 || openGates(state, task).length > 0),
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
