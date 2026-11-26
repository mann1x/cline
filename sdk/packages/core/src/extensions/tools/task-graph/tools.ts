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
import { renderBoard, renderLayers, renderMermaid, renderTask } from "./board";
import { isBlocked, type Task, waitsOn } from "./model";
import { normalizeTaskId } from "./readers";
import {
	TASK_PLAN_TOOL_NAME,
	TASK_UPDATE_TOOL_NAME,
	TASK_VIEW_TOOL_NAME,
	type TaskGraphStore,
} from "./store";
import {
	expandTaskTemplate,
	findTaskTemplate,
	type TaskTemplate,
} from "./templates";

const STATUS_ENUM = ["pending", "active", "waiting", "done", "cancelled"];
const GATE_DESCRIPTION =
	'What the task waits on besides other tasks; it is blocked until each opens: "human:<what the person must decide>", "timer:+30m" or an ISO time, "commit:<sha>@<branch>", "run:<agent or run id>", "command:<id>", "gh-pr:owner/repo#12", "gh-run:owner/repo/<run id>".';
const LINK_DESCRIPTION =
	'Links: "discovered-from T3", "related T4", "caused-by T2", "supersedes T3" (cancels T3), "duplicate-of T3" (cancels this one), a URL, a commit, or a file path.';
/** An acceptance item, by number or by its text. */
const ITEM_NUMBER_OR_TEXT = {
	anyOf: [{ type: "integer" }, { type: "string" }],
};

function answer(
	query: string,
	lines: string[],
	success: boolean,
): ToolOperationResult[] {
	return [{ query, result: lines.join("\n"), success }];
}

/**
 * `task_plan`'s `template` and `vars`: offered only when the workspace or
 * the user has templates, so a session without any pays nothing for them.
 */
function templateFields(templates: readonly TaskTemplate[]): {
	properties: Record<string, unknown>;
	sentence: string;
} {
	if (templates.length === 0) return { properties: {}, sentence: "" };
	const names = templates
		.slice(0, 8)
		.map((template) =>
			template.vars.length
				? `${template.name} (${template.vars.join(", ")})`
				: template.name,
		);
	return {
		properties: {
			template: {
				type: "string",
				description:
					"Put a saved plan on the board: its tasks are added after any in `tasks`.",
			},
			vars: {
				type: "object",
				description: "Values for the template's {{names}}.",
				additionalProperties: { type: "string" },
			},
		},
		sentence: ` Saved plans (\`template\`): ${names.join("; ")}${templates.length > names.length ? `; +${templates.length - names.length} more` : ""}.`,
	};
}

/** The call's input with a named template's tasks added, or why it could not be. */
function withTemplate(
	input: unknown,
	templates: readonly TaskTemplate[],
): { input: unknown; lines: string[]; refused?: string } {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { input, lines: [] };
	}
	const record = input as Record<string, unknown>;
	const name =
		typeof record.template === "string" ? record.template.trim() : "";
	if (!name) return { input, lines: [] };
	const template = findTaskTemplate(templates, name);
	if (!template) {
		return {
			input,
			lines: [],
			refused: `No saved plan named "${name}".${
				templates.length
					? ` Saved plans: ${templates.map((entry) => entry.name).join(", ")}.`
					: " There are none in this workspace."
			}`,
		};
	}
	const own = Array.isArray(record.tasks) ? record.tasks : [];
	const vars =
		record.vars &&
		typeof record.vars === "object" &&
		!Array.isArray(record.vars)
			? Object.fromEntries(
					Object.entries(record.vars as Record<string, unknown>).map(
						([key, value]) => [key, String(value)],
					),
				)
			: {};
	const expanded = expandTaskTemplate(template, vars, own.length);
	const { template: _t, vars: _v, ...rest } = record;
	return {
		input: { ...rest, tasks: [...own, ...expanded.tasks] },
		lines: [
			`From the saved plan "${template.name}": ${expanded.tasks.length} tasks.`,
			...(expanded.missing.length
				? [
						`Not filled: ${expanded.missing.map((key) => `{{${key}}}`).join(", ")}; send them in \`vars\`, or edit the tasks.`,
					]
				: []),
		],
	};
}

/** `task_plan`'s description, with teammates on. */
export const TEAM_PLAN_SENTENCE =
	" You have teammates: after the plan, hand each task that does not depend on another to a teammate with `team_run_task` (name the task id in the message), and work on one yourself while they run. Do not do them all yourself one after another.";

export function createTaskPlanTool(
	store: TaskGraphStore,
	author: () => string = () => "model",
	templates: () => readonly TaskTemplate[] = () => [],
	options: { team?: boolean } = {},
): AgentTool<unknown, ToolOperationResult[]> {
	const offered = templates();
	// With teammates, the plan is also how work is handed out: said where the
	// plan is written, not only in the system prompt (arm D: 0 of 15 runs used
	// a teammate with the system-prompt bullet alone).
	const teamSentence =
		options.team && !store.planMode ? TEAM_PLAN_SENTENCE : "";
	const templateExtra = templateFields(offered);
	return createTool<unknown, ToolOperationResult[]>({
		name: TASK_PLAN_TOOL_NAME,
		description: store.planMode
			? "Put the plan on the board for the user to approve, in one call. " +
				"Investigate first: read and run read-only checks until you know the cause and the exact change. " +
				"One task per change: its title says what changes and where (file, function or line), its description why that removes the cause, and its acceptance how it is checked (the command and the result that shows it worked); the last task checks the whole request. " +
				'In `depends` and `parent`, "#2" means the second task of this same call, so the whole plan goes in at once; an existing task is named by its id (T3). ' +
				"Nothing is started in plan mode: the work begins in act mode, once the user agrees."
			: "Write down the work as tasks, in one call. " +
				"Plan before you change files: list every step the request needs, each with what has to be true when it is done (`acceptance`). " +
				"`depends` is only for a task that needs another one finished first; tasks that do not need each other get none. " +
				'In `depends` and `parent`, "#2" means the second task of this same call, so the whole plan goes in at once; an existing task is named by its id (T3). ' +
				"Returns the ids and the order; the first ready task is started for you." +
				teamSentence +
				templateExtra.sentence,
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
								description:
									'Only the tasks whose result this one needs: "#1" (this call) or T3. Leave it out for a task that does not need another.',
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
							gate: {
								type: "array",
								items: { type: "string" },
								description: GATE_DESCRIPTION,
							},
							link: {
								type: "array",
								items: { type: "string" },
								description: LINK_DESCRIPTION,
							},
						},
						required: ["title"],
					},
				},
				...templateExtra.properties,
			},
			...(offered.length ? {} : { required: ["tasks"] }),
		},
		retryable: false,
		maxRetries: 0,
		execute: async (input, context) => {
			const expanded = withTemplate(input, templates());
			if (expanded.refused) {
				return answer(TASK_PLAN_TOOL_NAME, [expanded.refused], false);
			}
			const outcome = store.plan(expanded.input, {
				by: author(),
				...(context?.toolCallId ? { call: context.toolCallId } : {}),
			});
			// The store starts the first ready task when nothing is active.
			return answer(
				TASK_PLAN_TOOL_NAME,
				[...expanded.lines, ...outcome.lines],
				outcome.changed,
			);
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
			"Change tasks: start one (status active), finish it (status done, with a `note` saying what was done and how it was checked; its acceptance is ticked with it unless you send `check` or `uncheck`), cancel it (with the reason), tick acceptance items (`check`: their numbers or text), or change dependencies. " +
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
							// anyOf, not `type: ["integer", "string"]`: Gemma 4's canonical
							// template renders a list type inside `items` with
							// map('upper'), which llama.cpp's jinja engine does not
							// implement -- HTTP 500 on every request to an opencoti
							// llamafile server (backup_models, mail #2357, 2026-11-21).
							check: {
								type: "array",
								items: ITEM_NUMBER_OR_TEXT,
								description:
									"Acceptance items met, by number (1 = first) or text.",
							},
							uncheck: {
								type: "array",
								items: ITEM_NUMBER_OR_TEXT,
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
							gate: {
								type: "array",
								items: { type: "string" },
								description: `${GATE_DESCRIPTION} An active task given a gate waits.`,
							},
							gate_remove: { type: "array", items: { type: "string" } },
							link: {
								type: "array",
								items: { type: "string" },
								description: LINK_DESCRIPTION,
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

export interface TaskViewHooks {
	/**
	 * Checked before the board is read: the gates only a look is worth
	 * checking (GitHub's, which go over the network). Returns lines to say.
	 */
	beforeView?: () => Promise<string[]>;
}

export function createTaskViewTool(
	store: TaskGraphStore,
	hooks: TaskViewHooks = {},
): AgentTool<unknown, ToolOperationResult[]> {
	return createTool<unknown, ToolOperationResult[]>({
		name: TASK_VIEW_TOOL_NAME,
		description:
			"Read the task board. view: ready (default: the board, with what can start now), show (one task in full, with `id`), graph (open tasks in dependency layers), blocked (what each blocked task waits on), mermaid (the board as a Mermaid flowchart).",
		inputSchema: {
			type: "object",
			properties: {
				view: {
					type: "string",
					enum: ["ready", "show", "graph", "blocked", "mermaid"],
				},
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
			const said = (await hooks.beforeView?.()) ?? [];
			const state = store.getState();
			const answer = (
				query: string,
				lines: string[],
				success: boolean,
			): ToolOperationResult[] => [
				{ query, result: [...said, ...lines].join("\n"), success },
			];
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
			if (view === "mermaid") {
				return answer(TASK_VIEW_TOOL_NAME, [renderMermaid(state)], true);
			}
			if (view === "blocked") {
				const blocked = state.order
					.map((taskId) => state.tasks.get(taskId) as Task)
					.filter((task) => isBlocked(state, task));
				return answer(
					TASK_VIEW_TOOL_NAME,
					blocked.length
						? blocked.map((task) => {
								const open = waitsOn(state, task);
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
	viewHooks?: TaskViewHooks,
	templates?: () => readonly TaskTemplate[],
	options: { team?: boolean } = {},
): AgentTool<unknown, ToolOperationResult[]>[] {
	return [
		createTaskPlanTool(store, author, templates, options),
		createTaskUpdateTool(store, author),
		createTaskViewTool(store, viewHooks),
	];
}
