/**
 * The three task tools: `task_plan`, `task_update`, `task_view`.
 *
 * Three, cut down from claude-hooks' thirteen, because on the models
 * Cerebriline targets every schema is a fixed price on every request and one
 * more name to confuse. The schemas are kept short for the same reason; the
 * readers behind them take far more than the schemas advertise.
 */

import { type AgentTool, createTool } from "@cline/shared";
import type { ToolOperationResult } from "../types";
import { renderBoard, renderLayers, renderTask } from "./board";
import { isBlocked, openDependencies, type Task } from "./model";
import { normalizeTaskId } from "./readers";
import {
	TASK_PLAN_TOOL_NAME,
	TASK_UPDATE_TOOL_NAME,
	TASK_VIEW_TOOL_NAME,
	type TaskGraphStore,
} from "./store";

const STATUS_ENUM = ["pending", "active", "waiting", "done", "cancelled"];

function answer(
	query: string,
	lines: string[],
	success: boolean,
): ToolOperationResult[] {
	return [{ query, result: lines.join("\n"), success }];
}

export function createTaskPlanTool(
	store: TaskGraphStore,
	author: () => string = () => "model",
): AgentTool<unknown, ToolOperationResult[]> {
	return createTool<unknown, ToolOperationResult[]>({
		name: TASK_PLAN_TOOL_NAME,
		description:
			"Write down the work as tasks, with the order between them, in one call. " +
			"Plan before you change files: list every step the request needs, each with what has to be true when it is done (`acceptance`). " +
			'In `depends` and `parent`, "#2" means the second task of this same call, so the whole plan goes in at once; an existing task is named by its id (T3). ' +
			"Returns the ids and the order; the first ready task is started for you.",
		inputSchema: {
			type: "object",
			properties: {
				tasks: {
					type: "array",
					items: {
						type: "object",
						properties: {
							title: { type: "string" },
							description: { type: "string" },
							acceptance: {
								type: "array",
								items: { type: "string" },
								description: "What must be true for this task to be done.",
							},
							depends: {
								type: "array",
								items: { type: "string" },
								description: 'Tasks this one waits on: "#1" (this call) or T3.',
							},
							parent: {
								type: "string",
								description: 'Makes this a subtask: "#1" or T3.',
							},
							priority: { type: "string", enum: ["H", "M", "L"] },
							start: {
								type: "boolean",
								description: "Mark it active right away.",
							},
						},
						required: ["title"],
					},
				},
			},
			required: ["tasks"],
		},
		retryable: false,
		maxRetries: 0,
		execute: async (input, context) => {
			const outcome = store.plan(input, {
				by: author(),
				...(context?.toolCallId ? { call: context.toolCallId } : {}),
			});
			// The store starts the first ready task when nothing is active.
			return answer(TASK_PLAN_TOOL_NAME, outcome.lines, outcome.changed);
		},
	});
}

export function createTaskUpdateTool(
	store: TaskGraphStore,
	author: () => string = () => "model",
): AgentTool<unknown, ToolOperationResult[]> {
	return createTool<unknown, ToolOperationResult[]>({
		name: TASK_UPDATE_TOOL_NAME,
		description:
			"Change tasks: start one (status active), finish it (status done, with a `note` saying what was done and how it was checked), cancel it (with the reason), tick acceptance items (`check`: their numbers or text), or change dependencies. " +
			"Several tasks in one call. A task cannot start while a task it depends on is open.",
		inputSchema: {
			type: "object",
			properties: {
				updates: {
					type: "array",
					items: {
						type: "object",
						properties: {
							id: { type: "string" },
							status: { type: "string", enum: STATUS_ENUM },
							note: {
								type: "string",
								description:
									"With done or cancelled: the outcome, shown on the board from then on.",
							},
							check: {
								type: "array",
								items: { type: ["integer", "string"] },
								description:
									"Acceptance items met, by number (1 = first) or text.",
							},
							uncheck: {
								type: "array",
								items: { type: ["integer", "string"] },
							},
							acceptance_add: { type: "array", items: { type: "string" } },
							depends_add: { type: "array", items: { type: "string" } },
							depends_remove: { type: "array", items: { type: "string" } },
							priority: { type: "string", enum: ["H", "M", "L"] },
							title: { type: "string" },
							later: {
								type: "boolean",
								description: "Park it (true) or bring it back (false).",
							},
						},
						required: ["id"],
					},
				},
			},
			required: ["updates"],
		},
		retryable: false,
		maxRetries: 0,
		execute: async (input, context) => {
			const outcome = store.update(input, {
				by: author(),
				...(context?.toolCallId ? { call: context.toolCallId } : {}),
			});
			return answer(TASK_UPDATE_TOOL_NAME, outcome.lines, outcome.changed);
		},
	});
}

export function createTaskViewTool(
	store: TaskGraphStore,
): AgentTool<unknown, ToolOperationResult[]> {
	return createTool<unknown, ToolOperationResult[]>({
		name: TASK_VIEW_TOOL_NAME,
		description:
			"Read the task board. view: ready (default: the board, with what can start now), show (one task in full, with `id`), graph (open tasks in dependency layers), blocked (what each blocked task waits on).",
		inputSchema: {
			type: "object",
			properties: {
				view: { type: "string", enum: ["ready", "show", "graph", "blocked"] },
				id: { type: "string" },
			},
		},
		readOnly: true,
		retryable: false,
		maxRetries: 0,
		execute: async (input) => {
			const record =
				typeof input === "object" && input !== null
					? (input as { view?: unknown; id?: unknown })
					: {};
			const id = normalizeTaskId(record.id);
			const view =
				typeof record.view === "string"
					? record.view.toLowerCase()
					: id
						? "show"
						: "ready";
			const state = store.getState();
			if (state.order.length === 0) {
				return answer(
					TASK_VIEW_TOOL_NAME,
					["No tasks yet. Write the plan with `task_plan`."],
					true,
				);
			}
			if (view === "show") {
				const task = id ? state.tasks.get(id) : undefined;
				if (!task) {
					return answer(
						TASK_VIEW_TOOL_NAME,
						[
							`${record.id ?? "(no id)"}: no such task. Tasks: ${state.order.join(", ")}.`,
						],
						false,
					);
				}
				return answer(TASK_VIEW_TOOL_NAME, [renderTask(state, task)], true);
			}
			if (view === "graph") {
				return answer(TASK_VIEW_TOOL_NAME, [renderLayers(state)], true);
			}
			if (view === "blocked") {
				const blocked = state.order
					.map((taskId) => state.tasks.get(taskId) as Task)
					.filter((task) => isBlocked(state, task));
				return answer(
					TASK_VIEW_TOOL_NAME,
					blocked.length
						? blocked.map((task) => {
								const open = openDependencies(state, task);
								return `${task.id} ${task.title}: ${
									open.length ? `after ${open.join(", ")}` : "parked (later)"
								}`;
							})
						: ["Nothing is blocked."],
					true,
				);
			}
			return answer(
				TASK_VIEW_TOOL_NAME,
				[renderBoard(state) ?? "No tasks."],
				true,
			);
		},
	});
}

export function createTaskGraphTools(
	store: TaskGraphStore,
	author?: () => string,
): AgentTool<unknown, ToolOperationResult[]>[] {
	return [
		createTaskPlanTool(store, author),
		createTaskUpdateTool(store, author),
		createTaskViewTool(store),
	];
}
