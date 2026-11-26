/**
 * Task templates (task graph phase 3): a plan worth repeating, saved as a
 * file and put on a board in one call.
 *
 * A template is JSON: `{name, description?, tasks: [...]}`, where `tasks` is
 * exactly what `task_plan` takes -- `#n` refers to the n-th task of the
 * template, `parent` makes a subtask, and `{{var}}` is filled from the
 * `vars` given when it is used. Templates live in the workspace, under
 * `.cerebriline/task-templates/` (versioned with the repository), and in
 * the user's own `~/.cerebriline/task-templates/`; the workspace's win on a
 * name.
 *
 * The model uses one with `task_plan {"template": "release"}`; the person
 * from the task panel, which also saves the current board as one.
 */

import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Task, TaskGraphState } from "./model";

export interface TaskTemplate {
	name: string;
	description?: string;
	/** `task_plan` items. */
	tasks: Record<string, unknown>[];
	/** The variables its text names, `{{like_this}}`. */
	vars: string[];
	/** The file it was read from. */
	source: string;
}

export const TASK_TEMPLATE_DIR = join(".cerebriline", "task-templates");

/** The folders templates are read from, the workspace's first. */
export function taskTemplateDirs(workspaceRoot: string | undefined): string[] {
	const dirs: string[] = [];
	if (workspaceRoot) dirs.push(join(workspaceRoot, TASK_TEMPLATE_DIR));
	dirs.push(join(homedir(), TASK_TEMPLATE_DIR));
	return dirs;
}

/** A template's name as a file name: lower case, words joined by dashes. */
export function templateSlug(name: string): string {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "template"
	);
}

function varsIn(value: unknown, into: Set<string>): void {
	if (typeof value === "string") {
		for (const match of value.matchAll(/\{\{\s*([\w-]+)\s*\}\}/g)) {
			into.add(match[1] as string);
		}
	} else if (Array.isArray(value)) {
		for (const entry of value) varsIn(entry, into);
	} else if (value && typeof value === "object") {
		for (const entry of Object.values(value)) varsIn(entry, into);
	}
}

/** One template file, or undefined when it is not one. */
export function readTaskTemplate(path: string): TaskTemplate | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as {
			name?: unknown;
			description?: unknown;
			tasks?: unknown;
		};
		if (!raw || !Array.isArray(raw.tasks) || raw.tasks.length === 0) {
			return undefined;
		}
		const tasks = raw.tasks.filter(
			(task): task is Record<string, unknown> =>
				!!task && typeof task === "object" && !Array.isArray(task),
		);
		const base = path.replace(/^.*[\\/]/, "").replace(/\.json$/i, "");
		const vars = new Set<string>();
		varsIn(tasks, vars);
		return {
			name:
				typeof raw.name === "string" && raw.name.trim()
					? raw.name.trim()
					: base,
			...(typeof raw.description === "string"
				? { description: raw.description }
				: {}),
			tasks,
			vars: [...vars],
			source: path,
		};
	} catch {
		return undefined;
	}
}

/** Every template in `dirs`; a name found twice keeps the first. */
export function loadTaskTemplates(dirs: readonly string[]): TaskTemplate[] {
	const byName = new Map<string, TaskTemplate>();
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		let files: string[] = [];
		try {
			files = readdirSync(dir).filter((file) =>
				file.toLowerCase().endsWith(".json"),
			);
		} catch {
			continue;
		}
		for (const file of files.sort()) {
			const template = readTaskTemplate(join(dir, file));
			if (template && !byName.has(template.name.toLowerCase())) {
				byName.set(template.name.toLowerCase(), template);
			}
		}
	}
	return [...byName.values()];
}

export function findTaskTemplate(
	templates: readonly TaskTemplate[],
	name: string,
): TaskTemplate | undefined {
	const wanted = name.trim().toLowerCase();
	return (
		templates.find((template) => template.name.toLowerCase() === wanted) ??
		templates.find(
			(template) => templateSlug(template.name) === templateSlug(name),
		)
	);
}

function fill(value: unknown, vars: Record<string, string>): unknown {
	if (typeof value === "string") {
		return value.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (whole, key: string) =>
			key in vars ? (vars[key] as string) : whole,
		);
	}
	if (Array.isArray(value)) return value.map((entry) => fill(entry, vars));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, fill(entry, vars)]),
		);
	}
	return value;
}

/**
 * A template's tasks, ready for `task_plan`, with its `{{vars}}` filled.
 * `offset` is how many items come before it in the same call, so its own
 * `#n` refs still point at its own tasks. Names it left unfilled are
 * returned for the result to say.
 */
export function expandTaskTemplate(
	template: TaskTemplate,
	vars: Record<string, string> = {},
	offset = 0,
): { tasks: Record<string, unknown>[]; missing: string[] } {
	const shift = (ref: unknown): unknown => {
		if (typeof ref !== "string") return ref;
		const match = /^#(\d+)$/.exec(ref.trim());
		return match ? `#${Number(match[1]) + offset}` : ref;
	};
	const tasks = template.tasks.map((task) => {
		const filled = fill(task, vars) as Record<string, unknown>;
		const out: Record<string, unknown> = { ...filled };
		if (Array.isArray(filled.depends)) out.depends = filled.depends.map(shift);
		if (filled.parent !== undefined) out.parent = shift(filled.parent);
		delete out.start;
		return out;
	});
	return { tasks, missing: template.vars.filter((name) => !(name in vars)) };
}

/**
 * A board as a template: every task in order, with its description,
 * acceptance, dependencies and parent as `#n`, and its `human:` gates (the
 * person's decisions recur; the run ids, timers and commits do not).
 * Statuses, notes and outcomes are this conversation's, and are left out.
 */
export function boardToTemplate(
	state: TaskGraphState,
	name: string,
	description?: string,
): { name: string; description?: string; tasks: Record<string, unknown>[] } {
	const tasks = state.order
		.map((id) => state.tasks.get(id) as Task)
		// A cancelled task was dropped from this plan; it is not part of the recipe.
		.filter((task) => task.status !== "cancelled");
	const position = new Map(tasks.map((task, index) => [task.id, index + 1]));
	const ref = (id: string) => {
		const at = position.get(id);
		return at ? `#${at}` : undefined;
	};
	return {
		name,
		...(description ? { description } : {}),
		tasks: tasks.map((task) => {
			const depends = task.depends
				.map(ref)
				.filter((entry): entry is string => !!entry);
			const parent = task.parent ? ref(task.parent) : undefined;
			const gates = (task.gates ?? [])
				.map((gate) => gate.spec)
				.filter((spec) => spec.startsWith("human:"));
			return {
				title: task.title,
				...(task.description ? { description: task.description } : {}),
				...(task.acceptance.length
					? { acceptance: task.acceptance.map((item) => item.text) }
					: {}),
				...(depends.length ? { depends } : {}),
				...(parent ? { parent } : {}),
				...(task.priority !== "M" ? { priority: task.priority } : {}),
				...(gates.length ? { gate: gates } : {}),
			};
		}),
	};
}

/** Write a template into a folder; returns the file. */
export function saveTaskTemplate(
	dir: string,
	template: {
		name: string;
		description?: string;
		tasks: Record<string, unknown>[];
	},
): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${templateSlug(template.name)}.json`);
	writeFileSync(path, `${JSON.stringify(template, null, "\t")}\n`);
	return path;
}
