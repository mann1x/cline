/**
 * The task graph's half of the harness: watching the run's tool calls and
 * saying something when the board needs attention -- at the moment it does,
 * rather than on a timer. Phase 0 measured the checklist's every-six-calls
 * reminder re-sending an unchanged list most of the time, and the list being
 * written after the work it was meant to plan.
 *
 * The solo nudges (plan section 10):
 *
 * | id | when |
 * |---|---|
 * | S1 plan | no task yet, and the run has changed a file or made its 4th call |
 * | S2 untracked | a file change while tasks exist and none is active |
 * | S3 stale | 3 file changes since the active task was last touched |
 * | S4 verified | a test or build command passes while a task is active |
 * | S5 ready | a close unblocked tasks (said in `task_update`'s own result) |
 * | S7 resume | the board, after a compaction or on resume |
 * | S8 close-out | the run ends with active or ready tasks (completion guard) |
 *
 * Rules shared by all of them:
 * - **Once per situation.** Each has a key (S3's is the task and the event
 *   that last touched it), and a key is said at most twice, the second time
 *   in different words: a nudge repeated verbatim was measured doing nothing.
 * - **One nudge per three tool calls.** A busy run is never nagged twice in a
 *   row. The close-out and the board after a compaction are not counted:
 *   one ends the run, the other replaces calls the model can no longer see.
 * - **Every one names the tool call that answers it**, with its arguments.
 *
 * Nothing is added to any tool's schema.
 */

import type { AgentTool } from "@cline/shared";
import { WRITE_CLASS_TOOL_NAMES } from "../../../runtime/safety/loop-detection";
import { renderBoard, shortTitle } from "./board";
import { openWork, type Task } from "./model";
import {
	TASK_GRAPH_TOOL_NAMES,
	TaskGraphStore,
	type TaskGraphStoreOptions,
} from "./store";
import { createTaskGraphTools } from "./tools";

export interface TaskGraphTrackerOptions extends TaskGraphStoreOptions {
	/**
	 * Tool calls that must pass after one nudge before the next. Default 3.
	 * (Named for the setting it replaces; the checklist's write interval.)
	 */
	writeInterval?: number;
	/** Called with a nudge's id each time one is queued, for logs and counts. */
	onNudge?: (id: string, key: string) => void;
}

/** Calls with no task before S1 asks for a plan anyway. */
const PLAN_BY_CALL = 4;
/** File changes under one active task, untouched, before S3. */
const STALE_WRITES = 3;
const DEFAULT_NUDGE_SPACING = 3;
const MAX_ATTEMPTS = 2;
const CLOSE_OUT_ATTEMPTS = 2;

function readEditedPath(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const record = input as {
		path?: unknown;
		file_path?: unknown;
		files?: unknown;
	};
	const path =
		record.path ??
		record.file_path ??
		(Array.isArray(record.files) ? record.files[0] : undefined);
	return typeof path === "string" && path.trim() ? path.trim() : undefined;
}

function changesFiles(toolName: string | undefined, input: unknown): boolean {
	if (toolName === undefined || !WRITE_CLASS_TOOL_NAMES.has(toolName))
		return false;
	if (toolName === "awk") return false;
	if (toolName === "sed") {
		return (
			typeof input === "object" &&
			input !== null &&
			(input as { in_place?: unknown }).in_place === true
		);
	}
	return true;
}

function reportsFailure(result: unknown): boolean {
	const failed = (entry: unknown): boolean =>
		typeof entry === "object" &&
		entry !== null &&
		(entry as { success?: unknown }).success === false;
	return Array.isArray(result)
		? result.length > 0 && result.every(failed)
		: failed(result);
}

function reportsSuccess(result: unknown): boolean {
	const ok = (entry: unknown): boolean =>
		typeof entry === "object" &&
		entry !== null &&
		(entry as { success?: unknown }).success === true;
	return Array.isArray(result)
		? result.length > 0 && result.every(ok)
		: ok(result);
}

/**
 * Commands that check work: test runners, type checkers, builds, linters.
 * Matched on the command text, so `cd x && python3 -m unittest` counts.
 */
const CHECK_COMMAND =
	/\b(?:pytest|unittest|py\.test|tox|nox|jest|vitest|mocha|ava|go\s+(?:test|vet|build)|cargo\s+(?:test|check|build|clippy)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|check|lint|typecheck)|tsc\b|mypy|pyright|ruff|eslint|biome|make(?:\s+\S+)*\s+(?:test|check|build)|gradle\w*\s+(?:test|build)|mvn\s+(?:test|verify)|dotnet\s+(?:test|build)|ctest|phpunit|rspec)\b/i;

export function readCheckCommand(
	toolName: string | undefined,
	input: unknown,
): string | undefined {
	if (
		toolName !== "run_commands" ||
		typeof input !== "object" ||
		input === null
	)
		return undefined;
	const commands = (input as { commands?: unknown }).commands;
	const list = Array.isArray(commands) ? commands : [commands];
	for (const entry of list) {
		const text =
			typeof entry === "string"
				? entry
				: typeof entry === "object" && entry !== null
					? (entry as { command?: unknown }).command
					: undefined;
		if (typeof text === "string" && CHECK_COMMAND.test(text)) {
			return text.length > 80 ? `${text.slice(0, 79)}…` : text;
		}
	}
	return undefined;
}

export type UntrackedKind = "missing" | "idle" | "finished";

const PLAN_EXAMPLE =
	'`task_plan` {"tasks":[{"title":"…","acceptance":["…"],"start":true},{"title":"…","depends":["#1"]}]}';

/** S1, and S2's two shapes. The first attempt asks; the second narrows. */
export function buildTaskGraphUntrackedNudge(
	kind: UntrackedKind,
	path: string | undefined,
	ready: Task[] = [],
	attempt: 1 | 2 = 1,
): string {
	const changed = path ? `\`${path}\`` : "a file";
	if (kind === "missing") {
		if (attempt === 2) {
			return [
				"[SYSTEM] There is still no plan, and the work has gone on without one.",
				`Write it now, in one call, before the next change: ${PLAN_EXAMPLE}.`,
				"Every step the request needs, each with what has to be true when it is done; mark the one you are on with start.",
			].join(" ");
		}
		return [
			`[SYSTEM] You just changed ${changed}, and this task has no plan.`,
			"Before the next change, write the plan with one `task_plan` call: every step the request needs, each with its acceptance, and the order between them (`depends`).",
			'Mark the step you are on with `"start": true`.',
		].join(" ");
	}
	if (kind === "idle") {
		const next = ready[0];
		const start = next
			? `\`task_update\` {"updates":[{"id":"${next.id}","status":"active"}]}`
			: "`task_update` (status active)";
		if (attempt === 2) {
			return [
				`[SYSTEM] Files are changing while no task is active (${changed} just now).`,
				`Say which task this work is: ${start}, or add it with \`task_plan\` if the plan does not have it.`,
			].join(" ");
		}
		return [
			`[SYSTEM] You just changed ${changed}, and no task is active.`,
			next
				? `If this is work on ${next.id} (${shortTitle(next.title, 50)}), start it: ${start}; if it is a step the plan does not have, add it with \`task_plan\`.`
				: "Start the task this belongs to with `task_update` (status active), or add it with `task_plan` if the plan does not have it.",
		].join(" ");
	}
	return [
		`[SYSTEM] Every task is closed, and you just changed ${changed}.`,
		'That change is work on a step the plan does not have: add it with `task_plan` ("start": true), and close it with what was checked once it is done.',
	].join(" ");
}

/** S1 before any change: the run is several calls in with nothing planned. */
export function buildTaskGraphPlanFirstNudge(calls: number): string {
	return [
		`[SYSTEM] ${calls} calls in and there is no plan yet.`,
		`If this request needs changes, write the plan before the first one, in one call: ${PLAN_EXAMPLE}.`,
		"Every step with its acceptance and the order between them; start the first.",
		"If it only needs an answer, carry on: no plan is needed.",
	].join(" ");
}

/** S3: the active task has gone untouched across several changes. */
export function buildTaskGraphStaleNudge(
	task: Task,
	files: string[],
	attempt: 1 | 2 = 1,
): string {
	const where = files.length
		? ` (${files
				.slice(0, 3)
				.map((file) => `\`${file}\``)
				.join(", ")}${files.length > 3 ? ", …" : ""})`
		: "";
	if (attempt === 2) {
		return [
			`[SYSTEM] ${task.id} is still the active task after more changes${where}.`,
			`One \`task_update\` settles it: status done with a note of what was checked, or a note saying what is left.`,
		].join(" ");
	}
	return [
		`[SYSTEM] ${STALE_WRITES} changes${where} since ${task.id} (${shortTitle(task.title, 50)}) was last updated.`,
		`If it is finished, close it with what was done and how it was checked: \`task_update\` {"updates":[{"id":"${task.id}","status":"done","note":"…"}]}.`,
		"If not, add a note saying where it stands.",
	].join(" ");
}

/** S4: a check passed while a task is active. */
export function buildTaskGraphVerifiedNudge(
	task: Task,
	command: string,
): string {
	const open = task.acceptance
		.map((item, index) => ({ ...item, index: index + 1 }))
		.filter((item) => !item.done);
	const tick = open.length
		? ` Tick what it shows with \`check\` (${open
				.slice(0, 3)
				.map((item) => `${item.index}: ${shortTitle(item.text, 40)}`)
				.join("; ")}).`
		: "";
	return [
		`[SYSTEM] \`${command}\` passed while ${task.id} (${shortTitle(task.title, 50)}) is active.`,
		`If it checks ${task.id}, close it with this as the note: \`task_update\` {"updates":[{"id":"${task.id}","status":"done","note":"…"}]}.${tick}`,
	].join("");
}

export function buildTaskGraphCloseOutNudge(
	open: Task[],
	attempt: 1 | 2,
): string {
	const list = open
		.map(
			(task) =>
				`- ${task.id} ${task.title} (${task.status === "active" ? "active" : "ready"})`,
		)
		.join("\n");
	if (attempt === 1) {
		return [
			"[SYSTEM] Before this run ends, close out the task board. These are still open:",
			list,
			"",
			"Done? Close each with `task_update` (status done) and a `note` saying what was done and how it was checked; several fit in one call.",
			"Not needed? Cancel it with the reason. Still to do? Do it now rather than ending here.",
		].join("\n");
	}
	return [
		"[SYSTEM] The board still shows these as open:",
		list,
		"",
		"This is the last time you will be asked. Answer with one `task_update` call that closes or cancels them,",
		"or say in one sentence which you are leaving open and why, so the board does not claim work nobody did.",
	].join("\n");
}

const TASK_GRAPH_WRAPPED: unique symbol = Symbol.for("cline.taskGraphWrapped");

interface QueuedNudge {
	id: string;
	key: string;
	text: string;
	/** The calls that queued it, so a call that then failed can take it back. */
	from: Set<unknown>;
}

export class TaskGraphTracker {
	readonly store: TaskGraphStore;
	private readonly spacing: number;
	private readonly onNudge: ((id: string, key: string) => void) | undefined;
	private calls = 0;
	/** Calls since the last nudge was queued; starts open. */
	private callsSinceNudge = Number.POSITIVE_INFINITY;
	private readonly attempts = new Map<string, number>();
	private queued: QueuedNudge | undefined;
	private boardDue = false;
	private closeOutFired = 0;
	/** Changes made under the active task since it was last touched. */
	private staleFor:
		| { id: string; seq: number; writes: number; files: string[] }
		| undefined;

	constructor(options: TaskGraphTrackerOptions = {}) {
		this.store = new TaskGraphStore(options);
		this.spacing = Math.max(1, options.writeInterval ?? DEFAULT_NUDGE_SPACING);
		this.onNudge = options.onNudge;
	}

	/** The three tools, writing to this tracker's store. */
	tools(author?: () => string): AgentTool<unknown, unknown>[] {
		return createTaskGraphTools(this.store, author) as AgentTool<
			unknown,
			unknown
		>[];
	}

	/**
	 * Bring the board in line with the history the session starts from (see
	 * `TaskGraphStore.reconcile`). A board that comes back non-empty is shown
	 * to the model with its next tool results (S7).
	 */
	start(
		history: readonly unknown[] | undefined,
		legacyChecklist?: { text: string; done: boolean }[],
	): ReturnType<TaskGraphStore["reconcile"]> {
		const result = this.store.reconcile(history, legacyChecklist);
		if (!this.store.isEmpty() && (history?.length ?? 0) > 0) {
			this.boardDue = true;
		}
		return result;
	}

	/** A compaction landed: the calls that built the board are gone (S7). */
	noteCompaction(): void {
		if (!this.store.isEmpty()) this.boardDue = true;
	}

	private activeTask(): Task | undefined {
		const state = this.store.getState();
		return state.order
			.map((id) => state.tasks.get(id) as Task)
			.find((task) => task.status === "active");
	}

	/**
	 * Queue a nudge if its situation has attempts left and the spacing allows.
	 * Returns whether it was queued.
	 */
	private nudge(
		id: string,
		key: string,
		text: (attempt: 1 | 2) => string,
		input: unknown,
	): boolean {
		const made = this.attempts.get(key) ?? 0;
		if (made >= MAX_ATTEMPTS) return false;
		if (this.queued?.key === key) {
			this.queued.from.add(input);
			return true;
		}
		if (this.callsSinceNudge < this.spacing) return false;
		// A more specific nudge for the same call replaces a waiting one; the
		// replaced one keeps its attempt, since it was never read.
		if (this.queued) {
			this.attempts.set(
				this.queued.key,
				(this.attempts.get(this.queued.key) ?? 1) - 1,
			);
		}
		const attempt = (made + 1) as 1 | 2;
		this.attempts.set(key, attempt);
		this.queued = { id, key, text: text(attempt), from: new Set([input]) };
		this.callsSinceNudge = 0;
		this.onNudge?.(id, key);
		return true;
	}

	/** Record one call, before it runs. */
	recordToolCall(input: unknown, toolName?: string): void {
		this.calls += 1;
		this.callsSinceNudge += 1;
		if (toolName && TASK_GRAPH_TOOL_NAMES.has(toolName)) {
			return;
		}
		const snapshot = this.store.snapshot();
		const writes = changesFiles(toolName, input);
		if (!writes) {
			// S1 by call count: planning is cheapest before the first change.
			if (snapshot.counts.total === 0 && this.calls >= PLAN_BY_CALL) {
				this.nudge(
					"S1",
					"plan",
					(attempt) =>
						attempt === 1
							? buildTaskGraphPlanFirstNudge(this.calls)
							: buildTaskGraphUntrackedNudge("missing", undefined, [], 2),
					input,
				);
			}
			return;
		}
		const path = readEditedPath(input);
		const active = this.activeTask();
		if (active) {
			// S3: count changes under the active task since it was last touched.
			if (
				!this.staleFor ||
				this.staleFor.id !== active.id ||
				this.staleFor.seq !== active.touchedSeq
			) {
				this.staleFor = {
					id: active.id,
					seq: active.touchedSeq,
					writes: 0,
					files: [],
				};
			}
			this.staleFor.writes += 1;
			if (path && !this.staleFor.files.includes(path))
				this.staleFor.files.push(path);
			if (this.staleFor.writes >= STALE_WRITES) {
				const files = [...this.staleFor.files];
				this.nudge(
					"S3",
					`stale:${active.id}:${active.touchedSeq}`,
					(attempt) => buildTaskGraphStaleNudge(active, files, attempt),
					input,
				);
			}
			return;
		}
		const state = this.store.getState();
		if (snapshot.counts.total === 0) {
			this.nudge(
				"S1",
				"plan",
				(attempt) => buildTaskGraphUntrackedNudge("missing", path, [], attempt),
				input,
			);
			return;
		}
		const ready = snapshot.tasks
			.filter((task) => task.ready)
			.map((task) => state.tasks.get(task.id) as Task);
		const finished = snapshot.counts.closed === snapshot.counts.total;
		const kind: UntrackedKind = finished ? "finished" : "idle";
		this.nudge(
			"S2",
			finished
				? `finished:${snapshot.counts.total}`
				: `idle:${ready.map((task) => task.id).join(",")}`,
			(attempt) => buildTaskGraphUntrackedNudge(kind, path, ready, attempt),
			input,
		);
	}

	/** Record a call's result: S4 on a passing check, and failed writes taken back. */
	recordToolResult(
		input: unknown,
		toolName: string | undefined,
		result: unknown,
	): void {
		if (reportsFailure(result)) {
			this.retractFailedWrite(input, toolName);
			return;
		}
		const command = readCheckCommand(toolName, input);
		if (!command || !reportsSuccess(result)) return;
		const active = this.activeTask();
		if (!active) return;
		this.nudge(
			"S4",
			`verified:${active.id}:${active.touchedSeq}`,
			() => buildTaskGraphVerifiedNudge(active, command),
			input,
		);
	}

	/** Take back what a call that then failed was counted for. */
	retractFailedWrite(input: unknown, toolName?: string): void {
		if (!changesFiles(toolName, input)) return;
		if (this.staleFor && this.staleFor.writes > 0) this.staleFor.writes -= 1;
		const queued = this.queued;
		if (queued?.from.delete(input) && queued.from.size === 0) {
			this.attempts.set(queued.key, (this.attempts.get(queued.key) ?? 1) - 1);
			this.queued = undefined;
			this.callsSinceNudge = Number.POSITIVE_INFINITY;
		}
	}

	/** What to say after the turn's tool calls, cleared by the read. */
	takePendingReminder(): string | undefined {
		const parts: string[] = [];
		if (this.queued) parts.push(this.queued.text);
		if (this.boardDue) {
			const board = renderBoard(this.store.getState());
			if (board) parts.push(`[SYSTEM] The task board, as it stands:\n${board}`);
		}
		this.queued = undefined;
		this.boardDue = false;
		return parts.length ? parts.join("\n\n") : undefined;
	}

	/** S8, the completion guard: at most two different asks per session. */
	completionGuard(): () => string | undefined {
		return () => {
			if (this.closeOutFired >= CLOSE_OUT_ATTEMPTS) return undefined;
			const open = openWork(this.store.getState());
			if (open.length === 0) return undefined;
			this.closeOutFired += 1;
			this.onNudge?.("S8", `close-out:${this.closeOutFired}`);
			return buildTaskGraphCloseOutNudge(
				open,
				this.closeOutFired === 1 ? 1 : 2,
			);
		};
	}
}

export function isTaskGraphWrapped(tool: object): boolean {
	return (tool as Record<symbol, unknown>)[TASK_GRAPH_WRAPPED] === true;
}

/**
 * Wrap a tool so its calls feed the tracker. The schema is left alone: the
 * graph adds nothing to any tool, which is the point of replacing the
 * checklist parameter.
 */
export function withTaskGraphCapture<TInput, TOutput>(
	tool: AgentTool<TInput, TOutput>,
	tracker: TaskGraphTracker,
): AgentTool<TInput, TOutput> {
	if (isTaskGraphWrapped(tool)) return tool;
	const wrapped: AgentTool<TInput, TOutput> = {
		...tool,
		execute: async (input, context) => {
			tracker.recordToolCall(input, tool.name);
			let result: TOutput;
			try {
				result = await tool.execute(input, context);
			} catch (error) {
				tracker.retractFailedWrite(input, tool.name);
				throw error;
			}
			tracker.recordToolResult(input, tool.name, result);
			return result;
		},
	};
	Object.defineProperty(wrapped, TASK_GRAPH_WRAPPED, {
		value: true,
		enumerable: false,
	});
	return wrapped;
}
