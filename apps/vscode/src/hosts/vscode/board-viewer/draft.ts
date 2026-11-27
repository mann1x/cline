import { TaskGraphStore } from "@cline/core"

/**
 * The Board tab's draft board: tasks the person adds while no conversation
 * is open. It is a task board like a conversation's, in plan mode (nothing
 * starts: no model is working on it), kept in the workspace's state so a
 * reload keeps it. "Start a conversation with this board" hands its events
 * to the next new conversation as a seed, the way a board saved in Memory
 * is; the draft is cleared once a conversation takes it.
 */

export type BoardEditAction =
	| { op: "update"; updates: unknown[] }
	| { op: "plan"; tasks: unknown[] }
	| { op: "remove"; ids: string[] }

export interface DraftStorage {
	get(): unknown[] | undefined
	set(events: unknown[] | undefined): void
}

export class DraftBoard {
	private store: TaskGraphStore

	constructor(private readonly storage: DraftStorage) {
		this.store = DraftBoard.load(storage.get())
	}

	private static load(events: unknown[] | undefined): TaskGraphStore {
		const store = new TaskGraphStore({ planMode: true })
		if (events && events.length > 0) store.reconcile(undefined, undefined, { events, by: "person" })
		return store
	}

	isEmpty(): boolean {
		return this.store.isEmpty()
	}

	/** The board as the task panel's `task_graph` row carries it; undefined while it has no tasks. */
	text(): string | undefined {
		return this.store.isEmpty() ? undefined : JSON.stringify(this.store.snapshot())
	}

	events(): unknown[] {
		return [...this.store.getEvents()]
	}

	/** The person's change, as the task panel sends it to a conversation's board. */
	edit(action: BoardEditAction): { ok: boolean; lines: string[] } {
		const origin = { by: "person" }
		const outcome =
			action.op === "plan"
				? this.store.plan({ tasks: action.tasks }, origin, { autoStart: false })
				: action.op === "remove"
					? this.store.remove(action.ids, origin)
					: this.store.update({ updates: action.updates }, origin)
		this.storage.set(this.events())
		return { ok: outcome.changed, lines: outcome.lines }
	}

	clear(): void {
		this.store = DraftBoard.load(undefined)
		this.storage.set(undefined)
	}
}
