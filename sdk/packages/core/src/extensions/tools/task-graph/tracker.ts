/**
 * The task graph's half of the harness: watching the run's tool calls and
 * saying something when the board needs attention.
 *
 * Phase 1 carries over the two guards the checklist had, pointed at the
 * graph (the full nudge set is phase 1b):
 *
 * - **Untracked edit.** A call that changes a file while no task is active is
 *   work nobody wrote down. Said on the first such edit, then every
 *   `writeInterval` after it, as the checklist's was.
 * - **Close-out.** A run that ends with active or ready tasks is asked, twice
 *   and differently, to close them or say why they stay open.
 *
 * And one thing the checklist could not do: after a compaction the board is
 * put back in front of the model, because the calls that built it were just
 * summarised away. Nothing is sent on a timer -- phase 0 measured the
 * every-six-calls reminder re-sending an unchanged list most of the time.
 *
 * Unlike the checklist, nothing is added to any tool's schema.
 */

import type { AgentTool } from "@cline/shared";
import { WRITE_CLASS_TOOL_NAMES } from "../../../runtime/safety/loop-detection";
import { DEFAULT_TASK_PROGRESS_WRITE_INTERVAL } from "../task-progress";
import { renderBoard, shortTitle } from "./board";
import { openWork, type Task } from "./model";
import {
	TASK_GRAPH_TOOL_NAMES,
	TaskGraphStore,
	type TaskGraphStoreOptions,
} from "./store";
import { createTaskGraphTools } from "./tools";

export interface TaskGraphTrackerOptions extends TaskGraphStoreOptions {
	/** Edits between repeats of the untracked-edit nudge. */
	writeInterval?: number;
}

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

export type UntrackedKind = "missing" | "idle" | "finished";

export function buildTaskGraphUntrackedNudge(
	kind: UntrackedKind,
	path: string | undefined,
	ready: Task[] = [],
): string {
	const changed = path ? `\`${path}\`` : "a file";
	if (kind === "missing") {
		return [
			`[SYSTEM] You just changed ${changed}, and this task has no plan.`,
			"Before the next change, write the plan with one `task_plan` call: every step the request needs, each with its acceptance, and the order between them (`depends`).",
			'Mark the step you are on with `"start": true`.',
		].join(" ");
	}
	if (kind === "idle") {
		const next = ready[0];
		return [
			`[SYSTEM] You just changed ${changed}, and no task is active.`,
			next
				? `If this is work on ${next.id} (${shortTitle(next.title, 50)}), start it with \`task_update\` (status active); if it is a step the plan does not have, add it with \`task_plan\`.`
				: "Start the task this belongs to with `task_update` (status active), or add it with `task_plan` if the plan does not have it.",
		].join(" ");
	}
	return [
		`[SYSTEM] Every task is closed, and you just changed ${changed}.`,
		"That change is work on a step the plan does not have: add it with `task_plan` (start: true), and close it with what was checked once it is done.",
	].join(" ");
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

const CLOSE_OUT_ATTEMPTS = 2;

const TASK_GRAPH_WRAPPED: unique symbol = Symbol.for("cline.taskGraphWrapped");

export class TaskGraphTracker {
	readonly store: TaskGraphStore;
	private readonly writeInterval: number;
	private untrackedEdits = 0;
	private pending: string | undefined;
	private readonly pendingFrom = new Set<unknown>();
	private boardDue = false;
	private closeOutFired = 0;

	constructor(options: TaskGraphTrackerOptions = {}) {
		this.store = new TaskGraphStore(options);
		this.writeInterval =
			options.writeInterval ?? DEFAULT_TASK_PROGRESS_WRITE_INTERVAL;
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
	 * to the model with its next tool results.
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

	/** A compaction landed: the calls that built the board are gone. */
	noteCompaction(): void {
		if (!this.store.isEmpty()) this.boardDue = true;
	}

	private hasActive(): boolean {
		return this.store.snapshot().tasks.some((task) => task.status === "active");
	}

	/** Record one call, before it runs. */
	recordToolCall(input: unknown, toolName?: string): void {
		if (toolName && TASK_GRAPH_TOOL_NAMES.has(toolName)) {
			return;
		}
		if (!changesFiles(toolName, input)) return;
		if (this.hasActive()) {
			this.untrackedEdits = 0;
			return;
		}
		const state = this.store.getState();
		const snapshot = this.store.snapshot();
		const kind: UntrackedKind =
			snapshot.counts.total === 0
				? "missing"
				: snapshot.counts.closed === snapshot.counts.total
					? "finished"
					: "idle";
		this.untrackedEdits += 1;
		const interval = Math.max(1, this.writeInterval);
		if ((this.untrackedEdits - 1) % interval !== 0) return;
		const ready = snapshot.tasks
			.filter((task) => task.ready)
			.map((task) => state.tasks.get(task.id) as Task);
		const nudge = buildTaskGraphUntrackedNudge(
			kind,
			readEditedPath(input),
			ready,
		);
		if (this.pending !== nudge) this.pendingFrom.clear();
		this.pending = nudge;
		this.pendingFrom.add(input);
	}

	/** Take back what a call that then failed was counted for. */
	retractFailedWrite(input: unknown, toolName?: string): void {
		if (!changesFiles(toolName, input) || this.untrackedEdits === 0) return;
		this.untrackedEdits -= 1;
		if (this.pendingFrom.delete(input) && this.pendingFrom.size === 0) {
			this.pending = undefined;
		}
	}

	/** What to say after the turn's tool calls, cleared by the read. */
	takePendingReminder(): string | undefined {
		const parts: string[] = [];
		if (this.pending) parts.push(this.pending);
		if (this.boardDue) {
			const board = renderBoard(this.store.getState());
			if (board) parts.push(`[SYSTEM] The task board, as it stands:\n${board}`);
		}
		this.pending = undefined;
		this.pendingFrom.clear();
		this.boardDue = false;
		return parts.length ? parts.join("\n\n") : undefined;
	}

	/** The completion guard: at most two different asks per run. */
	completionGuard(): () => string | undefined {
		return () => {
			if (this.closeOutFired >= CLOSE_OUT_ATTEMPTS) return undefined;
			const open = openWork(this.store.getState());
			if (open.length === 0) return undefined;
			this.closeOutFired += 1;
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
			if (reportsFailure(result)) tracker.retractFailedWrite(input, tool.name);
			return result;
		},
	};
	Object.defineProperty(wrapped, TASK_GRAPH_WRAPPED, {
		value: true,
		enumerable: false,
	});
	return wrapped;
}
