import {
	type CoreTaskGraphControl,
	type ExportedTaskBoard,
	exportTaskEvents,
	exportTaskLog,
	isTaskEvent,
	sharedMemory,
} from "@cline/core"
import { MAIN_MEMORY, memorySelectionFor } from "@cline/shared"
import { Logger } from "@shared/services/Logger"
import { readMemorySettings } from "./library-config"

/**
 * A board waiting for the next new conversation: one saved in Memory and
 * picked in the Memory panel, or the Board tab's draft.
 */
export interface TaskBoardSeed {
	events: unknown[]
	/** The author its events get, as `memory:m12`, or `person` for a draft. */
	by: string
	/** The saved board it came from; a draft has none, so nothing is kept updated. */
	noteId?: string
	memory?: string
	keepUpdated: boolean
	/** Where it came from, for the model: as `m12, "ledger", saved 2026-11-21`. */
	about?: string
	/** Called when a new conversation takes it. */
	onTaken?: () => void
}

/** Which saved board a session's board is tied to, for keep-updated. */
interface BoardLink {
	sessionId: string
	noteId: string
	memory: string
}

/** How long changes are gathered before a keep-updated board is written. */
const KEEP_UPDATED_DEBOUNCE_MS = 1500

type MemoryLike = Pick<ReturnType<typeof sharedMemory>, "saveBoard" | "readBoard" | "listMemories" | "list" | "forget">

/**
 * The task board and Memory (task graph phase 2, PLAN-task-graph.md section 11):
 *
 * - **Save.** The task panel's "Save to memory" writes the live session's board
 *   into a memory the person picks, as a saved board (not a note the model
 *   recalls), and ties the session to it.
 * - **Use.** The Memory panel's "Use in a new conversation" arms the board;
 *   the next new conversation starts from its events, ids kept, each authored
 *   `memory:<id>`, and is tied to it.
 * - **Keep updated.** While the saved board says so, every change in a session
 *   tied to it rewrites it, a moment after the last change. Two conversations
 *   working from one board each write it; the board records which wrote last.
 *
 * Saving and using are the person's actions; the model has no tool for either.
 */
export class TaskBoardMemory {
	private pending: TaskBoardSeed | undefined
	private armed: TaskBoardSeed | undefined
	private attaching: TaskBoardSeed | undefined
	private link: BoardLink | undefined
	private control: CoreTaskGraphControl | undefined
	private timer: ReturnType<typeof setTimeout> | undefined
	private title: string | undefined

	constructor(
		private readonly options: {
			memory?: () => MemoryLike
			cwd?: () => Promise<string>
			debounceMs?: number
			/** A conversation's board log, for one with no live session. */
			logPath?: (sessionId: string) => Promise<string | undefined>
		} = {},
	) {}

	private get memory(): MemoryLike {
		return this.options.memory?.() ?? sharedMemory()
	}

	/** From the Memory panel: the next new conversation starts from this board. */
	use(seed: TaskBoardSeed): void {
		this.pending = seed
	}

	/** A conversation is starting: a new one takes the board waiting for it, a resumed one does not. */
	beginTask(isNew: boolean, title?: string): void {
		this.title = title?.trim() || undefined
		if (isNew && this.pending) {
			this.armed = this.pending
			this.pending = undefined
		}
	}

	/** For the session config: the armed board, once. */
	takeSeed(): { events: unknown[]; by: string; about?: string } | undefined {
		const seed = this.armed
		if (!seed) return undefined
		this.armed = undefined
		this.attaching = seed
		seed.onTaken?.()
		return { events: seed.events, by: seed.by, ...(seed.about ? { about: seed.about } : {}) }
	}

	/** The live session's board handle arrived. */
	attach(control: CoreTaskGraphControl): void {
		this.control = control
		if (this.attaching) {
			const { noteId, memory } = this.attaching
			// A draft came from no saved board: there is nothing to keep updated.
			this.link = noteId && memory ? { sessionId: control.sessionId, noteId, memory } : undefined
			this.attaching = undefined
		} else if (this.link && this.link.sessionId !== control.sessionId) {
			this.link = undefined
		}
	}

	/** The board changed: rewrite the saved board it is tied to, if that one keeps updated. */
	changed(): void {
		const link = this.link
		if (!link || this.control?.sessionId !== link.sessionId) return
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => {
			this.timer = undefined
			void this.writeLinked().catch((error) =>
				Logger.warn(`[task-graph] keep-updated write of ${link.noteId} failed: ${error}`),
			)
		}, this.options.debounceMs ?? KEEP_UPDATED_DEBOUNCE_MS)
	}

	private async writeLinked(): Promise<void> {
		const link = this.link
		const control = this.control
		if (!link || !control || control.sessionId !== link.sessionId) return
		const saved = this.memory.readBoard(link.noteId, { memories: [link.memory] })
		if (!saved?.board.keepUpdated) return
		const exported = control.exportBoard({ ...(saved.board.title ? { title: saved.board.title } : {}) })
		await this.memory.saveBoard({
			memory: link.memory,
			replaces: link.noteId,
			text: exported.text,
			board: {
				sessionId: control.sessionId,
				...(saved.board.title ? { title: saved.board.title } : {}),
				keepUpdated: true,
				tasks: exported.tasks,
				open: exported.open,
				events: exported.events,
			},
		})
	}

	/** The boards saved in Memory, newest first, for the Board tab's Load. Empty while Memory is off. */
	savedBoards(): { id: string; memory: string; title?: string; tasks: number; open: number; savedAt: string }[] {
		if (!readMemorySettings().enabled) return []
		const memories = this.memory.listMemories().map((entry) => entry.name)
		return this.memory
			.list({ memories, boards: "only" })
			.filter((item) => item.board)
			.map((item) => ({
				id: item.id,
				memory: item.memory,
				...(item.board?.title ? { title: item.board.title } : {}),
				tasks: item.board?.tasks ?? 0,
				open: item.board?.open ?? 0,
				savedAt: item.createdAt,
			}))
	}

	/** A saved board's events, by its id in a memory. */
	savedBoardEvents(id: string, memory: string): unknown[] | undefined {
		return this.memory.readBoard(id, { memories: [memory] })?.board.events
	}

	/** The memories a board can be saved into, and the one this workspace stores to. */
	async memories(): Promise<{ enabled: boolean; names: string[]; preferred: string }> {
		const settings = readMemorySettings()
		if (!settings.enabled) return { enabled: false, names: [], preferred: MAIN_MEMORY }
		const names = this.memory.listMemories().map((entry) => entry.name)
		const cwd = (await this.options.cwd?.()) ?? ""
		const preferred = memorySelectionFor(settings, cwd).store
		return { enabled: true, names, preferred: names.includes(preferred) ? preferred : MAIN_MEMORY }
	}

	/**
	 * From the task panel: save the board into a memory, and tie the session to
	 * it. The live session's board when the conversation has one; otherwise
	 * (reopened from history, not sent a message yet) the board its log holds.
	 */
	async save(input: { sessionId: string; memory?: string; keepUpdated: boolean; title?: string }): Promise<string[]> {
		const { enabled, names, preferred } = await this.memories()
		if (!enabled) return ["Memory is off. Turn it on under Settings → Memory to save the board."]
		const title = input.title?.trim() || this.title
		const header = title ? { title } : {}
		const control = this.control
		let exported: ExportedTaskBoard | undefined
		if (control && control.sessionId === input.sessionId) {
			exported = control.exportBoard(header) as ExportedTaskBoard
		} else {
			const logPath = await this.options.logPath?.(input.sessionId)
			exported = logPath ? exportTaskLog(logPath, { ...header, sessionId: input.sessionId }) : undefined
		}
		if (!exported || exported.tasks === 0) return ["The board is empty: there is nothing to save."]
		const memory = input.memory && names.includes(input.memory) ? input.memory : preferred
		const item = await this.memory.saveBoard({
			memory,
			text: exported.text,
			board: {
				sessionId: input.sessionId,
				...(title ? { title } : {}),
				keepUpdated: input.keepUpdated,
				tasks: exported.tasks,
				open: exported.open,
				events: exported.events,
			},
		})
		this.link = { sessionId: input.sessionId, noteId: item.id, memory }
		return [
			`Saved the board as ${item.id} in "${memory}" (${exported.tasks} task${exported.tasks === 1 ? "" : "s"}, ${exported.open} open)${
				input.keepUpdated ? ", kept up to date from here" : ""
			}.`,
		]
	}

	/**
	 * The Board tab's "Save to Memory" for a board with no conversation behind
	 * it (a draft): its events, saved as a board into the memory this
	 * workspace stores to. Not tied to any conversation.
	 */
	async saveEvents(input: { events: unknown[]; title?: string; memory?: string }): Promise<string[]> {
		const { enabled, names, preferred } = await this.memories()
		if (!enabled) return ["Memory is off. Turn it on under Settings → Memory to save the board."]
		const title = input.title?.trim()
		const exported = exportTaskEvents(input.events.filter(isTaskEvent), {
			sessionId: "board-tab",
			...(title ? { title } : {}),
		})
		if (exported.tasks === 0) return ["The board is empty: there is nothing to save."]
		const memory = input.memory && names.includes(input.memory) ? input.memory : preferred
		const item = await this.memory.saveBoard({
			memory,
			text: exported.text,
			board: {
				sessionId: "board-tab",
				...(title ? { title } : {}),
				keepUpdated: false,
				tasks: exported.tasks,
				open: exported.open,
				events: exported.events,
			},
		})
		return [
			`Saved the board as ${item.id} in "${memory}" (${exported.tasks} task${exported.tasks === 1 ? "" : "s"}, ${exported.open} open).`,
		]
	}

	/** The Board tab's Delete on a board saved in Memory. */
	async deleteSaved(id: string, memory: string): Promise<boolean> {
		return this.memory.forget(id, { memories: [memory] })
	}
}
