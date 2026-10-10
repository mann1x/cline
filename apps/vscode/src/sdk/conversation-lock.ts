import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Logger } from "@/shared/services/Logger"

/**
 * Which window has a conversation open.
 *
 * Every VS Code window runs its own extension host on the same data directory,
 * so any of them can open any conversation from History. Two windows on one
 * conversation both append to its transcript and both drive its session, and
 * neither sees the other's turns. A window therefore claims the conversation it
 * shows, with a file per conversation that the other windows read before they
 * open or resume it.
 *
 * A claim ends when the window lets the conversation go. One left by a window
 * that crashed is recognised two ways: its process is gone, or it stopped
 * refreshing the file. The second covers what the first cannot see, a process
 * id reused by something else and a window on another machine sharing the
 * directory.
 */

export interface ConversationHolder {
	pid: number
	host: string
	/** Unique per extension host, so a reloaded window is not mistaken for its former self. */
	windowId: string
	/** The folder open in the holding window, for the message shown to the user. */
	workspace?: string
	since: number
}

export interface ConversationLocksOptions {
	dir: string
	windowId: string
	/** The folder open in this window, read when a claim is written. */
	getWorkspace?: () => string | undefined
	/** A claim not refreshed for this long is abandoned. */
	staleMs?: number
	/** How often held claims are refreshed. 0 disables the timer (tests). */
	heartbeatMs?: number
	pid?: number
	host?: string
	isProcessAlive?: (pid: number) => boolean
	now?: () => number
}

const DEFAULT_STALE_MS = 5 * 60_000
const DEFAULT_HEARTBEAT_MS = 30_000

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		// EPERM: it exists and belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

export class ConversationLocks {
	private readonly held = new Set<string>()
	private readonly staleMs: number
	private readonly pid: number
	private readonly host: string
	private readonly isProcessAlive: (pid: number) => boolean
	private readonly now: () => number
	private heartbeat: NodeJS.Timeout | undefined

	constructor(private readonly options: ConversationLocksOptions) {
		this.staleMs = options.staleMs ?? DEFAULT_STALE_MS
		this.pid = options.pid ?? process.pid
		this.host = options.host ?? os.hostname()
		this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
		this.now = options.now ?? Date.now
		const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
		if (heartbeatMs > 0) {
			this.heartbeat = setInterval(() => this.refresh(), heartbeatMs)
			this.heartbeat.unref?.()
		}
	}

	/** The other window that has this conversation open, if one does. */
	holderOf(conversationId: string): ConversationHolder | undefined {
		const holder = this.read(conversationId)
		return holder && !this.isMine(holder) ? holder : undefined
	}

	/**
	 * Claim a conversation for this window. Returns the other window holding
	 * it when the claim is refused, and undefined when this window has it.
	 */
	tryAcquire(conversationId: string): ConversationHolder | undefined {
		const file = this.fileFor(conversationId)
		for (let attempt = 0; attempt < 3; attempt++) {
			const holder = this.read(conversationId)
			if (holder && !this.isMine(holder)) {
				return holder
			}
			try {
				fs.mkdirSync(this.options.dir, { recursive: true })
				if (holder) {
					// Already this window's: refresh it.
					fs.writeFileSync(file, JSON.stringify(holder))
				} else {
					// Whatever is there is abandoned or unreadable. Remove it, then
					// create exclusively, so of two windows racing here one loses.
					fs.rmSync(file, { force: true })
					fs.writeFileSync(file, JSON.stringify(this.describe()), { flag: "wx" })
				}
				this.held.add(conversationId)
				return undefined
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					// A lock that cannot be written must not stop the conversation.
					Logger.warn(`[ConversationLocks] Could not claim ${conversationId}:`, error)
					return undefined
				}
			}
		}
		return this.holderOf(conversationId)
	}

	release(conversationId: string): void {
		if (!this.held.delete(conversationId)) {
			return
		}
		try {
			const holder = this.read(conversationId)
			if (holder && this.isMine(holder)) {
				fs.rmSync(this.fileFor(conversationId), { force: true })
			}
		} catch (error) {
			Logger.warn(`[ConversationLocks] Could not release ${conversationId}:`, error)
		}
	}

	/**
	 * Make the held set exactly `conversationIds`: claim the new ones, let the
	 * rest go. Cheap when nothing changed, so it can follow every state post.
	 */
	hold(conversationIds: readonly string[]): void {
		const wanted = new Set(conversationIds.filter(Boolean))
		for (const id of [...this.held]) {
			if (!wanted.has(id)) {
				this.release(id)
			}
		}
		for (const id of wanted) {
			if (!this.held.has(id)) {
				this.tryAcquire(id)
			}
		}
	}

	dispose(): void {
		if (this.heartbeat) {
			clearInterval(this.heartbeat)
			this.heartbeat = undefined
		}
		for (const id of [...this.held]) {
			this.release(id)
		}
	}

	/** Touch every held claim; one taken over in the meantime is dropped, not fought for. */
	refresh(): void {
		const stamp = new Date(this.now())
		for (const id of [...this.held]) {
			try {
				const holder = this.read(id)
				if (holder && this.isMine(holder)) {
					fs.utimesSync(this.fileFor(id), stamp, stamp)
				} else if (holder) {
					Logger.warn(`[ConversationLocks] ${id} was taken over by another window (pid ${holder.pid})`)
					this.held.delete(id)
				} else {
					this.held.delete(id)
					this.tryAcquire(id)
				}
			} catch (error) {
				Logger.warn(`[ConversationLocks] Could not refresh ${id}:`, error)
			}
		}
	}

	private describe(): ConversationHolder {
		const workspace = this.options.getWorkspace?.()
		return {
			pid: this.pid,
			host: this.host,
			windowId: this.options.windowId,
			...(workspace ? { workspace } : {}),
			since: this.now(),
		}
	}

	private isMine(holder: ConversationHolder): boolean {
		return holder.windowId === this.options.windowId
	}

	/** The live claim on a conversation, or undefined when there is none or it is abandoned. */
	private read(conversationId: string): ConversationHolder | undefined {
		const file = this.fileFor(conversationId)
		try {
			const stat = fs.statSync(file)
			const holder = JSON.parse(fs.readFileSync(file, "utf-8")) as ConversationHolder
			if (typeof holder?.pid !== "number" || typeof holder.windowId !== "string") {
				return undefined
			}
			if (this.isMine(holder)) {
				return holder
			}
			if (this.now() - stat.mtimeMs > this.staleMs) {
				return undefined
			}
			if (holder.host === this.host && !this.isProcessAlive(holder.pid)) {
				return undefined
			}
			return holder
		} catch {
			return undefined
		}
	}

	private fileFor(conversationId: string): string {
		return path.join(this.options.dir, `${conversationId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`)
	}
}

/** What the user is told when a conversation is open in another window. */
export function describeHeldConversation(holder: ConversationHolder): string {
	const where = holder.workspace ? ` (${path.basename(holder.workspace)})` : ""
	return `This conversation is open in another VS Code window${where}. Close it there, or start a new one here.`
}
