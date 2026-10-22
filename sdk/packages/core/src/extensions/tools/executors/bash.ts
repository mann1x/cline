/**
 * Bash Executor
 *
 * Built-in implementation for running shell commands using Node.js spawn.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	createWriteStream,
	type Dirent,
	existsSync,
	mkdtempSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	type AgentToolContext,
	getDefaultShell,
	getShellInvocation,
} from "@cline/shared";
import {
	type ProcessStartTokenProbeResult,
	probeProcessStartTokenAsync,
} from "../../../runtime/process-start-token";
import { TimeoutError } from "../helpers";
import type { ShellExecutor } from "../types";
import {
	MAX_COMMAND_OUTPUT_CHARS,
	truncateCommandOutput,
} from "./output-limits";
import { fileStampFor, type ReadReceipts } from "./read-receipts";
import type { RunCommandExecutionController } from "./run-command-execution-controller";

const MAX_DETACHED_LOG_BYTES = 10 * 1024 * 1024;
const DEFAULT_DETACHED_LOG_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_ACTIVE_COMMAND_POLL_INTERVAL_MS = 60_000;
const DETACHED_LOG_DIRECTORY_PREFIX = "cline-command-";
const DETACHED_LOG_FILENAME = "output.log";
const DETACHED_LOG_ACTIVE_COMMAND_FILENAME = "active-command.json";
const DETACHED_LOG_COMPLETED_FILENAME = "completed-at";
const COMMAND_PROGRESS_FLUSH_INTERVAL_MS = 48;
/**
 * How long the executor waits after the shell process exits for its stdio
 * streams to close before completing a command whose background children
 * still hold the pipes open.
 */
const EXIT_STREAM_GRACE_MS = 1_000;

type CommandProgressStream = "stdout" | "stderr";

export type ProcessStartTokenProbe = (
	pid: number,
) => ProcessStartTokenProbeResult | Promise<ProcessStartTokenProbeResult>;

export interface DetachedCommandLogCleanupOptions {
	tempDirectory?: string;
	retentionMs?: number;
	nowMs?: number;
	processStartTokenProbe?: ProcessStartTokenProbe;
	activeCommandPollIntervalMs?: number;
}

type DetachedCommandMarker = {
	version: 1;
	executionId: string;
	pid: number;
	processStartToken: string;
	detachedAtMs: number;
};

function resolveDetachedLogRetentionMs(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(0, value)
		: DEFAULT_DETACHED_LOG_RETENTION_MS;
}

function resolveActiveCommandPollIntervalMs(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.max(1, value)
		: DEFAULT_ACTIVE_COMMAND_POLL_INTERVAL_MS;
}

type ResolvedDetachedCommandLogCleanupOptions = {
	retentionMs: number;
	nowMs: number;
	probeProcessStartToken: ProcessStartTokenProbe;
	activeCommandPollIntervalMs: number;
};

function parseDetachedCommandMarker(
	text: string,
): DetachedCommandMarker | undefined {
	try {
		const marker = JSON.parse(text) as Partial<DetachedCommandMarker>;
		if (
			marker.version !== 1 ||
			typeof marker.executionId !== "string" ||
			marker.executionId.length === 0 ||
			!Number.isSafeInteger(marker.pid) ||
			(marker.pid ?? 0) <= 0 ||
			typeof marker.processStartToken !== "string" ||
			marker.processStartToken.length === 0 ||
			typeof marker.detachedAtMs !== "number" ||
			!Number.isFinite(marker.detachedAtMs) ||
			marker.detachedAtMs < 0
		) {
			return undefined;
		}
		return marker as DetachedCommandMarker;
	} catch {
		return undefined;
	}
}

function writeLifecycleMarker(path: string, text: string): void {
	const temporaryPath = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, text, "utf8");
		try {
			renameSync(temporaryPath, path);
		} catch (error) {
			// Windows does not replace an existing destination atomically. Existing
			// lifecycle markers are only replaced when corrupt, so remove that
			// unusable generation before installing the valid one.
			if (
				error instanceof Error &&
				"code" in error &&
				["EEXIST", "EPERM"].includes(
					String((error as NodeJS.ErrnoException).code),
				)
			) {
				rmSync(path, { force: true });
				renameSync(temporaryPath, path);
			} else {
				throw error;
			}
		}
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

function parseCompletedAtMs(
	text: string | undefined,
	nowMs: number,
): number | undefined {
	const normalized = text?.trim();
	if (!normalized) return undefined;
	const value = Number(normalized);
	if (!Number.isFinite(value) || value < 0) return undefined;
	// Clock rollback or corrupt future timestamps must not retain a log beyond
	// one full inspection window from this reconciliation.
	return Math.min(value, nowMs);
}

async function readOptionalTextFile(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return undefined;
		}
		throw error;
	}
}

async function reconcileDetachedCommandLogDirectory(
	directory: string,
	options: ResolvedDetachedCommandLogCleanupOptions,
): Promise<boolean> {
	const activeCommandPath = join(
		directory,
		DETACHED_LOG_ACTIVE_COMMAND_FILENAME,
	);
	const completedAtPath = join(directory, DETACHED_LOG_COMPLETED_FILENAME);
	const completedAtText = await readOptionalTextFile(completedAtPath);
	let retentionStartedAtMs = parseCompletedAtMs(completedAtText, options.nowMs);
	const activeCommandText = await readOptionalTextFile(activeCommandPath);
	if (retentionStartedAtMs !== undefined) {
		// Completion is written before the active marker is removed. Treat it as
		// authoritative after a host crash between those two operations.
		if (activeCommandText !== undefined) {
			await rm(activeCommandPath, { force: true });
		}
	} else if (activeCommandText !== undefined) {
		const marker = parseDetachedCommandMarker(activeCommandText);
		if (marker) {
			let probe: ProcessStartTokenProbeResult;
			try {
				probe = await options.probeProcessStartToken(marker.pid);
			} catch {
				// Custom identity providers can fail by rejecting instead of returning
				// an explicit unavailable result. Preserve the same conservative
				// lifecycle semantics and keep polling in either case.
				probe = { status: "unavailable" };
			}
			if (
				probe.status === "found" &&
				probe.token === marker.processStartToken
			) {
				// The detached command, rather than the host that launched it, owns the
				// active lifecycle. Matching both PID and kernel start token prevents a
				// later process that reuses the PID from extending this log's lifetime.
				scheduleActiveCommandLogReconciliation(directory, options);
				return false;
			}
			if (probe.status === "unavailable") {
				// An unavailable identity provider is not evidence that the command
				// exited. Keep the advertised log and retry until the provider can
				// prove either the same identity, a replacement process, or absence.
				scheduleActiveCommandLogReconciliation(directory, options);
				return false;
			}
		}
		// A missing process, mismatched identity, or malformed marker begins
		// bounded retention. Never fall back to PID-only polling.
		writeLifecycleMarker(completedAtPath, String(options.nowMs));
		await rm(activeCommandPath, { force: true });
		retentionStartedAtMs = options.nowMs;
	}

	if (retentionStartedAtMs === undefined) {
		// Logs without lifecycle markers use their last write as a best-effort
		// fallback so malformed or interrupted state cannot accumulate forever.
		try {
			retentionStartedAtMs = (
				await stat(join(directory, DETACHED_LOG_FILENAME))
			).mtimeMs;
		} catch {
			retentionStartedAtMs = (await stat(directory)).mtimeMs;
		}
	}
	const cutoffMs = options.nowMs - options.retentionMs;
	if (retentionStartedAtMs > cutoffMs) {
		scheduleDetachedLogCleanup(
			directory,
			Math.max(0, retentionStartedAtMs + options.retentionMs - options.nowMs),
		);
		return false;
	}
	await rm(directory, { recursive: true, force: true });
	return true;
}

function scheduleActiveCommandLogReconciliation(
	directory: string,
	options: ResolvedDetachedCommandLogCleanupOptions,
	delayMs = options.activeCommandPollIntervalMs,
): void {
	const timer = setTimeout(() => {
		void reconcileDetachedCommandLogDirectory(directory, {
			...options,
			nowMs: Date.now(),
		}).catch(() => undefined);
	}, delayMs);
	timer.unref();
}

/**
 * Reaps completed detached command logs outside the retention window,
 * schedules retained logs for their remaining lifetime, and follows active
 * command identities until they exit. Local runtime hosts call this at startup
 * so cleanup survives host exits and restarts instead of depending only on the
 * process that launched the command.
 */
export async function cleanupStaleDetachedCommandLogs(
	options: DetachedCommandLogCleanupOptions = {},
): Promise<number> {
	const tempDirectory = options.tempDirectory ?? tmpdir();
	const retentionMs = resolveDetachedLogRetentionMs(options.retentionMs);
	const nowMs = options.nowMs ?? Date.now();
	const probeProcessStartToken =
		options.processStartTokenProbe ?? probeProcessStartTokenAsync;
	const activeCommandPollIntervalMs = resolveActiveCommandPollIntervalMs(
		options.activeCommandPollIntervalMs,
	);
	let entries: Dirent[];
	try {
		entries = await readdir(tempDirectory, { withFileTypes: true });
	} catch {
		return 0;
	}

	let removed = 0;
	for (const entry of entries) {
		if (
			!entry.isDirectory() ||
			!entry.name.startsWith(DETACHED_LOG_DIRECTORY_PREFIX)
		) {
			continue;
		}
		const directory = join(tempDirectory, entry.name);
		try {
			if (
				await reconcileDetachedCommandLogDirectory(directory, {
					retentionMs,
					nowMs,
					probeProcessStartToken,
					activeCommandPollIntervalMs,
				})
			) {
				removed += 1;
			}
		} catch {
			// Cleanup is best effort: one inaccessible or concurrently removed log
			// must not prevent the Hub from starting or other logs from being reaped.
		}
	}
	return removed;
}

export class CommandExitError extends Error {
	constructor(
		readonly exitCode: number,
		readonly output: string,
	) {
		super(`Command exited with code ${exitCode}`);
		this.name = "CommandExitError";
	}
}

function commandCompletionMessage(
	code: number | null,
	signal: NodeJS.Signals | null,
): string {
	if (code !== null) return `Command exited with code ${code}`;
	return signal
		? `Command terminated by signal ${signal}`
		: "Command terminated without an exit code";
}

/** The process terminated without a numeric exit code, usually by signal. */
export class CommandTerminationError extends Error {
	constructor(
		readonly signal: NodeJS.Signals | null,
		readonly output: string,
	) {
		super(commandCompletionMessage(null, signal));
		this.name = "CommandTerminationError";
	}
}

/**
 * The shell process could not be started, so the command never ran and there
 * is no exit code. `code` carries the operating system error libuv reported —
 * `ENOENT`, `EACCES`, `EFTYPE` for a file that is not a valid executable — so
 * a host can count "the shell is missing" separately from "the command
 * failed" without parsing the message.
 *
 * `ENOENT` alone is ambiguous: spawn reports it both when the executable is
 * not found and when the working directory no longer exists, with the same
 * message. `missing` settles it by checking the directory at failure time, so
 * "shell not on PATH" and "workspace folder gone" stay separately countable.
 */
export class CommandSpawnError extends Error {
	readonly code: string | undefined;
	/** For `ENOENT`, which path was absent. Undefined for every other code. */
	readonly missing: "executable" | "cwd" | undefined;

	constructor(cause: Error, options: { cwd?: string } = {}) {
		super(`Failed to execute command: ${cause.message}`);
		this.name = "CommandSpawnError";
		const code = (cause as NodeJS.ErrnoException).code;
		this.code = typeof code === "string" ? code : undefined;
		if (this.code !== "ENOENT") {
			this.missing = undefined;
		} else if (options.cwd !== undefined && !existsSync(options.cwd)) {
			this.missing = "cwd";
		} else {
			this.missing = "executable";
		}
	}
}

/**
 * Options for the shell executor
 */
/**
 * Files re-stamped after a command before the sweep gives up.
 *
 * One `stat` each, so this is a fraction of a millisecond for any realistic
 * session. The bound exists for the session that has read thousands of files,
 * where the sweep would start to cost more than the answer is worth — and
 * where the answer is least useful anyway, since a list of two hundred changed
 * files tells the model nothing it can act on.
 */
const MAX_SWEPT_FILES = 512;

/**
 * Which of the files the model has looked at did this command change?
 *
 * The free half of the concurrency work. A shell command is the largest hole
 * in the read-before-edit guard: `run_commands` can rewrite anything —
 * a formatter, a codemod, `git checkout`, a build that regenerates a source
 * file, a stray redirect — and none of it appears in the conversation as an
 * edit. Every heuristic for reading that off the command line is a parser for
 * an unbounded language, and wrong in the direction that matters: it misses.
 *
 * Asking the filesystem instead needs no heuristic at all. The set to check is
 * already known — the files this session has read — and comparing their stamps
 * before and after is exact for every command, including the ones nobody
 * thought of.
 *
 * Only tracked files are swept, and that is the right scope rather than a
 * limitation: a file the model has never read is one it holds no stale belief
 * about, so there is nothing to correct.
 */
async function sweepTrackedFiles(
	receipts: ReadReceipts,
	paths: readonly string[],
	overlay: ShellExecutorOptions["overlay"],
): Promise<string[]> {
	const changed: string[] = [];
	for (const filePath of paths.slice(0, MAX_SWEPT_FILES)) {
		const stamp = await fileStampFor(filePath, overlay);
		if (receipts.changedSince(filePath, stamp)) {
			changed.push(filePath);
			// The spans are wrong now whatever the command was, so the next edit
			// is held until the model has looked again.
			receipts.retire(filePath);
		}
		receipts.noteStamp(filePath, stamp);
	}
	return changed;
}

/**
 * Say what the command did to the files the model was holding.
 *
 * Attributed to the command rather than to "something outside this session",
 * unlike the reader's notice: the model ran this itself, and telling it
 * otherwise would send it looking for a culprit that is in its own transcript.
 */
function describeSweptFiles(changed: readonly string[]): string {
	const list = changed.map((file) => `  - ${file}`).join("\n");
	const count =
		changed.length === 1
			? "1 file you had read"
			: `${changed.length} files you had read`;
	return [
		`NOTE: this command changed ${count}:`,
		list,
		"",
		"What you remember of these files is out of date. Read any of them again before editing it — earlier line numbers may now point at different code.",
	].join("\n");
}

export interface ShellExecutorOptions {
	/**
	 * Shell to use for execution
	 * @default "/bin/bash" on Unix, "powershell" on Windows
	 */
	shell?: string;

	/**
	 * Timeout for command execution in milliseconds
	 * @default 30000 (30 seconds)
	 */
	timeoutMs?: number;

	/**
	 * Maximum output kept, in characters. Output beyond this is
	 * middle-truncated: the head and tail are preserved and the middle is
	 * elided, since build and test failures usually live at the end of the
	 * output.
	 * @default 48_000 — see MAX_COMMAND_OUTPUT_CHARS in output-limits.ts
	 */
	maxOutputChars?: number;

	/**
	 * @deprecated Misnamed — the limit was always enforced in characters,
	 * not bytes. Use {@link maxOutputChars}; this alias is honored when
	 * maxOutputChars is not set.
	 */
	maxOutputBytes?: number;

	/**
	 * Environment variables to add/override
	 */
	env?: Record<string, string>;

	/**
	 * Whether to combine stdout and stderr
	 * @default true
	 */
	combineOutput?: boolean;

	/**
	 * The session's read receipts, so a command's effect on files the model has
	 * read can be reported back — see {@link sweepTrackedFiles}.
	 *
	 * Omit it and the executor behaves exactly as it did: no sweep, no stat, no
	 * note. The shell does not need receipts to run a command; it needs them to
	 * say what the command did to what the model believes.
	 */
	receipts?: ReadReceipts;

	/**
	 * A delegated agent's overlay, so the sweep above stamps the agent's copy
	 * of a file rather than the workspace file its commands no longer write.
	 * Only resolving is needed: the command itself runs through `wrapSpawn`.
	 */
	overlay?: { resolveRead(filePath: string): Promise<string> };

	/**
	 * Optional host-scoped controller that can release an in-flight command
	 * from its tool call while continuing to drain output to a bounded log.
	 */
	executionController?: RunCommandExecutionController;

	/**
	 * Transform the resolved spawn just before it runs. A delegated agent uses
	 * this to root the command tree at its sandbox launcher, so the command and
	 * every process it spawns read and write the agent's overlay rather than the
	 * workspace. Absent for the lead, whose commands run directly.
	 */
	wrapSpawn?: (spec: {
		executable: string;
		args: string[];
		cwd: string;
		env: Record<string, string>;
	}) => {
		executable: string;
		args: string[];
		cwd: string;
		env: Record<string, string>;
	};

	/**
	 * How long a completed detached command log remains available before its
	 * temporary directory is removed.
	 *
	 * @default 24 hours
	 */
	detachedLogRetentionMs?: number;

	/** Process identity provider used to enable safe command detachment. */
	processStartTokenProbe?: ProcessStartTokenProbe;
}

interface SpawnConfig {
	executable: string;
	args: string[];
	cwd: string;
	env: Record<string, string>;
	/** Names removed from the inherited environment; see ShellExecutionOptions. */
	withhold?: readonly string[];
	input?: string;
}

/**
 * The child's environment: the parent's, minus what is withheld, plus what this
 * command was given.
 *
 * The order matters. Withholding is applied to the *inherited* names only, so a
 * command that asked for a credential still gets it even though the same name
 * was stripped a line earlier -- that is the whole point of asking.
 */
function buildChildEnv(config: SpawnConfig): NodeJS.ProcessEnv {
	if (!config.withhold || config.withhold.length === 0) {
		return { ...process.env, ...config.env };
	}
	const inherited: NodeJS.ProcessEnv = { ...process.env };
	for (const name of config.withhold) {
		delete inherited[name];
	}
	return { ...inherited, ...config.env };
}

/**
 * Collects stream output with bounded memory: the first half of the budget
 * is kept verbatim, the rest rolls so the latest output always survives.
 */
function createRollingCollector(maxChars: number) {
	const headLimit = Math.ceil(maxChars / 2);
	const tailLimit = Math.max(1, maxChars - headLimit);
	// StringDecoder keeps multibyte UTF-8 sequences split across stream
	// chunks intact instead of corrupting them at chunk boundaries.
	const decoder = new StringDecoder("utf8");
	let head = "";
	let tail = "";
	let totalChars = 0;

	const appendText = (text: string): void => {
		if (!text) return;
		totalChars += text.length;
		const headRoom = headLimit - head.length;
		if (headRoom > 0) {
			head += text.slice(0, headRoom);
			tail = (tail + text.slice(headRoom)).slice(-tailLimit);
			return;
		}
		tail = (tail + text).slice(-tailLimit);
	};

	return {
		append(data: Buffer): string {
			const text = decoder.write(data);
			appendText(text);
			return text;
		},
		current() {
			return {
				text: head + tail,
				totalChars,
				dropped: totalChars > head.length + tail.length,
			};
		},
		snapshot() {
			// Flush bytes the decoder buffered for an incomplete multibyte
			// sequence at end-of-stream; otherwise the final characters of
			// non-ASCII output are silently dropped.
			const finalChunk = decoder.end();
			appendText(finalChunk);
			return {
				text: head + tail,
				totalChars,
				dropped: totalChars > head.length + tail.length,
				finalChunk,
			};
		},
	};
}

/**
 * Coalesces high-volume process output before it enters the runtime event
 * pipeline. Each stream keeps only a bounded pending tail and produces at
 * most one update per flush interval, preventing a noisy child process from
 * creating an unbounded queue of Hub and websocket events.
 */
function createCommandProgressEmitter(
	context: AgentToolContext,
	executionId: string,
	isDetachable: () => boolean,
	maxOutputChars: number,
) {
	const emitUpdate = context.emitUpdate;
	const maxPendingChars =
		typeof maxOutputChars === "number" && Number.isFinite(maxOutputChars)
			? Math.max(
					1,
					Math.floor(Math.min(MAX_COMMAND_OUTPUT_CHARS, maxOutputChars)),
				)
			: MAX_COMMAND_OUTPUT_CHARS;
	let pending: Partial<
		Record<CommandProgressStream, { chunk: string; droppedChars: number }>
	> = {};
	let streamOrder: CommandProgressStream[] = [];
	let flushTimer: NodeJS.Timeout | undefined;
	let stopped = false;

	const clearFlushTimer = () => {
		if (!flushTimer) return;
		clearTimeout(flushTimer);
		flushTimer = undefined;
	};

	const flush = () => {
		clearFlushTimer();
		if (!emitUpdate) {
			pending = {};
			streamOrder = [];
			return;
		}
		const buffered = pending;
		const order = streamOrder;
		pending = {};
		streamOrder = [];
		for (const stream of order) {
			const entry = buffered[stream];
			if (!entry?.chunk) continue;
			const marker =
				entry.droppedChars > 0
					? `\u001b[0m[${entry.droppedChars} command-output characters skipped while streaming]\n`
					: "";
			const markerFits = marker.length < maxPendingChars;
			const chunk = markerFits
				? marker + entry.chunk.slice(-(maxPendingChars - marker.length))
				: entry.chunk.slice(-maxPendingChars);
			emitUpdate({
				stream,
				chunk,
				executionId,
				detachable: isDetachable(),
				...(entry.droppedChars > 0
					? { truncated: true, droppedChars: entry.droppedChars }
					: {}),
			});
		}
	};

	const scheduleFlush = () => {
		if (!emitUpdate || flushTimer || stopped) return;
		flushTimer = setTimeout(flush, COMMAND_PROGRESS_FLUSH_INTERVAL_MS);
		flushTimer.unref();
	};

	return {
		append(stream: CommandProgressStream, text: string): void {
			if (!emitUpdate || stopped || !text) return;
			let entry = pending[stream];
			if (!entry) {
				entry = { chunk: "", droppedChars: 0 };
				pending[stream] = entry;
				streamOrder.push(stream);
			}
			if (text.length >= maxPendingChars) {
				entry.droppedChars +=
					entry.chunk.length + text.length - maxPendingChars;
				entry.chunk = text.slice(-maxPendingChars);
			} else {
				const overflow = entry.chunk.length + text.length - maxPendingChars;
				if (overflow > 0) {
					entry.droppedChars += overflow;
					entry.chunk = entry.chunk.slice(overflow);
				}
				entry.chunk += text;
			}
			scheduleFlush();
		},
		flush,
		stop(options: { flush?: boolean } = {}): void {
			if (stopped) return;
			if (options.flush) {
				flush();
			} else {
				clearFlushTimer();
				pending = {};
				streamOrder = [];
			}
			stopped = true;
		},
	};
}

function scheduleDetachedLogCleanup(
	directory: string,
	retentionMs: number,
): void {
	const cleanupTimer = setTimeout(() => {
		void rm(directory, { recursive: true, force: true }).catch(() => undefined);
	}, retentionMs);
	cleanupTimer.unref();
}

/** Exported for its own tests: the order of its writes is the contract. */
export function createDetachedLog(
	retentionMs: number,
	marker: DetachedCommandMarker,
) {
	const directory = mkdtempSync(join(tmpdir(), DETACHED_LOG_DIRECTORY_PREFIX));
	const path = join(directory, DETACHED_LOG_FILENAME);
	const activeCommandPath = join(
		directory,
		DETACHED_LOG_ACTIVE_COMMAND_FILENAME,
	);
	const completedAtPath = join(directory, DETACHED_LOG_COMPLETED_FILENAME);
	try {
		writeLifecycleMarker(activeCommandPath, `${JSON.stringify(marker)}\n`);
	} catch (error) {
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
	const stream = createWriteStream(path, { encoding: "utf8" });
	let bytesWritten = 0;
	let capped = false;
	let writable = true;
	let streamClosed = false;
	let completed = false;
	let cleanupScheduled = false;
	const scheduleCleanup = () => {
		if (cleanupScheduled) return;
		cleanupScheduled = true;
		scheduleDetachedLogCleanup(directory, retentionMs);
	};
	stream.on("error", () => {
		// The detached command has already released its caller. A late log write
		// failure must not become an unhandled stream error in the hub process.
		writable = false;
	});
	// The marker says the log is whole, so it is written once the log's last
	// write has reached the file, not when it was queued. Written first, a
	// reader that waits for it could read the log without the exit line still
	// in the stream's buffer -- under load, for seconds (ol-112). A host that
	// dies in between leaves the active marker, which the startup reaper
	// resolves by probing the process.
	let marked = false;
	const markCompleted = () => {
		if (marked) return;
		marked = true;
		try {
			writeLifecycleMarker(completedAtPath, String(Date.now()));
		} catch {
			// The startup reaper can fall back to the output timestamp if the
			// completion marker cannot be persisted.
		}
		try {
			rmSync(activeCommandPath, { force: true });
		} catch {
			// Cleanup remains best effort and must not surface from a stream event.
		}
	};
	stream.once("close", () => {
		writable = false;
		streamClosed = true;
		if (completed) {
			// A stream that failed never finishes; it still closes.
			markCompleted();
			scheduleCleanup();
		}
	});

	const complete = () => {
		if (completed) return;
		completed = true;
		if (streamClosed) {
			markCompleted();
			scheduleCleanup();
			return;
		}
		writable = false;
		stream.end(markCompleted);
	};

	return {
		path,
		write(text: string): void {
			if (!text || capped || !writable) return;
			const remaining = MAX_DETACHED_LOG_BYTES - bytesWritten;
			if (remaining <= 0) {
				capped = true;
				writable = false;
				stream.end();
				return;
			}
			const data = Buffer.from(text, "utf8");
			const accepted =
				data.length <= remaining ? data : data.subarray(0, remaining);
			stream.write(accepted);
			bytesWritten += accepted.length;
			if (
				accepted.length < data.length ||
				bytesWritten >= MAX_DETACHED_LOG_BYTES
			) {
				capped = true;
				writable = false;
				stream.end();
			}
		},
		complete,
	};
}

function spawnAndCollect(
	config: SpawnConfig,
	context: AgentToolContext,
	timeoutMs: number,
	maxOutputChars: number,
	combineOutput: boolean,
	detachedLogRetentionMs: number,
	executionController?: RunCommandExecutionController,
	processStartTokenProbe: ProcessStartTokenProbe = probeProcessStartTokenAsync,
): Promise<string> {
	if (context.signal?.aborted) {
		return Promise.reject(new Error("Command was aborted"));
	}
	return new Promise((resolve, reject) => {
		const isWindows = process.platform === "win32";

		const child = spawn(config.executable, config.args, {
			cwd: config.cwd,
			env: buildChildEnv(config),
			stdio: ["pipe", "pipe", "pipe"],
			detached: !isWindows,
			// Prevent a console window from flashing on Windows when the
			// parent process has no console (or a different console).
			// No-op on non-Windows platforms.
			windowsHide: true,
		});
		const childPid = child.pid;

		const stdout = createRollingCollector(maxOutputChars);
		const stderr = createRollingCollector(maxOutputChars);
		const executionId = randomUUID();
		const supportsDetachment = Boolean(
			executionController && context.sessionId,
		);
		let detachable = false;
		let processStartToken: string | undefined;
		let killed = false;
		let settled = false;
		let settledOnExitGrace = false;
		let exitStreamGraceTimer: NodeJS.Timeout | undefined;
		let detached = false;
		let detachedLog: ReturnType<typeof createDetachedLog> | undefined;
		let unregisterExecution = () => {};
		const progress = createCommandProgressEmitter(
			context,
			executionId,
			() => detachable,
			maxOutputChars,
		);

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		const killProcessTree = async (): Promise<void> => {
			if (!childPid) return;
			if (isWindows) {
				await new Promise<void>((done) => {
					let finished = false;
					let killer: ReturnType<typeof spawn>;
					const finish = () => {
						if (finished) return;
						finished = true;
						clearTimeout(watchdog);
						done();
					};
					try {
						killer = spawn(
							"taskkill.exe",
							["/PID", String(childPid), "/T", "/F"],
							{ stdio: "ignore", shell: false, windowsHide: true },
						);
					} catch {
						child.kill();
						done();
						return;
					}
					const watchdog = setTimeout(() => {
						killer.kill();
						child.kill();
						finish();
					}, 5_000);
					killer.once("error", () => {
						child.kill();
						finish();
					});
					killer.once("close", (code) => {
						if (code !== 0) child.kill();
						finish();
					});
				});
				return;
			}
			try {
				process.kill(-childPid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		};

		let timeout: NodeJS.Timeout;
		const abortHandler = () => killAndReject(new Error("Command was aborted"));
		const cleanup = () => {
			clearTimeout(timeout);
			if (exitStreamGraceTimer) {
				clearTimeout(exitStreamGraceTimer);
			}
			context.signal?.removeEventListener("abort", abortHandler);
			unregisterExecution();
		};
		const killAndReject = (error: Error) => {
			if (killed || settled) return;
			killed = true;
			progress.stop({ flush: true });
			cleanup();
			void killProcessTree().finally(() => settle(() => reject(error)));
		};

		timeout = setTimeout(
			() =>
				killAndReject(
					new TimeoutError(`Command timed out after ${timeoutMs}ms`, timeoutMs),
				),
			timeoutMs,
		);

		if (context.signal) {
			context.signal.addEventListener("abort", abortHandler, { once: true });
			if (context.signal.aborted) abortHandler();
		}

		const detach = (): boolean => {
			if (
				!detachable ||
				killed ||
				settled ||
				!childPid ||
				child.exitCode !== null ||
				child.signalCode !== null
			) {
				return false;
			}
			if (!processStartToken) return false;
			const log = createDetachedLog(detachedLogRetentionMs, {
				version: 1,
				executionId,
				pid: childPid,
				processStartToken,
				detachedAtMs: Date.now(),
			});
			progress.stop({ flush: true });
			detached = true;
			detachedLog = log;
			const currentOut = stdout.current();
			const currentErr = stderr.current();
			detachedLog.write(currentOut.text);
			if (currentErr.text) {
				detachedLog.write(`\n[stderr]\n${currentErr.text}`);
			}
			cleanup();
			child.unref();
			(
				child.stdout as (typeof child.stdout & { unref?: () => void }) | null
			)?.unref?.();
			(
				child.stderr as (typeof child.stderr & { unref?: () => void }) | null
			)?.unref?.();
			const notice = [
				`[Command is still running. Output will continue in ${detachedLog.path}]`,
				combineOutput
					? currentOut.text +
						(currentErr.text ? `\n[stderr]\n${currentErr.text}` : "")
					: currentOut.text,
			]
				.filter(Boolean)
				.join("\n");
			settle(() => resolve(notice));
			return true;
		};

		child.once("spawn", () => {
			if (killed) return;
			context.emitUpdate?.({
				stream: "stdout",
				chunk: "",
				executionId,
				detachable: false,
			});
			const sessionId = context.sessionId;
			if (
				!supportsDetachment ||
				!childPid ||
				!sessionId ||
				!executionController
			) {
				return;
			}
			void (async () => {
				const probe = await processStartTokenProbe(childPid);
				if (
					probe.status !== "found" ||
					killed ||
					settled ||
					child.exitCode !== null ||
					child.signalCode !== null
				) {
					return;
				}
				processStartToken = probe.token;
				detachable = true;
				unregisterExecution = executionController.register({
					executionId,
					sessionId,
					toolCallId: context.toolCallId,
					detach,
				});
				context.emitUpdate?.({
					stream: "stdout",
					chunk: "",
					executionId,
					detachable: true,
				});
			})().catch(() => undefined);
		});

		child.stdout?.on("data", (data: Buffer) => {
			const chunk = stdout.append(data);
			if (!chunk) return;
			if (detached) {
				detachedLog?.write(chunk);
				return;
			}
			progress.append("stdout", chunk);
		});

		child.stderr?.on("data", (data: Buffer) => {
			const chunk = stderr.append(data);
			if (!chunk) return;
			if (detached) {
				detachedLog?.write(chunk);
				return;
			}
			progress.append("stderr", chunk);
		});

		// Shared completion path for 'close' (stdio drained) and the
		// exit-grace fallback below: snapshot the collectors, flush the final
		// decoder chunks, and settle with the exit code or signal. `trailingNote` is
		// appended after truncation so it always reaches the caller.
		const completeCommand = (
			code: number | null,
			signal: NodeJS.Signals | null,
			trailingNote: string,
		) => {
			const out = stdout.snapshot();
			const err = stderr.snapshot();
			if (out.finalChunk) {
				progress.append("stdout", out.finalChunk);
			}
			if (err.finalChunk) {
				progress.append("stderr", err.finalChunk);
			}
			progress.stop({ flush: true });
			cleanup();

			if (code !== 0) {
				let failureOutput = combineOutput
					? out.text + (err.text ? `\n[stderr]\n${err.text}` : "")
					: out.text;
				const dropped = out.dropped || (combineOutput && err.dropped);
				const totalChars = combineOutput
					? out.totalChars + err.totalChars
					: out.totalChars;
				if (dropped || failureOutput.length > maxOutputChars) {
					failureOutput = truncateCommandOutput(failureOutput, {
						maxChars: maxOutputChars,
						totalChars,
					});
				}
				const notice = `[${commandCompletionMessage(code, signal)}]`;
				const result =
					failureOutput.length > 0 ? `${notice}\n${failureOutput}` : notice;
				const output = trailingNote ? `${result}\n${trailingNote}` : result;
				settle(() =>
					reject(
						code === null
							? new CommandTerminationError(signal, output)
							: new CommandExitError(code, output),
					),
				);
			} else {
				let output = combineOutput
					? out.text + (err.text ? `\n[stderr]\n${err.text}` : "")
					: out.text;
				const dropped = out.dropped || (combineOutput && err.dropped);
				if (dropped || output.length > maxOutputChars) {
					const totalChars = combineOutput
						? out.totalChars + err.totalChars
						: out.totalChars;
					output = truncateCommandOutput(output, {
						maxChars: maxOutputChars,
						totalChars,
					});
				}
				settle(() =>
					resolve(trailingNote ? `${output}\n${trailingNote}` : output),
				);
			}
		};

		child.on("close", (code, signal) => {
			if (killed || settledOnExitGrace) return;

			const out = stdout.snapshot();
			const err = stderr.snapshot();
			if (detached) {
				// The log is finalized here; the exit-grace timer must not
				// double-write it later.
				if (exitStreamGraceTimer) {
					clearTimeout(exitStreamGraceTimer);
				}
				detachedLog?.write(out.finalChunk);
				detachedLog?.write(err.finalChunk);
				detachedLog?.write(`\n[${commandCompletionMessage(code, signal)}]\n`);
				detachedLog?.complete();
				return;
			}
			completeCommand(code, signal ?? null, "");
		});

		// 'close' fires only once the stdio streams have drained. A command
		// that backgrounds a child (`cmd &`, Start-Process, nohup) leaves the
		// inherited pipe write-ends held open, so after the shell itself exits
		// 'close' never arrives and the command would hang until the timeout
		// kills the whole tree — even though the command, like a prompt
		// returning in an interactive terminal, actually finished (GitHub
		// #12417). When the process has exited and the streams stay open past
		// a grace period, settle with the exit code and the output collected
		// so far, and release the stream handles so the host process is not
		// kept alive by the orphaned pipes. Output still trickling in after
		// the grace belongs to the background processes and is intentionally
		// not awaited; a command whose own final output needs more than the
		// grace to drain after exit is rare, and its collected output is
		// preserved up to that point. A detached command gets the same
		// treatment for its log: without this, a detached shell that exits
		// while a descendant holds the pipes would leave the log forever in
		// the active state, waiting for a 'close' that never comes.
		child.on("exit", (code, signal) => {
			if (killed) return;
			exitStreamGraceTimer = setTimeout(() => {
				if (killed || settledOnExitGrace) return;
				if (detached) {
					// Write the exit record and complete the log here instead
					// of leaving it for the startup reaper to retire as stale.
					const out = stdout.snapshot();
					const err = stderr.snapshot();
					detachedLog?.write(out.finalChunk);
					detachedLog?.write(err.finalChunk);
					detachedLog?.write(`\n[${commandCompletionMessage(code, signal)}]\n`);
					detachedLog?.complete();
					return;
				}
				if (settled) return;
				settledOnExitGrace = true;
				(
					child.stdout as (typeof child.stdout & { unref?: () => void }) | null
				)?.unref?.();
				(
					child.stderr as (typeof child.stderr & { unref?: () => void }) | null
				)?.unref?.();
				child.unref();
				completeCommand(
					code,
					signal ?? null,
					"[Command completed with background processes still running; their output is no longer captured]",
				);
			}, EXIT_STREAM_GRACE_MS);
		});

		child.on("error", (error) => {
			if (killed) return;
			if (detached) {
				detachedLog?.write(`\n[Command failed: ${error.message}]\n`);
				detachedLog?.complete();
				return;
			}
			progress.stop({ flush: true });
			cleanup();
			settle(() => reject(new CommandSpawnError(error, { cwd: config.cwd })));
		});

		child.stdin?.on("error", (error) => {
			if (killed || settled) return;
			killAndReject(
				new Error(`Failed to write command input: ${error.message}`),
			);
		});
		child.stdin?.end(config.input, "utf8");
	});
}

/**
 * Create a shell executor using Node.js spawn
 *
 * @example
 * ```typescript
 * const shell = createShellExecutor({
 *   timeoutMs: 60000, // 1 minute timeout
 *   shell: "/bin/zsh",
 * })
 *
 * const output = await shell("ls -la", "/path/to/project", context)
 * ```
 */
export function createShellExecutor(
	options: ShellExecutorOptions = {},
): ShellExecutor {
	const {
		shell = getDefaultShell(process.platform),
		timeoutMs = 30000,
		env = {},
		combineOutput = true,
		executionController,
		processStartTokenProbe = probeProcessStartTokenAsync,
		receipts,
		overlay,
		wrapSpawn,
	} = options;
	const detachedLogRetentionMs = resolveDetachedLogRetentionMs(
		options.detachedLogRetentionMs,
	);
	const maxOutputChars =
		options.maxOutputChars ??
		options.maxOutputBytes ??
		MAX_COMMAND_OUTPUT_CHARS;

	return async (command, cwd, context, callOptions) => {
		// Spawn without a shell only when the args key is present (even
		// empty), marking input the caller already split. An object with no
		// args key, like { command: "echo hello" }, holds a full command
		// line, and spawning that string as an executable fails with ENOENT.
		// Same key-presence rule as the VS Code host's formatCommandForTerminal.
		const directExec = typeof command !== "string" && "args" in command;
		const invocation = directExec
			? { executable: command.command, args: command.args ?? [] }
			: getShellInvocation(
					shell,
					typeof command === "string" ? command : command.command,
				);
		// Snapshotted before the command runs, because the command can add
		// files to the set and a file this session has never read is not one it
		// can be holding a stale view of.
		const tracked = receipts?.paths() ?? [];
		// The per-call environment wins over the executor's own: it is the
		// caller saying "this command, and only this one, needs these". Both are
		// merged over `process.env` at spawn, so the child is the only place
		// either exists.
		const baseSpec = {
			executable: invocation.executable,
			args: invocation.args,
			cwd,
			env: callOptions?.env ? { ...env, ...callOptions.env } : env,
		};
		// A delegated agent roots the whole command tree at the sandbox launcher,
		// so the command and everything it spawns reads and writes the overlay.
		const spec = wrapSpawn ? wrapSpawn(baseSpec) : baseSpec;
		const output = await spawnAndCollect(
			{
				executable: spec.executable,
				args: spec.args,
				cwd: spec.cwd,
				env: spec.env,
				withhold: callOptions?.withhold,
				input: invocation.input,
			},
			context,
			timeoutMs,
			maxOutputChars,
			combineOutput,
			detachedLogRetentionMs,
			executionController,
			processStartTokenProbe,
		);
		if (!receipts || tracked.length === 0) {
			return output;
		}
		const changed = await sweepTrackedFiles(receipts, tracked, overlay);
		return changed.length === 0
			? output
			: `${output}\n\n${describeSweptFiles(changed)}`;
	};
}
