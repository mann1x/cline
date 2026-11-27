/**
 * The Board tab's other half: everything it asks of its host, answered from
 * the workspace and the boards, with the person asked through `ui`.
 *
 * The tab (`@cline/ui`'s board viewer, or any UI speaking the same messages)
 * sends a `ViewerRequest` and draws the `ViewerData` it is sent. This answers
 * the requests and collects the data. What it cannot do itself it is handed:
 * the boards (`BoardSlots`: this conversation's, the drafts, the recent ones,
 * the saved ones), the run actions of the conversation that started a run,
 * the step form's catalog, and the host's own pickers, dialogs and files.
 * The VS Code extension's Board tab is this behind a webview; another host
 * puts it behind its own transport (a WebSocket, Electron's IPC).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	approvePipeline,
	boardToPipeline,
	findPipeline,
	listPipelines,
	type PipelineDefinition,
	pipelineSlug,
	pipelineToTemplate,
	rejectPipeline,
	savePipeline,
	validatePipeline,
} from "../pipelines";
import {
	BOARD_VIEWER_REPLY,
	type ViewerBoardEntry,
	type ViewerBoardTask,
	type ViewerCatalog,
	type ViewerData,
	type ViewerFocus,
	type ViewerReplyMessage,
	type ViewerRequest,
	type ViewerRunOp,
} from "../protocol";
import {
	saveTaskTemplate,
	TASK_TEMPLATE_DIR,
	templateSlug,
} from "../task-graph";
import { collectViewerData } from "./collect";
import { type BoardIoUi, exportBoard, loadBoard } from "./io";
import type { BoardSlots } from "./slots";

/** How the backend asks the person and reaches the host's files and editor. */
export interface BoardHostUi extends BoardIoUi {
	/**
	 * A text answer. `validate` returns why a value cannot be used, for a host
	 * that checks as the person types; the backend checks the answer again.
	 */
	ask(options: {
		title?: string;
		prompt: string;
		value?: string;
		validate?: (value: string) => string | undefined;
	}): Promise<string | undefined>;
	/** A notice the person reads; nothing is waited on. */
	info(message: string): void;
	/** A failure the person reads. */
	error(message: string): void;
	/** Show a file in the host's editor (a pipeline file, a run's journal). */
	showFile?(path: string): void;
	/** The workspace-relative form of a path, for a notice. Default: the path. */
	relative?(path: string): string;
}

export interface BoardBackendOptions {
	/** The workspace whose `.cerebriline/` is read. */
	workspaceRoot: () => string | undefined;
	/** Every board the tab lists and changes. Without it the tab shows pipelines only. */
	boards?: BoardSlots;
	/** What the step form completes from: the tools, the agents, the functions. */
	catalog?: () => ViewerCatalog;
	/** The person's action on a run, through the conversation that started it. */
	runAction?: (action: { op: ViewerRunOp; run: string; node?: string }) => {
		ok: boolean;
		lines: string[];
		run?: string;
	};
	ui: BoardHostUi;
	/** A part of the data failed to read; the tab is drawn without it. */
	onError?: (message: string, error: unknown) => void;
}

/** What answering a request gave: the reply to send, and what to show next. */
export interface BoardAnswer {
	/** For a request that carried an `id`; undefined for one that waits on nothing. */
	reply?: ViewerReplyMessage;
	/** The tab's data changed: send it again. */
	refresh: boolean;
	/** The tab said it is ready for data. */
	ready?: boolean;
}

export interface BoardBackend {
	/**
	 * The tab's data. `cachedOnly` lists the recent conversations as last
	 * read, without reading the history, so the tab draws at once; send it
	 * again with `cachedOnly: false` when `recentIsFresh()` is false.
	 */
	data(options?: {
		focus?: ViewerFocus;
		cachedOnly?: boolean;
	}): Promise<ViewerData>;
	/** Whether the recent conversations listed last are still current. */
	recentIsFresh(): boolean;
	/** One message from the tab. */
	handle(message: unknown): Promise<BoardAnswer>;
}

type Outcome = {
	ok: boolean;
	errors?: string[];
	lines?: string[];
	run?: string;
	pipeline?: string;
};

/** The confirm for each run action: its button, and what it does. */
const RUN_OPS: Record<
	ViewerRunOp,
	{ label: string; question: (run: string, node: string) => string }
> = {
	retry: {
		label: "Retry",
		question: (run, node) =>
			`Retry ${node}? ${run} resumes: ${node} runs again, then what comes after it.`,
	},
	skip: {
		label: "Skip",
		question: (run, node) =>
			`Skip ${node}? It counts as done without running again, its input goes on to the nodes after it, and ${run} resumes.`,
	},
	rerun: {
		label: "Re-run",
		question: (run, node) =>
			`Re-run ${run} from ${node}? A new run starts: it reuses what came before ${node} and runs ${node} and everything after it again.`,
	},
	stop: {
		label: "Stop",
		question: (run) => `Stop ${run}? The nodes running now are stopped.`,
	},
};

export function createBoardBackend(options: BoardBackendOptions): BoardBackend {
	const { ui } = options;
	let focusNext: ViewerFocus | undefined;

	const data = async (
		request: { focus?: ViewerFocus; cachedOnly?: boolean } = {},
	): Promise<ViewerData> => {
		const workspace = options.workspaceRoot();
		const focus = request.focus ?? focusNext;
		focusNext = undefined;
		const boards = options.boards;
		let entries: ViewerBoardEntry[] | undefined;
		try {
			entries = boards
				? await boards.list({ cachedOnly: request.cachedOnly === true })
				: undefined;
		} catch {
			entries = undefined;
		}
		try {
			const home = boards?.home();
			return workspace
				? collectViewerData({
						workspace,
						...(home ? { boardText: boards?.text(home) } : {}),
						...(home && home !== "live" ? { boardDraft: true } : {}),
						...(entries ? { boards: entries } : {}),
						...(boards?.turnRunning() ? { turnRunning: true } : {}),
						...(options.catalog ? { catalog: options.catalog() } : {}),
						...(focus ? { focus } : {}),
					})
				: {
						workspace: "",
						pipelines: [],
						runs: [],
						...(focus ? { focus } : {}),
					};
		} catch (error) {
			// The tab must leave "Reading the workspace…" even when a part fails.
			options.onError?.(
				"[board-viewer] collecting the tab's data failed",
				error,
			);
			return {
				workspace: workspace ?? "",
				pipelines: [],
				runs: [],
				...(focus ? { focus } : {}),
			};
		}
	};

	/** Delete a task for good, with its steps, after asking: only the person deletes. */
	const deleteTask = async (
		task: unknown,
		board: unknown,
	): Promise<Outcome> => {
		const boards = options.boards;
		if (!boards)
			return { ok: false, errors: ["This editor cannot change the board."] };
		if (typeof task !== "string" || !task)
			return { ok: false, errors: ["Pick a task first."] };
		const key = boards.resolve(board);
		const refused = boards.readOnly(key);
		if (refused) return { ok: false, errors: [refused] };
		const tasks = boardTasks(boards.text(key));
		const found = tasks.find((entry) => entry.id === task);
		const steps = tasks.filter((entry) =>
			entry.id.startsWith(`${task}.`),
		).length;
		const name = found ? `${task} "${found.title}"` : task;
		const answer = await ui.confirm(
			`Delete ${name}${steps ? ` and its ${steps} step${steps === 1 ? "" : "s"}` : ""}? It is gone from the board for good, and the tasks after it stop waiting on it.`,
			"Delete",
		);
		if (answer !== "Delete") return { ok: false };
		const outcome = boards.edit(key, { op: "remove", ids: [task] });
		return outcome.ok
			? { ok: true, lines: outcome.lines }
			: { ok: false, errors: outcome.lines };
	};

	/** Retry, Skip, Re-run from a node, or Stop: confirmed first, decided by the run's conversation. */
	const runAction = async (
		op: ViewerRunOp,
		run: string,
		node: string | undefined,
	): Promise<Outcome> => {
		if (!options.runAction)
			return { ok: false, errors: ["This editor cannot act on runs."] };
		if (!RUN_OPS[op] || typeof run !== "string")
			return { ok: false, errors: ["Not a run action."] };
		if (op !== "stop" && typeof node !== "string") {
			return { ok: false, errors: ["Pick a node of the run first."] };
		}
		const { label, question } = RUN_OPS[op];
		const answer = await ui.confirm(question(run, node ?? ""), label);
		if (answer !== label) return { ok: false };
		const outcome = options.runAction({
			op,
			run,
			...(node !== undefined ? { node } : {}),
		});
		return outcome.ok
			? {
					ok: true,
					lines: outcome.lines,
					...(outcome.run ? { run: outcome.run } : {}),
				}
			: { ok: false, errors: outcome.lines };
	};

	/**
	 * A new pipeline: empty, or a copy of a saved one to start from. A copy
	 * keeps its source's approval, so copying never approves anything.
	 */
	const newPipeline = async (root: string): Promise<Outcome> => {
		const sources = listPipelines(root).filter((file) => file.definition);
		type Start = {
			label: string;
			description?: string;
			detail?: string;
			source?: (typeof sources)[number];
		};
		const picked: Start | undefined =
			sources.length === 0
				? { label: "Empty" }
				: await ui.pick<Start>(
						[
							{ label: "Empty", description: "add its steps in the Board tab" },
							...sources.map((file) => {
								const steps = file.definition?.nodes.length ?? 0;
								return {
									label: `A copy of ${file.name}`,
									description: `${steps} step${steps === 1 ? "" : "s"}, ${file.isApproved ? "approved" : "not approved"}`,
									...(file.definition?.description
										? { detail: file.definition.description }
										: {}),
									source: file,
								};
							}),
						],
						"Start from…",
					);
		if (!picked) return { ok: false };
		const source = picked.source;
		const validate = (value: string) =>
			!value.trim()
				? "Give it a name."
				: findPipeline(root, value)
					? `There is a pipeline "${value.trim()}" already.`
					: undefined;
		const name = (
			await ui.ask({
				title: source ? `New pipeline from ${source.name}` : "New pipeline",
				prompt: source
					? `Its name. ${source.name}'s steps are copied to it in .cerebriline/pipelines; ${source.name} is not changed.`
					: "Its name. It is saved to .cerebriline/pipelines; add its steps in the Board tab.",
				...(source ? { value: `${source.name} copy` } : {}),
				validate,
			})
		)?.trim();
		if (!name) return { ok: false };
		const invalid = validate(name);
		if (invalid) return { ok: false, errors: [invalid] };
		const definition = source?.definition
			? ({ ...source.definition, name } as PipelineDefinition)
			: ({
					name,
					nodes: [{ id: "start", type: "set", fields: {} }],
				} as PipelineDefinition);
		const saved = savePipeline(root, definition, undefined, {
			by: "person",
			...(source && !source.isApproved ? { approve: false } : {}),
		});
		if (!saved.ok) return { ok: false, errors: saved.errors };
		return {
			ok: true,
			lines: [
				source
					? `Saved ${name}, a copy of ${source.name}${source.isApproved ? "" : ", for you to approve"}.`
					: `Saved ${name}. Add its steps from the palette, then Save.`,
			],
			pipeline: pipelineSlug(name),
		};
	};

	/** The person's edit: saved and approved, as their own edits are. */
	const save = (
		root: string,
		slug: string,
		base: string,
		definition: unknown,
	): Outcome => {
		const checked = validatePipeline(definition);
		if (!checked.ok || !checked.pipeline)
			return { ok: false, errors: checked.errors };
		if (pipelineSlug(checked.pipeline.name) !== slug) {
			return {
				ok: false,
				errors: [
					`The name gives the file its name: "${checked.pipeline.name}" would be a new file, not this one. Keep the name, or rename the file.`,
				],
			};
		}
		const saved = savePipeline(root, checked.pipeline, base, { by: "person" });
		return saved.ok ? { ok: true } : { ok: false, errors: saved.errors };
	};

	const approve = async (
		root: string,
		slug: string,
		hash: string,
	): Promise<Outcome> => {
		const file = findPipeline(root, slug);
		if (!file) return { ok: false, errors: [`No pipeline ${slug} any more.`] };
		if (file.hash !== hash) {
			return {
				ok: false,
				errors: [
					`The file changed to version ${file.hash} while you looked: read it again first.`,
				],
			};
		}
		if (!file.valid) return { ok: false, errors: file.errors };
		const answer = await ui.confirm(
			`Approve ${file.name} (version ${file.hash})? It can then run its commands and tools in the background.`,
			"Approve",
		);
		if (answer !== "Approve") return { ok: false };
		approvePipeline(root, slug);
		return { ok: true };
	};

	const reject = async (
		root: string,
		slug: string,
		hash: string,
	): Promise<Outcome> => {
		const file = findPipeline(root, slug);
		if (!file) return { ok: false, errors: [`No pipeline ${slug} any more.`] };
		if (file.hash !== hash) {
			return {
				ok: false,
				errors: [
					`The file changed to version ${file.hash} while you looked: read it again first.`,
				],
			};
		}
		const answer = await ui.confirm(
			`Reject version ${file.hash} of ${file.name}? The file goes back to the approved version ${file.approved?.hash ?? ""}.`,
			"Reject",
		);
		if (answer !== "Reject") return { ok: false };
		rejectPipeline(root, slug);
		return { ok: true };
	};

	/** The board as a new pipeline file: a proposal the person reads and approves. */
	const fromBoard = async (
		root: string,
		tasks: ViewerBoardTask[],
	): Promise<Outcome> => {
		if (!Array.isArray(tasks) || tasks.length === 0)
			return { ok: false, errors: ["The board has no tasks."] };
		const validate = (value: string) =>
			!value.trim()
				? "Give it a name."
				: findPipeline(root, value)
					? `${pipelineSlug(value)}.pipeline.json exists: choose another name.`
					: undefined;
		const name = (
			await ui.ask({
				title: "Save the board as a pipeline",
				prompt:
					"The pipeline's name. It is saved to .cerebriline/pipelines for you to read and approve.",
				validate,
			})
		)?.trim();
		if (!name) return { ok: false };
		const invalid = validate(name);
		if (invalid) return { ok: false, errors: [invalid] };
		const { definition, notes } = boardToPipeline(tasks, name);
		const saved = savePipeline(root, definition, undefined, {
			by: "person",
			approve: false,
		});
		if (!saved.ok) return { ok: false, errors: saved.errors };
		focusNext = { pipeline: saved.file.slug };
		ui.info(
			[
				`Saved ${saved.file.name} with ${definition.nodes.length} nodes. Read it and approve it before it runs.`,
				...notes,
			].join(" "),
		);
		return { ok: true };
	};

	/** A pipeline as a task plan (template) in the workspace, for work the model should do rather than run. */
	const toTemplate = async (root: string, slug: string): Promise<Outcome> => {
		const file = findPipeline(root, slug);
		if (!file?.definition) {
			return {
				ok: false,
				errors: [
					file ? "It does not validate." : `No pipeline ${slug} any more.`,
				],
			};
		}
		const definition = file.definition as PipelineDefinition;
		// A plan with no tasks is refused, not saved empty.
		if (pipelineToTemplate(definition).tasks.length === 0) {
			const kinds = [...new Set(definition.nodes.map((node) => node.type))];
			return {
				ok: false,
				errors: [
					`${file.name} has only ${kinds.join(" and ")} steps, and none of them becomes a task: a task plan takes the steps that do work (agent, command, tool, http, loop, swarm, pipeline), and a check becomes acceptance on the task before it. Run ${file.name} instead, or start a new pipeline from it with + New.`,
				],
			};
		}
		const name = (
			await ui.ask({
				title: "Make a task plan from the pipeline",
				prompt:
					'The plan\'s name. Its steps become tasks: load it onto a board with Load… → A saved plan, or the model starts from it with task_plan {"template": name}.',
				value: file.name,
				validate: (value) => (value.trim() ? undefined : "Give it a name."),
			})
		)?.trim();
		if (!name) return { ok: false };
		const dir = join(root, TASK_TEMPLATE_DIR);
		if (existsSync(join(dir, `${templateSlug(name)}.json`))) {
			const answer = await ui.confirm(
				`A task plan named ${name} exists. Replace it?`,
				"Replace",
			);
			if (answer !== "Replace") return { ok: false };
		}
		const template = pipelineToTemplate(definition, name);
		const path = saveTaskTemplate(dir, template);
		ui.info(
			`Saved ${template.tasks.length} task${template.tasks.length === 1 ? "" : "s"} as the plan ${name} in ${ui.relative ? ui.relative(path) : path}. Load it onto a board with Load… → A saved plan.`,
		);
		return { ok: true };
	};

	const saveReport = async (request: {
		name?: unknown;
		text?: unknown;
	}): Promise<void> => {
		if (typeof request.text !== "string") return;
		const name =
			typeof request.name === "string" && request.name
				? request.name
				: "pipeline-run";
		const root = options.workspaceRoot();
		const target = await ui.saveFile(
			root ? join(root, `${name}-report.md`) : `${name}-report.md`,
			{
				filters: { Markdown: ["md"] },
				label: "Save report",
			},
		);
		if (!target) return;
		try {
			await ui.writeFile(target, request.text);
			ui.info(
				`Saved the report to ${ui.relative ? ui.relative(target) : target}.`,
			);
		} catch (error) {
			ui.error(
				`Could not save the report: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

	/** A request the tab waits on: what it changed, or why it did not. */
	const answer = async (
		request: ViewerRequest & { id: number },
	): Promise<Outcome> => {
		const root = options.workspaceRoot();
		switch (request.type) {
			case "boardViewer/validate": {
				const checked = validatePipeline(request.definition);
				return { ok: checked.ok, errors: checked.errors };
			}
			case "boardViewer/runAction":
				return runAction(request.op, request.run, request.node);
		}
		const boards = options.boards;
		switch (request.type) {
			case "boardViewer/editTask": {
				if (!boards)
					return {
						ok: false,
						errors: ["This editor cannot change the board."],
					};
				if (!Array.isArray(request.updates))
					return { ok: false, errors: ["Not a board change."] };
				const outcome = boards.edit(boards.resolve(request.board), {
					op: "update",
					updates: request.updates,
				});
				return outcome.ok
					? { ok: true, lines: outcome.lines }
					: { ok: false, lines: outcome.lines, errors: outcome.lines };
			}
			case "boardViewer/addTask": {
				if (!boards)
					return {
						ok: false,
						errors: ["This editor cannot change the board."],
					};
				const title =
					typeof request.title === "string" ? request.title.trim() : "";
				if (!title) return { ok: false, errors: ["Give the task a title."] };
				const parent =
					typeof request.parent === "string" && request.parent
						? request.parent
						: undefined;
				const outcome = boards.edit(boards.resolve(request.board), {
					op: "plan",
					tasks: [{ title, ...(parent ? { parent } : {}) }],
				});
				return outcome.ok
					? { ok: true, lines: outcome.lines }
					: { ok: false, errors: outcome.lines };
			}
			case "boardViewer/deleteTask":
				return deleteTask(request.task, request.board);
			case "boardViewer/loadBoard": {
				if (!boards)
					return { ok: false, errors: ["This editor cannot load a board."] };
				const key = boards.resolve(request.board);
				const refused = boards.readOnly(key);
				if (refused) return { ok: false, errors: [refused] };
				return loadBoard(
					boards.io(key, { workspaceRoot: options.workspaceRoot, ui }),
				);
			}
			case "boardViewer/exportBoard":
				if (!boards)
					return {
						ok: false,
						errors: ["This editor cannot export the board."],
					};
				return exportBoard(
					boards.io(boards.resolve(request.board), {
						workspaceRoot: options.workspaceRoot,
						ui,
					}),
				);
			case "boardViewer/startFromDraft": {
				if (!boards)
					return { ok: false, errors: ["This editor has no draft board."] };
				const outcome = boards.start(boards.resolve(request.board));
				return outcome.ok
					? { ok: true, lines: outcome.lines }
					: { ok: false, errors: outcome.lines };
			}
			case "boardViewer/discardDraft": {
				if (!boards)
					return { ok: false, errors: ["This editor has no draft board."] };
				const key = boards.resolve(request.board);
				const confirmed = await ui.confirm(
					"Discard this draft? Its tasks are gone for good.",
					"Discard",
				);
				if (confirmed !== "Discard") return { ok: false };
				const outcome = boards.clear(key);
				return outcome.ok
					? { ok: true, lines: outcome.lines }
					: { ok: false, errors: outcome.lines };
			}
			case "boardViewer/copyBoard": {
				if (!boards)
					return { ok: false, errors: ["This editor cannot copy boards."] };
				if (
					typeof request.from !== "string" ||
					typeof request.to !== "string"
				) {
					return {
						ok: false,
						errors: ["Pick the boards to copy from and to."],
					};
				}
				return boards.copy(request.from, request.to, (question, ...buttons) =>
					ui.confirm(question, ...buttons),
				);
			}
			case "boardViewer/saveBoardToMemory": {
				if (!boards)
					return { ok: false, errors: ["This editor cannot save boards."] };
				const outcome = await boards.save(boards.resolve(request.board));
				return outcome.ok
					? { ok: true, lines: outcome.lines }
					: { ok: false, errors: outcome.lines };
			}
			case "boardViewer/deleteSavedBoard": {
				if (!boards)
					return { ok: false, errors: ["This editor cannot delete boards."] };
				const confirmed = await ui.confirm(
					"Delete this board from Memory? It is gone for good; conversations that started from it keep their own boards.",
					"Delete",
				);
				if (confirmed !== "Delete") return { ok: false };
				const outcome = await boards.deleteSaved(boards.resolve(request.board));
				return outcome.ok
					? { ok: true, lines: outcome.lines }
					: { ok: false, errors: outcome.lines };
			}
		}
		if (!root)
			return {
				ok: false,
				errors: ["Open a folder first: pipelines live in the workspace."],
			};
		switch (request.type) {
			case "boardViewer/save":
				return save(root, request.slug, request.base, request.definition);
			case "boardViewer/approve":
				return approve(root, request.slug, request.hash);
			case "boardViewer/reject":
				return reject(root, request.slug, request.hash);
			case "boardViewer/boardToPipeline":
				return fromBoard(root, request.tasks);
			case "boardViewer/toTemplate":
				return toTemplate(root, request.slug);
			case "boardViewer/newPipeline":
				return newPipeline(root);
			default:
				return { ok: false, errors: ["Not a request this panel knows."] };
		}
	};

	return {
		data,
		recentIsFresh: () => options.boards?.recentIsFresh() ?? true,
		handle: async (message) => {
			const request = message as Partial<ViewerRequest> | undefined;
			switch (request?.type) {
				case "boardViewer/ready":
					return { refresh: true, ready: true };
				case "boardViewer/openFile": {
					const path = (request as { path?: unknown }).path;
					if (typeof path === "string") ui.showFile?.(path);
					return { refresh: false };
				}
				case "boardViewer/saveReport":
					await saveReport(request as { name?: unknown; text?: unknown });
					return { refresh: false };
			}
			const id = (request as { id?: unknown } | undefined)?.id;
			if (typeof id !== "number") return { refresh: false };
			const outcome = await answer(
				request as ViewerRequest & { id: number },
			).catch(
				(error: unknown): Outcome => ({
					ok: false,
					errors: [error instanceof Error ? error.message : String(error)],
				}),
			);
			return {
				reply: { type: BOARD_VIEWER_REPLY, id, ...outcome },
				refresh: outcome.ok,
			};
		},
	};
}

/** A board's tasks, as their ids and titles. */
function boardTasks(text: string | undefined): { id: string; title: string }[] {
	try {
		const parsed = text
			? (JSON.parse(text) as { tasks?: { id?: unknown; title?: unknown }[] })
			: undefined;
		return (parsed?.tasks ?? [])
			.filter((entry) => typeof entry.id === "string")
			.map((entry) => ({
				id: entry.id as string,
				title: String(entry.title ?? ""),
			}));
	} catch {
		return [];
	}
}
