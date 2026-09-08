import fs from "node:fs"
import path from "node:path"

/**
 * A file the Cline log can be read out of while the window is still running.
 *
 * The output channel is not that file. VS Code buffers the channel and only
 * writes `…/exthost/output_logging_<ts>/1-Cline.log` when the extension host
 * restarts, so the current session's log is 0 bytes on disk for as long as you
 * would want to read it. Diagnosing a live run meant reloading the window,
 * which ends the run being diagnosed.
 *
 * So this mirrors every line to `<dataDir>/logs/extension.log` and flushes on
 * an idle timer: a burst is written out as soon as logging goes quiet, and a
 * stream that never goes quiet is still written at least every
 * `maxLatencyMs`. Nothing is held back waiting for a buffer to fill.
 */

/** Wait after the last line before writing. Long enough to coalesce a burst. */
const DEFAULT_IDLE_MS = 750

/** Write anyway after this long, so a continuous stream is never withheld. */
const DEFAULT_MAX_LATENCY_MS = 5_000

/** Rotate past this size, keeping one previous file. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

export interface LogFileSinkOptions {
	/** Directory to write into. Created if missing. */
	directory: string
	fileName?: string
	idleMs?: number
	maxLatencyMs?: number
	maxBytes?: number
}

export interface LogFileSink {
	write(line: string): void
	/** Write everything buffered now. Resolves once it is on disk. */
	flush(): Promise<void>
	dispose(): Promise<void>
}

export function createLogFileSink(options: LogFileSinkOptions): LogFileSink {
	const filePath = path.join(options.directory, options.fileName ?? "extension.log")
	const idleMs = options.idleMs ?? DEFAULT_IDLE_MS
	const maxLatencyMs = options.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES

	let buffer: string[] = []
	let idleTimer: NodeJS.Timeout | undefined
	let deadlineTimer: NodeJS.Timeout | undefined
	// Appends are chained rather than issued concurrently: two overlapping
	// appends to the same file can interleave partial writes, and a log whose
	// lines are spliced together is worse than a late one.
	let pending: Promise<void> = Promise.resolve()
	let disposed = false

	function clearTimers(): void {
		if (idleTimer) {
			clearTimeout(idleTimer)
			idleTimer = undefined
		}
		if (deadlineTimer) {
			clearTimeout(deadlineTimer)
			deadlineTimer = undefined
		}
	}

	function schedule(): void {
		if (idleTimer) {
			clearTimeout(idleTimer)
		}
		idleTimer = setTimeout(() => void flush(), idleMs)
		idleTimer.unref?.()
		if (!deadlineTimer) {
			deadlineTimer = setTimeout(() => void flush(), maxLatencyMs)
			deadlineTimer.unref?.()
		}
	}

	async function rotateIfNeeded(): Promise<void> {
		try {
			const stat = await fs.promises.stat(filePath)
			if (stat.size < maxBytes) {
				return
			}
			await fs.promises.rm(`${filePath}.1`, { force: true })
			await fs.promises.rename(filePath, `${filePath}.1`)
		} catch {
			// No file yet, or a rotation lost a race with another window. Either
			// way the append below is still the right next step.
		}
	}

	async function writeChunk(chunk: string): Promise<void> {
		try {
			await fs.promises.mkdir(options.directory, { recursive: true })
			await rotateIfNeeded()
			await fs.promises.appendFile(filePath, chunk, "utf8")
		} catch {
			// A log sink that throws would take down whatever was being logged.
		}
	}

	function flush(): Promise<void> {
		clearTimers()
		if (buffer.length === 0) {
			return pending
		}
		const chunk = `${buffer.join("\n")}\n`
		buffer = []
		pending = pending.then(() => writeChunk(chunk))
		return pending
	}

	return {
		write(line: string): void {
			if (disposed) {
				return
			}
			buffer.push(line)
			schedule()
		},
		flush,
		async dispose(): Promise<void> {
			disposed = true
			await flush()
			clearTimers()
		},
	}
}
