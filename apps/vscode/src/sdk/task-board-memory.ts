import { type CoreTaskGraphControl, type ExportedTaskBoard, exportTaskLog, sharedMemory } from "@cline/core"
import { MAIN_MEMORY, memorySelectionFor } from "@cline/shared"
import { Logger } from "@shared/services/Logger"
import { readMemorySettings } from "./library-config"

/** A saved board, picked in the Memory panel, waiting for the next new conversation. */
export interface TaskBoardSeed {
	events: unknown[]
	/** The author its events get, as `memory:m12`. */
	by: string
	noteId: string
	memory: string
	keepUpdated: boolean
	/** Where it came from, for the model: as `m12, "ledger", saved 2026-11-21`. */
	about?: string
}

/** Which saved board a session's board is tied to, for keep-updated. */
interface BoardLink {
	sessionId: string
	noteId: string
	memory: string
}

/** How long changes are gathered before a keep-updated board is written. */
const KEEP_UPDATED_DEBOUNCE_MS = 1500

type MemoryLike = Pick<ReturnType<typeof sharedMemory>, "saveBoard" | "readBoard" | "listMemories">

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
		return { events: seed.events, by: seed.by, ...(seed.about ? { about: seed.about } : {}) }
	}

	/** The live session's board handle arrived. */
	attach(control: CoreTaskGraphControl): void {
		this.control = control
		if (this.attaching) {
			this.link = { sessionId: control.sessionId, noteId: this.attaching.noteId, memory: this.attaching.memory }
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
}
