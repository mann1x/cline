import * as path from "node:path";
import {
	boardPlanFromEvents,
	expandTaskTemplate,
	findTaskTemplate,
	loadTaskTemplates,
	type TaskTemplate,
	taskTemplateDirs,
} from "../task-graph";

/**
 * The Board tab's Load and Export (owner, 2026-11-27: "there's no way to load
 * a board from an export or saved in memory").
 *
 * - **Load** adds tasks to the board shown: the open conversation's (as the
 *   person's change, which the model is told), or the draft for the next
 *   one. From a board saved in Memory, a saved plan (template), or a file:
 *   an exported board or a template. They come in as a fresh plan, as a
 *   template does: titles, descriptions, acceptance, order (dependencies and
 *   steps), priority, and the gates that recur (`human:`, `use-pipeline:`).
 * - **Export** writes the board shown to a JSON file: its events, which
 *   replay it exactly, and the same tasks as a plan, which any board loads.
 */

export const BOARD_FILE_FORMAT = "cerebriline-board";

export interface BoardFile {
	format: typeof BOARD_FILE_FORMAT;
	version: 1;
	title?: string;
	exportedAt: string;
	events: unknown[];
	tasks: Record<string, unknown>[];
}

export interface SavedBoardEntry {
	id: string;
	memory: string;
	title?: string;
	tasks: number;
	open: number;
	savedAt: string;
}

export interface BoardIoDeps {
	workspaceRoot: () => string | undefined;
	/** The board shown is the draft for the next new conversation. */
	isDraft: () => boolean;
	/** The board shown, as events; undefined when it cannot be read now. */
	events: () => unknown[] | undefined;
	/** Whether the board shown has tasks (the draft asks Add or Replace). */
	hasTasks: () => boolean;
	/** Add tasks to the board shown, as the person's. */
	plan: (tasks: Record<string, unknown>[]) => { ok: boolean; lines: string[] };
	/** Empty the draft (Replace). */
	clearDraft: () => void;
	savedBoards: () => SavedBoardEntry[];
	savedBoardEvents: (id: string, memory: string) => unknown[] | undefined;
	/** How the person is asked: the host's pickers and dialogs, or a test's. */
	ui: BoardIoUi;
}

/** One choice in a picker: what VS Code's quick pick and most list pickers show. */
export interface BoardPickItem {
	label: string;
	description?: string;
	detail?: string;
}

/** The person's answers: the host's pickers and dialogs (VS Code's, a web page's), or a test's. */
export interface BoardIoUi {
	pick<T extends BoardPickItem>(
		items: T[],
		placeholder: string,
	): Promise<T | undefined>;
	input(prompt: string, placeholder?: string): Promise<string | undefined>;
	confirm(question: string, ...buttons: string[]): Promise<string | undefined>;
	openFile(defaultDir?: string): Promise<string | undefined>;
	/** Default: a board file (`.json`), saved with an Export button. */
	saveFile(
		defaultPath: string,
		options?: { filters?: Record<string, string[]>; label?: string },
	): Promise<string | undefined>;
	readFile(file: string): Promise<string>;
	writeFile(file: string, text: string): Promise<void>;
}

type Outcome = { ok: boolean; lines?: string[]; errors?: string[] };

/**
 * The tasks a file holds: an exported board (its events, or failing that
 * its tasks), a template (`tasks`), or a bare list of events.
 */
export function tasksFromBoardFile(
	text: string,
): { tasks: Record<string, unknown>[] } | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { error: `It is not JSON: ${(error as Error).message}` };
	}
	const events = Array.isArray(parsed)
		? parsed
		: parsed &&
				typeof parsed === "object" &&
				Array.isArray((parsed as { events?: unknown }).events)
			? (parsed as { events: unknown[] }).events
			: undefined;
	if (events) {
		const tasks = boardPlanFromEvents(events);
		if (tasks.length > 0) return { tasks };
	}
	const listed =
		parsed && typeof parsed === "object"
			? (parsed as { tasks?: unknown }).tasks
			: undefined;
	if (Array.isArray(listed)) {
		const tasks = listed.filter(
			(task): task is Record<string, unknown> =>
				!!task &&
				typeof task === "object" &&
				typeof (task as { title?: unknown }).title === "string",
		);
		if (tasks.length > 0) return { tasks };
	}
	return {
		error:
			"It holds no tasks: load a board exported from the Board tab, or a saved plan (a template).",
	};
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** Load: pick where from, then add its tasks to the board shown. */
export async function loadBoard(deps: BoardIoDeps): Promise<Outcome> {
	const ui = deps.ui;
	const root = deps.workspaceRoot();
	const saved = deps.savedBoards();
	const templates = loadTaskTemplates(taskTemplateDirs(root));
	type Source = BoardPickItem & { source: "memory" | "template" | "file" };
	const sources: Source[] = [
		...(saved.length > 0
			? [
					{
						label: "A board saved in Memory",
						description: plural(saved.length, "board"),
						source: "memory" as const,
					},
				]
			: []),
		...(templates.length > 0
			? [
					{
						label: "A saved plan",
						description: plural(templates.length, "plan"),
						source: "template" as const,
					},
				]
			: []),
		{
			label: "A file…",
			description: "a board exported from here, or a plan (.json)",
			source: "file",
		},
	];
	const target = deps.isDraft()
		? "the draft board"
		: "this conversation's board";
	const source =
		sources.length === 1
			? sources[0]
			: await ui.pick(sources, `Load tasks onto ${target} from…`);
	if (!source) return { ok: false };

	let tasks: Record<string, unknown>[] | undefined;
	let from = "";
	if (source.source === "memory") {
		type Entry = BoardPickItem & { entry: SavedBoardEntry };
		const picked = await ui.pick<Entry>(
			saved.map((entry) => ({
				label: entry.title || entry.id,
				description: `${plural(entry.tasks, "task")}, ${entry.open} open`,
				detail: `${entry.id} in "${entry.memory}", saved ${entry.savedAt.slice(0, 10)}`,
				entry,
			})),
			"The saved board to load",
		);
		if (!picked) return { ok: false };
		const events = deps.savedBoardEvents(picked.entry.id, picked.entry.memory);
		if (!events)
			return {
				ok: false,
				errors: [
					`${picked.entry.id} is no longer in "${picked.entry.memory}".`,
				],
			};
		tasks = boardPlanFromEvents(events);
		from = `the saved board ${picked.entry.title ? `"${picked.entry.title}"` : picked.entry.id}`;
	} else if (source.source === "template") {
		type Entry = BoardPickItem & { template: TaskTemplate };
		const picked = await ui.pick<Entry>(
			templates.map((template) => ({
				label: template.name,
				description: plural(template.tasks.length, "task"),
				...(template.description ? { detail: template.description } : {}),
				template,
			})),
			"The saved plan to load",
		);
		if (!picked) return { ok: false };
		const template =
			findTaskTemplate(templates, picked.template.name) ?? picked.template;
		const vars: Record<string, string> = {};
		for (const name of template.vars) {
			const value = await ui.input(
				`"${template.name}" asks for {{${name}}}`,
				name,
			);
			if (value === undefined) return { ok: false };
			vars[name] = value;
		}
		tasks = expandTaskTemplate(template, vars).tasks;
		from = `the saved plan "${template.name}"`;
	} else {
		const file = await ui.openFile(root);
		if (!file) return { ok: false };
		const read = tasksFromBoardFile(await ui.readFile(file));
		if ("error" in read)
			return { ok: false, errors: [`${path.basename(file)}: ${read.error}`] };
		tasks = read.tasks;
		from = path.basename(file);
	}
	if (!tasks || tasks.length === 0)
		return { ok: false, errors: [`${from} has no tasks to load.`] };

	if (deps.isDraft() && deps.hasTasks()) {
		const choice = await ui.confirm(
			`The draft board already has tasks. Add the ${plural(tasks.length, "task")} from ${from} after them, or replace them?`,
			"Add",
			"Replace",
		);
		if (!choice) return { ok: false };
		if (choice === "Replace") deps.clearDraft();
	}
	const outcome = deps.plan(tasks);
	return outcome.ok
		? {
				ok: true,
				lines: [
					`Loaded ${plural(tasks.length, "task")} from ${from}.`,
					...outcome.lines,
				],
			}
		: { ok: false, errors: outcome.lines };
}

/** Export: the board shown, to a JSON file the person picks. */
export async function exportBoard(
	deps: BoardIoDeps,
	title?: string,
): Promise<Outcome> {
	const ui = deps.ui;
	const events = deps.events();
	if (!events) {
		return {
			ok: false,
			errors: [
				"The board can be exported while its conversation is running or waiting for you.",
			],
		};
	}
	const tasks = boardPlanFromEvents(events);
	if (tasks.length === 0)
		return { ok: false, errors: ["The board has no tasks to export."] };
	const day = new Date().toISOString().slice(0, 10);
	const root = deps.workspaceRoot();
	const name = `board-${day}.json`;
	const file = await ui.saveFile(root ? path.join(root, name) : name);
	if (!file) return { ok: false };
	const body: BoardFile = {
		format: BOARD_FILE_FORMAT,
		version: 1,
		...(title ? { title } : {}),
		exportedAt: new Date().toISOString(),
		events,
		tasks,
	};
	await ui.writeFile(file, `${JSON.stringify(body, null, "\t")}\n`);
	return {
		ok: true,
		lines: [`Exported ${plural(tasks.length, "task")} to ${file}.`],
	};
}
