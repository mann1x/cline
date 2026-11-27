import type { ViewerBoardEntry } from "../protocol";
import { boardPlanFromEvents, TaskGraphStore } from "../task-graph";
import { type BoardEditAction, DraftBoard, type DraftStorage } from "./draft";
import type { BoardIoDeps, SavedBoardEntry } from "./io";

/**
 * The boards the Board tab lists (owner, 2026-11-27: "we should have a
 * selection of the active board and the sessions/saved files/in memory
 * board"), by key:
 *
 * - `live`: the open conversation's board. Changed in place while its
 *   session is live; every change is the person's, and the model is told.
 * - `draft:1` to `draft:3`: the person's drafts, kept per workspace across
 *   reloads. Any of them can start the next new conversation.
 * - `recent:<id>`: the board of one of the workspace's newest conversations,
 *   read from its log. Viewed and copied, not changed.
 * - `saved:<memory>/<id>`: a board saved in Memory. Viewed, copied, deleted.
 *
 * Copying takes a board's tasks as a fresh plan (titles, order, steps,
 * acceptance, the gates that recur), as Load does; into a board with tasks
 * the person picks Add or Replace. Replace on the open conversation waits
 * until its model stops: tasks gone under a working model leave it acting
 * on what is no longer there.
 */

export const DRAFT_COUNT = 3;
/** How many recent conversations the tab lists. */
export const RECENT_BOARDS = 10;
/** How many boards saved in Memory it lists, newest first. */
export const SAVED_BOARDS = 20;
/** A recent conversation's board changes rarely: read the logs again after this long. */
const RECENT_TTL_MS = 5_000;

export const LIVE_BOARD = "live";
export const draftKey = (slot: number) => `draft:${slot}`;
export const recentKey = (id: string) => `recent:${id}`;
export const savedKey = (memory: string, id: string) =>
	`saved:${encodeURIComponent(memory)}/${encodeURIComponent(id)}`;

export type BoardRef =
	| { kind: "conversation" }
	| { kind: "draft"; slot: number }
	| { kind: "recent"; id: string }
	| { kind: "saved"; memory: string; id: string };

export function parseBoardKey(key: string): BoardRef | undefined {
	if (key === LIVE_BOARD) return { kind: "conversation" };
	const draft = /^draft:(\d+)$/.exec(key);
	if (draft) {
		const slot = Number(draft[1]);
		return slot >= 1 && slot <= DRAFT_COUNT
			? { kind: "draft", slot }
			: undefined;
	}
	if (key.startsWith("recent:") && key.length > 7)
		return { kind: "recent", id: key.slice(7) };
	const saved = /^saved:([^/]+)\/(.+)$/.exec(key);
	if (saved) {
		try {
			return {
				kind: "saved",
				memory: decodeURIComponent(saved[1]),
				id: decodeURIComponent(saved[2]),
			};
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export interface RecentBoard {
	id: string;
	title?: string;
	at?: string;
	events: unknown[];
}

type Outcome = { ok: boolean; lines: string[] };

export interface BoardSlotsDeps {
	workspaceRoot: () => string | undefined;
	/** The conversation on screen, when one is open; `live` while its session takes board changes. */
	conversation: () => { id: string; title?: string; live: boolean } | undefined;
	/** Its board, as the task panel's row carries it. */
	liveText: () => string | undefined;
	/** Its board as events, while its session is live. */
	liveEvents: () => unknown[] | undefined;
	/** The person's change to it; the model is told. */
	liveEdit: (action: BoardEditAction) => Outcome;
	/** Its model is in the middle of a turn. */
	turnRunning: () => boolean;
	draftStorage: (slot: number) => DraftStorage;
	recent: (
		workspaceRoot: string | undefined,
		limit: number,
		exclude: string | undefined,
	) => Promise<RecentBoard[]>;
	saved: () => SavedBoardEntry[];
	savedEvents: (id: string, memory: string) => unknown[] | undefined;
	/** Save a conversation's board into Memory, by its id. */
	saveConversation: (id: string, title?: string) => Promise<Outcome>;
	/** Save a board with no conversation behind it (a draft) into Memory. */
	saveEvents: (events: unknown[], title?: string) => Promise<Outcome>;
	deleteSaved: (id: string, memory: string) => Promise<boolean>;
	/** The next new conversation starts from these events; `onTaken` once it has. */
	startConversation: (events: unknown[], onTaken: () => void) => void;
}

const plural = (count: number, word: string) =>
	`${count} ${word}${count === 1 ? "" : "s"}`;

/** What a board's row says about it: its tasks, and how many are still open. */
function counts(text: string | undefined): { tasks: number; open: number } {
	if (!text) return { tasks: 0, open: 0 };
	try {
		const tasks =
			(JSON.parse(text) as { tasks?: { status?: string }[] }).tasks ?? [];
		return {
			tasks: tasks.length,
			open: tasks.filter(
				(task) => task.status !== "done" && task.status !== "cancelled",
			).length,
		};
	} catch {
		return { tasks: 0, open: 0 };
	}
}

const snapshotText = (
	events: readonly unknown[] | undefined,
): string | undefined => {
	const snapshot = events ? TaskGraphStore.snapshotOf(events) : undefined;
	return snapshot ? JSON.stringify(snapshot) : undefined;
};

export class BoardSlots {
	private readonly drafts: DraftBoard[];
	private recentRead: Promise<RecentBoard[]> | undefined;
	private recentCache:
		| {
				at: number;
				root: string | undefined;
				exclude: string | undefined;
				boards: RecentBoard[];
		  }
		| undefined;

	constructor(
		private readonly deps: BoardSlotsDeps,
		private readonly now: () => number = Date.now,
	) {
		this.drafts = Array.from(
			{ length: DRAFT_COUNT },
			(_, index) => new DraftBoard(deps.draftStorage(index + 1)),
		);
	}

	/** The board shown first: the open conversation's, else Draft 1. */
	home(): string {
		return this.deps.conversation() ? LIVE_BOARD : draftKey(1);
	}

	/** The open conversation's model is working now. */
	turnRunning(): boolean {
		return !!this.deps.conversation() && this.deps.turnRunning();
	}

	/** A request's board: the one it names, else the one shown first. */
	resolve(key: unknown): string {
		return typeof key === "string" && parseBoardKey(key) ? key : this.home();
	}

	private draft(key: string): DraftBoard | undefined {
		const ref = parseBoardKey(key);
		return ref?.kind === "draft" ? this.drafts[ref.slot - 1] : undefined;
	}

	/** Whether the recent boards listed last are still current. */
	recentIsFresh(): boolean {
		const cached = this.recentCache;
		return (
			!!cached &&
			cached.root === this.deps.workspaceRoot() &&
			cached.exclude === this.deps.conversation()?.id &&
			this.now() - cached.at < RECENT_TTL_MS
		);
	}

	private async recent(cachedOnly = false): Promise<RecentBoard[]> {
		const root = this.deps.workspaceRoot();
		const exclude = this.deps.conversation()?.id;
		const cached = this.recentCache;
		if (cachedOnly || this.recentIsFresh()) {
			return cached && cached.root === root
				? cached.boards.filter((board) => board.id !== exclude)
				: [];
		}
		// One read at a time: posts that come while it runs share it.
		if (!this.recentRead) {
			this.recentRead = this.deps
				.recent(root, RECENT_BOARDS, exclude)
				.catch(() => [] as RecentBoard[])
				.then((boards) => {
					this.recentCache = { at: this.now(), root, exclude, boards };
					return boards;
				})
				.finally(() => {
					this.recentRead = undefined;
				});
		}
		return this.recentRead;
	}

	/**
	 * Every board the tab lists, this conversation's first. `cachedOnly` lists
	 * the recent conversations as last read, without reading the history: the
	 * tab draws at once and lists them again when they are read.
	 */
	async list(
		options: { cachedOnly?: boolean } = {},
	): Promise<ViewerBoardEntry[]> {
		const entries: ViewerBoardEntry[] = [];
		const conversation = this.deps.conversation();
		if (conversation) {
			const text = this.deps.liveText();
			entries.push({
				key: LIVE_BOARD,
				kind: "conversation",
				label: "This conversation",
				...(conversation.title ? { detail: conversation.title } : {}),
				...(text ? { text } : {}),
				...counts(text),
				editable: conversation.live,
				...(conversation.live
					? {}
					: {
							readOnly:
								"Send a message to resume the conversation: its board changes while its session runs.",
						}),
			});
		}
		this.drafts.forEach((draft, index) => {
			const text = draft.text();
			entries.push({
				key: draftKey(index + 1),
				kind: "draft",
				label: `Draft ${index + 1}`,
				...(text ? { text } : {}),
				...counts(text),
				editable: true,
			});
		});
		for (const board of await this.recent(options.cachedOnly)) {
			const text = snapshotText(board.events);
			entries.push({
				key: recentKey(board.id),
				kind: "recent",
				label: board.title?.split("\n")[0]?.slice(0, 80) || board.id,
				...(board.at ? { detail: board.at } : {}),
				...(text ? { text } : {}),
				...counts(text),
				editable: false,
				readOnly:
					"An earlier conversation's board: copy it here or to a draft to change it.",
			});
		}
		for (const saved of this.deps.saved().slice(0, SAVED_BOARDS)) {
			const text = snapshotText(this.deps.savedEvents(saved.id, saved.memory));
			entries.push({
				key: savedKey(saved.memory, saved.id),
				kind: "saved",
				label: saved.title || saved.id,
				detail: `${saved.id} in "${saved.memory}", saved ${saved.savedAt.slice(0, 10)}`,
				...(text ? { text } : {}),
				tasks: saved.tasks,
				open: saved.open,
				editable: false,
				readOnly: "Saved in Memory: copy it here or to a draft to change it.",
			});
		}
		return entries;
	}

	/** The board's row text: what the tab draws. */
	text(key: string): string | undefined {
		const ref = parseBoardKey(key);
		if (!ref) return undefined;
		if (ref.kind === "conversation")
			return this.deps.conversation() ? this.deps.liveText() : undefined;
		if (ref.kind === "draft") return this.drafts[ref.slot - 1]?.text();
		return snapshotText(this.events(key));
	}

	/** The board's events; a recent conversation's as last listed. */
	events(key: string): unknown[] | undefined {
		const ref = parseBoardKey(key);
		if (!ref) return undefined;
		switch (ref.kind) {
			case "conversation":
				return this.deps.conversation() ? this.deps.liveEvents() : undefined;
			case "draft":
				return this.drafts[ref.slot - 1]?.events();
			case "recent":
				return this.recentCache?.boards.find((board) => board.id === ref.id)
					?.events;
			case "saved":
				return this.deps.savedEvents(ref.id, ref.memory);
		}
	}

	private label(key: string): string {
		const ref = parseBoardKey(key);
		if (!ref) return key;
		switch (ref.kind) {
			case "conversation":
				return "this conversation's board";
			case "draft":
				return `Draft ${ref.slot}`;
			case "recent": {
				const title = this.recentCache?.boards
					.find((board) => board.id === ref.id)
					?.title?.split("\n")[0]
					?.slice(0, 60);
				return title
					? `the board of "${title}"`
					: `the board of conversation ${ref.id}`;
			}
			case "saved":
				return `the saved board ${ref.id}`;
		}
	}

	/** Why the board cannot be changed here, or undefined when it can. */
	readOnly(key: string): string | undefined {
		const ref = parseBoardKey(key);
		if (!ref) return "There is no such board.";
		if (ref.kind === "draft") return undefined;
		if (ref.kind === "conversation") {
			const conversation = this.deps.conversation();
			if (!conversation) return "No conversation is open.";
			return conversation.live
				? undefined
				: "This conversation's board changes while its session runs: send a message to resume it.";
		}
		return ref.kind === "recent"
			? "An earlier conversation's board is not changed here: copy it to this conversation or a draft."
			: "A board saved in Memory is not changed here: copy it to this conversation or a draft.";
	}

	/** The person's change to a board they can change. */
	edit(key: string, action: BoardEditAction): Outcome {
		const refused = this.readOnly(key);
		if (refused) return { ok: false, lines: [refused] };
		const draft = this.draft(key);
		return draft ? draft.edit(action) : this.deps.liveEdit(action);
	}

	hasTasks(key: string): boolean {
		return counts(this.text(key)).tasks > 0;
	}

	/**
	 * Copy one board's tasks to another, Add or Replace. `ask` puts the
	 * question to the person when the target already has tasks; the answer is
	 * one of the buttons it was given, or undefined for cancelled.
	 */
	async copy(
		from: string,
		to: string,
		ask: (
			question: string,
			...buttons: string[]
		) => Promise<string | undefined>,
	): Promise<{ ok: boolean; lines?: string[]; errors?: string[] }> {
		if (from === to)
			return { ok: false, errors: ["Pick another board to copy to."] };
		const refused = this.readOnly(to);
		if (refused) return { ok: false, errors: [refused] };
		const events = this.events(from);
		const tasks = events ? boardPlanFromEvents(events) : [];
		if (tasks.length === 0)
			return {
				ok: false,
				errors: [`${this.label(from)} has no tasks to copy.`],
			};
		const target = this.label(to);
		const live = parseBoardKey(to)?.kind === "conversation";
		let replace = false;
		if (this.hasTasks(to)) {
			const running = live && this.deps.turnRunning();
			const question = `${target[0]?.toUpperCase()}${target.slice(1)} has tasks. Add the ${plural(tasks.length, "task")} from ${this.label(from)} after them, or replace them?${
				running
					? " Replace waits until the model stops working: tasks gone under it leave it acting on what is no longer there."
					: ""
			}`;
			const answer = running
				? await ask(question, "Add")
				: await ask(question, "Add", "Replace");
			if (!answer) return { ok: false };
			replace = answer === "Replace";
		}
		const lines: string[] = [];
		if (replace) {
			if (live) {
				// Refused again here: the turn may have started while the person read the question.
				if (this.deps.turnRunning()) {
					return {
						ok: false,
						errors: [
							"The model started working: Replace waits until it stops. Add works now.",
						],
					};
				}
				const top = this.topLevelIds(this.text(to));
				if (top.length > 0) {
					const removed = this.deps.liveEdit({ op: "remove", ids: top });
					lines.push(...removed.lines);
				}
			} else {
				this.draft(to)?.clear();
			}
		}
		const planned = this.edit(to, { op: "plan", tasks });
		if (!planned.ok) return { ok: false, errors: [...lines, ...planned.lines] };
		return {
			ok: true,
			lines: [
				`Copied ${plural(tasks.length, "task")} from ${this.label(from)} to ${target}.`,
				...lines,
				...planned.lines,
			],
		};
	}

	private topLevelIds(text: string | undefined): string[] {
		try {
			const tasks = text
				? ((JSON.parse(text) as { tasks?: { id?: string; parent?: string }[] })
						.tasks ?? [])
				: [];
			return tasks
				.filter((task) => typeof task.id === "string" && !task.parent)
				.map((task) => task.id as string);
		} catch {
			return [];
		}
	}

	/** A draft starts the next new conversation. */
	start(key: string): Outcome {
		const draft = this.draft(key);
		if (!draft)
			return { ok: false, lines: ["Only a draft starts a new conversation."] };
		if (this.deps.conversation()) {
			return {
				ok: false,
				lines: [
					"A conversation is open. Start a new one (the + button) to hand it this board.",
				],
			};
		}
		if (draft.isEmpty())
			return { ok: false, lines: [`${this.label(key)} has no tasks yet.`] };
		this.deps.startConversation(draft.events(), () => draft.clear());
		return {
			ok: true,
			lines: [
				"Send your first message in the chat: the new conversation starts from this board.",
			],
		};
	}

	/** Empty a draft. */
	clear(key: string): Outcome {
		const draft = this.draft(key);
		if (!draft) return { ok: false, lines: ["Only a draft is discarded."] };
		draft.clear();
		return { ok: true, lines: [`${this.label(key)} is empty.`] };
	}

	/** Save a board into Memory. */
	async save(key: string): Promise<Outcome> {
		const ref = parseBoardKey(key);
		if (!ref) return { ok: false, lines: ["There is no such board."] };
		if (ref.kind === "saved")
			return { ok: false, lines: ["It is saved in Memory already."] };
		if (ref.kind === "conversation") {
			const conversation = this.deps.conversation();
			if (!conversation)
				return { ok: false, lines: ["No conversation is open."] };
			return this.deps.saveConversation(conversation.id, conversation.title);
		}
		if (ref.kind === "recent") {
			const board = this.recentCache?.boards.find(
				(entry) => entry.id === ref.id,
			);
			return this.deps.saveConversation(ref.id, board?.title?.split("\n")[0]);
		}
		const events = this.drafts[ref.slot - 1]?.events() ?? [];
		return this.deps.saveEvents(events, `Draft ${ref.slot}`);
	}

	/** Delete a board saved in Memory. */
	async deleteSaved(key: string): Promise<Outcome> {
		const ref = parseBoardKey(key);
		if (ref?.kind !== "saved")
			return {
				ok: false,
				lines: ["Only a board saved in Memory is deleted here."],
			};
		const gone = await this.deps.deleteSaved(ref.id, ref.memory);
		return gone
			? { ok: true, lines: [`Deleted ${ref.id} from "${ref.memory}".`] }
			: { ok: false, lines: [`${ref.id} is no longer in "${ref.memory}".`] };
	}

	/** Load and Export, for one board. */
	io(
		key: string,
		base: Pick<BoardIoDeps, "workspaceRoot" | "ui">,
	): BoardIoDeps {
		return {
			...base,
			isDraft: () => parseBoardKey(key)?.kind === "draft",
			events: () => this.events(key),
			hasTasks: () => this.hasTasks(key),
			plan: (tasks) => this.edit(key, { op: "plan", tasks }),
			clearDraft: () => this.draft(key)?.clear(),
			savedBoards: () => this.deps.saved(),
			savedBoardEvents: (id, memory) => this.deps.savedEvents(id, memory),
		};
	}
}
