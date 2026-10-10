import * as fs from "node:fs"
import * as path from "node:path"
import { Logger } from "../services/Logger"
import { ClineSyncStorage } from "./ClineStorage"

export interface ClineFileStorageOptions {
	/**
	 * File permissions mode (e.g., 0o600 for owner read/write only).
	 * If not set, uses the system default.
	 */
	fileMode?: number
}

/** Keys another process changed in the file; see {@link ClineFileStorage.onDidChangeExternally}. */
export type ExternalChangeListener = (keys: readonly string[]) => void

/** How often a watched file is checked for another process's write. */
const EXTERNAL_CHANGE_POLL_MS = 1000

/**
 * Synchronous file-backed JSON storage.
 * Stores any JSON-serializable values with sync read and write.
 * Used for VSCode Memento compatibility and CLI environments.
 *
 * The file is shared: every VS Code window and the CLI hold their own instance
 * on the same path. So a write never dumps this instance's copy. It takes the
 * file's lock, reads what is on disk now, applies only the keys being set and
 * writes that back. Writing the copy read at startup reverted everything the
 * other windows had changed since.
 */
export class ClineFileStorage<T = any> extends ClineSyncStorage<T> {
	protected name: string
	private data: Record<string, T>
	private readonly fsPath: string
	private readonly fileMode?: number
	private readonly externalSubscribers: ExternalChangeListener[] = []
	private stopWatching: (() => void) | undefined

	constructor(filePath: string, name = "ClineFileStorage", options?: ClineFileStorageOptions) {
		super()
		this.fsPath = filePath
		this.name = name
		this.fileMode = options?.fileMode
		this.data = this.readFromDisk() ?? {}
	}

	/**
	 * Called with the keys another process changed, once this instance has
	 * taken them over. Never fires for this instance's own writes. Returns an
	 * unsubscribe function.
	 */
	public onDidChangeExternally(callback: ExternalChangeListener): () => void {
		this.externalSubscribers.push(callback)
		return () => {
			const idx = this.externalSubscribers.indexOf(callback)
			if (idx >= 0) {
				this.externalSubscribers.splice(idx, 1)
			}
		}
	}

	/**
	 * Start noticing other processes' writes. Polls the file's stat rather
	 * than watching it: a write replaces the file by rename, which a file
	 * watcher loses, and a directory watcher costs an inotify instance per
	 * store. Returns a function that stops it.
	 */
	public watchExternalChanges(): () => void {
		if (!this.stopWatching) {
			const listener = (current: fs.Stats, previous: fs.Stats) => {
				if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size) {
					this.refreshFromDisk()
				}
			}
			fs.watchFile(this.fsPath, { interval: EXTERNAL_CHANGE_POLL_MS, persistent: false }, listener)
			this.stopWatching = () => {
				fs.unwatchFile(this.fsPath, listener)
				this.stopWatching = undefined
			}
		}
		return () => this.stopWatching?.()
	}

	/**
	 * Take over what is on disk now and report the keys that differ from this
	 * instance's copy to the external-change subscribers.
	 */
	public refreshFromDisk(): readonly string[] {
		let changed: string[] = []
		try {
			withFileLock(this.fsPath, () => {
				changed = this.adoptDisk()
			})
		} catch (error) {
			Logger.error(`[${this.name}] failed to refresh from ${this.fsPath}:`, error)
		}
		this.fireExternalChange(changed)
		return changed
	}

	protected _get(key: string): T | undefined {
		return this.data[key]
	}

	protected _set(key: string, value: T | undefined): void {
		// Use setBatch for consistency - all writes go through one path
		this.setBatch({ [key]: value })
	}

	protected _delete(key: string): void {
		this.setBatch({ [key]: undefined })
	}

	/**
	 * Set multiple keys in a single write operation.
	 * More efficient than calling set() for each key individually,
	 * since it only writes to disk once.
	 */
	public setBatch(entries: Record<string, T | undefined>): Thenable<void> {
		const changedKeys: string[] = []
		let externalKeys: string[] = []
		try {
			withFileLock(this.fsPath, () => {
				// Another process may have written since this instance last read.
				externalKeys = this.adoptDisk()
				for (const [key, value] of Object.entries(entries)) {
					if (value === undefined) {
						if (key in this.data) {
							delete this.data[key]
							changedKeys.push(key)
						}
					} else {
						this.data[key] = value
						changedKeys.push(key)
					}
				}
				if (changedKeys.length > 0) {
					this.writeToDisk()
				}
			})
		} catch (error) {
			Logger.error(`[${this.name}] failed to write to ${this.fsPath}:`, error)
		}
		for (const key of changedKeys) {
			this.fireChange(key)
		}
		// A key set here is this instance's own change, whatever the disk held.
		this.fireExternalChange(externalKeys.filter((key) => !(key in entries)))
		return Promise.resolve()
	}

	protected _keys(): readonly string[] {
		return Object.keys(this.data)
	}

	/**
	 * The file's contents, `{}` when there is no file yet, and undefined when
	 * it could not be read. Unreadable is not empty: a caller that treated it
	 * as empty would write a file holding nothing but its own keys.
	 */
	private readFromDisk(): Record<string, T> | undefined {
		try {
			if (!fs.existsSync(this.fsPath)) {
				return {}
			}
			const parsed = JSON.parse(fs.readFileSync(this.fsPath, "utf-8"))
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed
			}
			Logger.error(`[${this.name}] ${this.fsPath} does not hold an object`)
		} catch (error) {
			Logger.error(`[${this.name}] failed to read from ${this.fsPath}:`, error)
		}
		return undefined
	}

	/** Replace this instance's copy with the disk's; returns the keys that differed. */
	private adoptDisk(): string[] {
		const disk = this.readFromDisk()
		if (!disk) {
			return []
		}
		const changed: string[] = []
		for (const key of new Set([...Object.keys(this.data), ...Object.keys(disk)])) {
			if (JSON.stringify(this.data[key]) !== JSON.stringify(disk[key])) {
				changed.push(key)
			}
		}
		this.data = disk
		return changed
	}

	private fireExternalChange(keys: readonly string[]): void {
		if (keys.length === 0) {
			return
		}
		for (const subscriber of this.externalSubscribers) {
			try {
				subscriber(keys)
			} catch (error) {
				Logger.error(`[${this.name}] external change subscriber error:`, error)
			}
		}
	}

	private writeToDisk(): void {
		const dir = path.dirname(this.fsPath)
		fs.mkdirSync(dir, { recursive: true })
		atomicWriteFileSync(this.fsPath, JSON.stringify(this.data, null, 2), this.fileMode)
	}
}

const FILE_LOCK_STALE_MS = 5000
const FILE_LOCK_POLL_MS = 10
const FILE_LOCK_WAIT_MS = 2000
const sleepCell = new Int32Array(new SharedArrayBuffer(4))

function sleepSync(ms: number): void {
	Atomics.wait(sleepCell, 0, 0, ms)
}

/**
 * Run `fn` holding `<filePath>.lock`, so two processes cannot interleave a
 * read-then-write of the same file. Synchronous because the storage API is.
 * A lock left by a process that died is taken over once it is stale, and a
 * lock that cannot be had in time is skipped rather than waited on forever:
 * a state write that is late is worse than one that is unguarded.
 */
function withFileLock(filePath: string, fn: () => void): void {
	const lockPath = `${filePath}.lock`
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	let held = false
	const deadline = Date.now() + FILE_LOCK_WAIT_MS
	for (;;) {
		try {
			fs.closeSync(fs.openSync(lockPath, "wx"))
			held = true
			break
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EPERM") {
				throw error
			}
		}
		if (Date.now() > deadline) {
			Logger.warn(`[ClineFileStorage] could not lock ${filePath}; continuing without it`)
			break
		}
		try {
			if (Date.now() - fs.statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS) {
				fs.unlinkSync(lockPath)
				continue
			}
		} catch {
			// The holder released it between the two calls; the next attempt gets it.
		}
		sleepSync(FILE_LOCK_POLL_MS)
	}
	try {
		fn()
	} finally {
		if (held) {
			try {
				fs.unlinkSync(lockPath)
			} catch {
				// Taken over as stale by another process; nothing to release.
			}
		}
	}
}

/** Windows refuses a rename onto a file another process has open; it clears in milliseconds. */
const RENAME_RETRIES = 5

/**
 * Synchronously, atomically write data to a file using temp file + rename pattern.
 * Prefer core/storage's async atomicWriteFile to this.
 */
function atomicWriteFileSync(filePath: string, data: string, mode?: fs.Mode | undefined): void {
	const tmpPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).substring(7)}.json`
	try {
		fs.writeFileSync(tmpPath, data, {
			flag: "wx",
			encoding: "utf-8",
			mode,
		})
		// Rename temp file to target (atomic in most cases)
		for (let attempt = 1; ; attempt++) {
			try {
				fs.renameSync(tmpPath, filePath)
				break
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code
				if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
					throw error
				}
				sleepSync(20 * attempt)
			}
		}
	} catch (error) {
		// Clean up temp file if it exists
		try {
			fs.unlinkSync(tmpPath)
		} catch {}
		throw error
	}
}
