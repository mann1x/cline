import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AttachedTaskBoard } from "../attach";
import { type TaskGraphSeed, TaskGraphStore } from "../task-graph";
import type { DraftStorage } from "./draft";
import type { SavedBoardEntry } from "./io";
import { BoardSlots, type RecentBoard } from "./slots";

/**
 * Every board the Board tab lists, for an application whose conversations
 * each run with `attachTaskBoard`: what the VS Code extension wires by hand
 * from its own controller, with files for the rest.
 *
 * - The open conversation's board is the attached one: the person's changes
 *   go through its control, so the model is told.
 * - Drafts and saved boards are JSON files under `storeDir`
 *   (`<workspace>/.cerebriline/boards` by default): `drafts/<slot>.json` and
 *   `saved/<id>.json`. Without a workspace, drafts live in memory and nothing
 *   can be saved.
 * - Recent conversations are the logs in `logDir`, the `logPath` each
 *   conversation's `attachTaskBoard` was given, named `<id>.tasks.jsonl`.
 *
 * Board keys come from the tab, so every id that names a file is checked
 * before it does.
 */

export const SESSION_BOARD_LOG_SUFFIX = ".tasks.jsonl";

export interface SessionBoardSlotsOptions {
	workspaceRoot: () => string | undefined;
	/** The conversation on screen and its board; `running` while its model is in a turn. */
	conversation: () =>
		| { board: AttachedTaskBoard; title?: string; running?: boolean }
		| undefined;
	/** The folder of the conversations' board logs, `<id>.tasks.jsonl`: the tab's recent conversations. */
	logDir?: () => string | undefined;
	/** Where drafts and saved boards are kept. Default: `<workspace>/.cerebriline/boards`. */
	storeDir?: () => string | undefined;
	/**
	 * The person starts the next conversation from a draft: give `seed` to
	 * that conversation's `attachTaskBoard`, then call `onTaken`, which
	 * clears the draft.
	 */
	startConversation: (seed: TaskGraphSeed, onTaken: () => void) => void;
	/** What the tab calls the saved boards' store. Default: `boards`. */
	savedName?: string;
}

/** An id that is safe as one file name: no separators, no `..`. */
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const safeId = (id: string) => SAFE_ID.test(id) && !id.includes("..");

interface SavedBoardFile {
	title?: string;
	savedAt: string;
	events: unknown[];
}

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function counts(events: readonly unknown[]): { tasks: number; open: number } {
	const snapshot = TaskGraphStore.snapshotOf(events);
	const tasks = snapshot?.tasks ?? [];
	return {
		tasks: tasks.length,
		open: tasks.filter(
			(task) => task.status !== "done" && task.status !== "cancelled",
		).length,
	};
}

const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? "" : "s"}`;

export function sessionBoardSlots(
	options: SessionBoardSlotsOptions,
): BoardSlots {
	const savedName = options.savedName ?? "boards";
	const storeDir = (): string | undefined => {
		if (options.storeDir) return options.storeDir();
		const root = options.workspaceRoot();
		return root ? join(root, ".cerebriline", "boards") : undefined;
	};
	const folder = (name: string): string | undefined => {
		const store = storeDir();
		return store ? join(store, name) : undefined;
	};
	const memoryDrafts = new Map<number, unknown[] | undefined>();

	const draftStorage = (slot: number): DraftStorage => ({
		get: () => {
			const dir = folder("drafts");
			if (!dir) return memoryDrafts.get(slot);
			const events = readJson<unknown>(join(dir, `${slot}.json`));
			return Array.isArray(events) ? events : undefined;
		},
		set: (events) => {
			const dir = folder("drafts");
			if (!dir) {
				memoryDrafts.set(slot, events);
				return;
			}
			const file = join(dir, `${slot}.json`);
			if (!events || events.length === 0) {
				rmSync(file, { force: true });
				return;
			}
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, `${JSON.stringify(events)}\n`);
		},
	});

	const logOf = (id: string): string | undefined => {
		const dir = options.logDir?.();
		return dir && safeId(id)
			? join(dir, `${id}${SESSION_BOARD_LOG_SUFFIX}`)
			: undefined;
	};

	const save = (
		events: unknown[],
		title: string | undefined,
	): { ok: boolean; lines: string[] } => {
		const dir = folder("saved");
		if (!dir) {
			return {
				ok: false,
				lines: ["Open a workspace to save boards: they are kept in it."],
			};
		}
		const { tasks } = counts(events);
		if (tasks === 0) return { ok: false, lines: ["The board has no tasks."] };
		const id = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		const file: SavedBoardFile = {
			...(title ? { title } : {}),
			savedAt: new Date().toISOString(),
			events,
		};
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(file)}\n`);
		return {
			ok: true,
			lines: [
				`Saved ${title ? `"${title}"` : "the board"} with ${plural(tasks, "task")}.`,
			],
		};
	};

	return new BoardSlots({
		workspaceRoot: options.workspaceRoot,
		conversation: () => {
			const open = options.conversation();
			return open
				? {
						id: open.board.control.sessionId,
						...(open.title ? { title: open.title } : {}),
						live: true,
					}
				: undefined;
		},
		liveText: () => {
			const board = options.conversation()?.board;
			return board && !board.store.isEmpty()
				? JSON.stringify(board.control.snapshot())
				: undefined;
		},
		liveEvents: () =>
			options.conversation()?.board.control.exportBoard({}).events,
		liveEdit: (action) => {
			const board = options.conversation()?.board;
			if (!board) {
				return {
					ok: false,
					lines: ["Open a conversation to change its board."],
				};
			}
			const outcome = board.control.edit(action);
			return { ok: outcome.changed, lines: outcome.lines };
		},
		turnRunning: () => options.conversation()?.running === true,
		draftStorage,
		recent: async (_root, limit, exclude) => {
			const dir = options.logDir?.();
			if (!dir || !existsSync(dir)) return [];
			const logs = readdirSync(dir)
				.filter((name) => name.endsWith(SESSION_BOARD_LOG_SUFFIX))
				.map((name) => {
					const id = name.slice(0, -SESSION_BOARD_LOG_SUFFIX.length);
					const at = statSync(join(dir, name)).mtimeMs;
					return { id, at };
				})
				.filter(({ id }) => id !== exclude && safeId(id))
				.sort((a, b) => b.at - a.at);
			const boards: RecentBoard[] = [];
			for (const { id, at } of logs) {
				if (boards.length >= limit) break;
				const events = TaskGraphStore.readEvents(
					join(dir, `${id}${SESSION_BOARD_LOG_SUFFIX}`),
				);
				if (counts(events).tasks === 0) continue;
				boards.push({ id, at: new Date(at).toISOString(), events });
			}
			return boards;
		},
		saved: () => {
			const dir = folder("saved");
			if (!dir || !existsSync(dir)) return [];
			const entries: SavedBoardEntry[] = [];
			for (const name of readdirSync(dir)) {
				if (!name.endsWith(".json")) continue;
				const id = name.slice(0, -5);
				const file = readJson<SavedBoardFile>(join(dir, name));
				if (!file || !Array.isArray(file.events) || !safeId(id)) continue;
				entries.push({
					id,
					memory: savedName,
					...(file.title ? { title: file.title } : {}),
					...counts(file.events),
					savedAt: file.savedAt,
				});
			}
			return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
		},
		savedEvents: (id, memory) => {
			const dir = folder("saved");
			if (!dir || memory !== savedName || !safeId(id)) return undefined;
			const file = readJson<SavedBoardFile>(join(dir, `${id}.json`));
			return Array.isArray(file?.events) ? file.events : undefined;
		},
		saveConversation: async (id, title) => {
			const open = options.conversation();
			if (open && open.board.control.sessionId === id) {
				return save(
					open.board.control.exportBoard({ title }).events,
					title ?? open.title,
				);
			}
			const log = logOf(id);
			const events = log ? TaskGraphStore.readEvents(log) : [];
			if (events.length === 0) {
				return {
					ok: false,
					lines: ["That conversation has no board to save."],
				};
			}
			return save(events, title);
		},
		saveEvents: async (events, title) => save(events, title),
		deleteSaved: async (id, memory) => {
			const dir = folder("saved");
			if (!dir || memory !== savedName || !safeId(id)) return false;
			const file = join(dir, `${id}.json`);
			if (!existsSync(file)) return false;
			rmSync(file);
			return true;
		},
		startConversation: (events, onTaken) =>
			options.startConversation(
				{
					events,
					by: "person",
					about: "the person made it in the Board tab for this conversation",
				},
				onTaken,
			),
	});
}
