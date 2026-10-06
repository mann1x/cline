/**
 * One librarian call that reads files, as the person watching sees it.
 *
 * Reading a book is minutes: every page of a PDF, every scanned page through
 * recognition. A row that sits unchanged for that long reads as a hang, and
 * a real hang looks the same. So the call says where it is, file by file,
 * and says so when a file has stopped moving; it can be cancelled from its
 * row; and however it ends, the model is told what was read, what was left
 * out and why, a line for each.
 */

import * as path from "node:path";
import type { AgentToolContext } from "@cline/shared";
import type { ReadProgress } from "./executors/document/formats";

type FileState = "waiting" | "reading" | "done" | "failed" | "not read";

interface FileEntry {
	file: string;
	name: string;
	state: FileState;
	startedAt?: number;
	endedAt?: number;
	/** When it last moved: a page turned, a stage changed. */
	movedAt?: number;
	progress?: ReadProgress;
	/** What it is doing when that is not reading: "describing pictures". */
	stage?: string;
	/** What it came to, for a file that is done. */
	outcome?: string;
	/** Why it failed, or why it was not read. */
	why?: string;
	/** Everything left out of it, a line each. */
	problems: string[];
}

/** A file that has not moved for this long is said to be stalled. */
const STALLED_AFTER_MS = 60_000;
/** How often the row is refreshed while nothing else changes it. */
const TICK_MS = 5_000;
/** How often where every file stands is written to the log. */
const LOG_EVERY_MS = 60_000;
/** The row is not rewritten more often than this. */
const MIN_EMIT_GAP_MS = 400;

const active = new Set<LibraryImportRun>();
/** The host is described in the log once: what a stalled read ran on. */
let environmentLogged = false;

/**
 * Cancels every librarian call that is reading files. Each one ends as a
 * failed tool call whose error is its full report.
 * @returns how many were cancelled
 */
export function cancelLibraryImports(): number {
	let cancelled = 0;
	for (const run of [...active]) {
		if (run.cancel("cancelled by the user")) cancelled++;
	}
	return cancelled;
}

/** Whether a librarian call is reading files right now. */
export function hasActiveLibraryImports(): boolean {
	return active.size > 0;
}

export class LibraryImportCancelled extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = "LibraryImportCancelled";
	}
}

function duration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function where(entry: FileEntry): string {
	const parts: string[] = [];
	if (entry.progress) {
		parts.push(
			`${entry.progress.unit} ${entry.progress.at} of ${entry.progress.total}`,
		);
		if (entry.progress.activity) parts.push(entry.progress.activity);
		if (entry.progress.pictures > 0) {
			parts.push(
				`${entry.progress.pictures} picture${entry.progress.pictures === 1 ? "" : "s"}`,
			);
		}
	}
	if (entry.stage) parts.push(entry.stage);
	return parts.length ? parts.join(", ") : "opening";
}

export class LibraryImportRun {
	private readonly entries: FileEntry[];
	private readonly controller = new AbortController();
	private readonly startedAt = Date.now();
	private readonly timer: ReturnType<typeof setInterval>;
	private readonly onOuterAbort: () => void;
	private lastEmit = 0;
	private lastLog = Date.now();
	private pendingEmit: ReturnType<typeof setTimeout> | undefined;
	private cancelReason: string | undefined;
	private closed = false;
	private rejectOnCancel: ((error: Error) => void) | undefined;
	private readonly cancelled: Promise<never>;

	constructor(
		private readonly what: string,
		files: readonly string[],
		private readonly context: AgentToolContext | undefined,
		private readonly log?: (message: string) => void,
		/** What an item is called on its line. @default the file's name */
		label: (item: string) => string = (item) => path.basename(item),
	) {
		this.entries = files.map((file) => ({
			file,
			name: label(file),
			state: "waiting" as FileState,
			problems: [],
		}));
		this.cancelled = new Promise<never>((_resolve, reject) => {
			this.rejectOnCancel = reject;
		});
		// Nothing awaits it when the call ends first.
		this.cancelled.catch(() => {});
		this.onOuterAbort = () => {
			this.cancel("the run was stopped");
		};
		if (context?.signal?.aborted) this.onOuterAbort();
		else
			context?.signal?.addEventListener("abort", this.onOuterAbort, {
				once: true,
			});
		this.timer = setInterval(() => this.tick(), TICK_MS);
		(this.timer as { unref?: () => void }).unref?.();
		active.add(this);
		if (!environmentLogged) {
			environmentLogged = true;
			const host = globalThis as Record<string, unknown>;
			const versions = process.versions as Record<string, string | undefined>;
			this.log?.(
				`[library] host: node ${versions.node}, electron ${versions.electron ?? "no"}, process.type ${String((process as { type?: string }).type ?? "none")}, ${process.platform} ${process.arch}; globals: ${["window", "navigator", "Worker", "OffscreenCanvas", "ImageDecoder", "createImageBitmap", "DOMMatrix"].map((name) => `${name}=${typeof host[name]}`).join(" ")}`,
			);
		}
		this.emit(true);
	}

	/** Handed to the reader: it stops at the next page or chapter. */
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	get isCancelled(): boolean {
		return this.cancelReason !== undefined;
	}

	/** @returns false when it was already cancelled or over */
	cancel(reason: string): boolean {
		if (this.closed || this.cancelReason !== undefined) return false;
		this.cancelReason = reason;
		this.log?.(`[library] ${this.what} ${reason}: ${this.standing()}`);
		this.controller.abort(new LibraryImportCancelled(reason));
		this.rejectOnCancel?.(new LibraryImportCancelled(reason));
		return true;
	}

	/**
	 * The work, or the cancellation, whichever is first. A reader notices a
	 * cancellation at its next page; one that is waiting on something that
	 * never answers does not, and the call must still end.
	 */
	guard<T>(work: Promise<T>): Promise<T> {
		// The work goes on by itself when the cancellation wins.
		work.catch(() => {});
		return Promise.race([work, this.cancelled]);
	}

	private entry(file: string): FileEntry | undefined {
		return this.entries.find((entry) => entry.file === file);
	}

	start(file: string): void {
		const entry = this.entry(file);
		if (!entry) return;
		entry.state = "reading";
		entry.startedAt = Date.now();
		entry.movedAt = entry.startedAt;
		this.emit(true);
	}

	progress(file: string, progress: ReadProgress): void {
		const entry = this.entry(file);
		if (!entry) return;
		entry.progress = progress;
		entry.movedAt = Date.now();
		this.emit(false);
	}

	/** A line about a file for the log alone. */
	note(file: string, line: string): void {
		this.log?.(`[library] ${this.entry(file)?.name ?? file}: ${line}`);
	}

	/** What a file is doing after it was read: "describing pictures". */
	stage(file: string, stage: string | undefined): void {
		const entry = this.entry(file);
		if (!entry) return;
		if (entry.state !== "reading") {
			entry.state = "reading";
			entry.endedAt = undefined;
		}
		entry.stage = stage;
		entry.movedAt = Date.now();
		this.emit(true);
	}

	done(file: string, outcome: string, problems: readonly string[] = []): void {
		const entry = this.entry(file);
		if (!entry) return;
		for (const problem of problems) {
			this.log?.(`[library] ${entry.name} left out: ${problem}`);
		}
		entry.state = "done";
		entry.endedAt = Date.now();
		entry.stage = undefined;
		entry.outcome = outcome;
		for (const problem of problems) {
			if (!entry.problems.includes(problem)) entry.problems.push(problem);
		}
		this.emit(true);
	}

	fail(file: string, why: string): void {
		const entry = this.entry(file);
		if (!entry) return;
		this.log?.(`[library] ${entry.name} failed: ${why}`);
		entry.state = "failed";
		entry.endedAt = Date.now();
		entry.why = why;
		this.emit(true);
	}

	private line(entry: FileEntry, now: number): string {
		const took =
			entry.startedAt !== undefined
				? duration((entry.endedAt ?? now) - entry.startedAt)
				: "";
		switch (entry.state) {
			case "waiting":
				return `· ${entry.name}: waiting`;
			case "reading": {
				const quiet = now - (entry.movedAt ?? now);
				return `▶ ${entry.name}: ${where(entry)}, ${took}${quiet >= STALLED_AFTER_MS ? `. NOT MOVING for ${duration(quiet)}` : ""}`;
			}
			case "done":
				return `✓ ${entry.name}: ${entry.outcome ?? "read"}, ${took}${entry.problems.length ? `, ${entry.problems.length} left out` : ""}`;
			case "failed":
				return `✗ ${entry.name}: ${entry.why ?? "failed"}`;
			default:
				return `– ${entry.name}: not read, ${entry.why ?? "the call ended first"}`;
		}
	}

	private counts(): string {
		const count = (state: FileState) =>
			this.entries.filter((entry) => entry.state === state).length;
		const parts = [`${count("done")} of ${this.entries.length} done`];
		if (count("reading")) parts.push(`${count("reading")} in progress`);
		if (count("failed")) parts.push(`${count("failed")} failed`);
		return parts.join(", ");
	}

	/** The row's text: a line of totals, then a line a file. */
	statusText(): string {
		const now = Date.now();
		return [
			`${this.what}: ${this.counts()}, ${duration(now - this.startedAt)}`,
			...this.entries.map((entry) => this.line(entry, now)),
		].join("\n");
	}

	/** Where the files in progress are, for the log and for a cancellation. */
	private standing(): string {
		const now = Date.now();
		const moving = this.entries.filter((entry) => entry.state === "reading");
		if (moving.length === 0) return this.counts();
		return `${this.counts()}; ${moving
			.map(
				(entry) =>
					`${entry.name} at ${where(entry)}, last moved ${duration(now - (entry.movedAt ?? now))} ago`,
			)
			.join("; ")}`;
	}

	private tick(): void {
		const now = Date.now();
		if (now - this.lastLog >= LOG_EVERY_MS) {
			this.lastLog = now;
			this.log?.(`[library] ${this.what}: ${this.standing()}`);
		}
		this.emit(true);
	}

	private emit(now: boolean): void {
		if (this.closed) return;
		const send = () => {
			this.pendingEmit = undefined;
			this.lastEmit = Date.now();
			this.context?.emitUpdate?.({
				status: this.statusText(),
				cancellable: "library-import",
			});
		};
		const wait = MIN_EMIT_GAP_MS - (Date.now() - this.lastEmit);
		if (now || wait <= 0) {
			if (this.pendingEmit) clearTimeout(this.pendingEmit);
			send();
		} else if (!this.pendingEmit) {
			this.pendingEmit = setTimeout(send, wait);
		}
	}

	/**
	 * What happened to every file, for the model: read or not, how far, and
	 * every page and picture that was left out, with the reason.
	 */
	report(): string[] {
		const now = Date.now();
		const lines: string[] = [];
		const problems = this.entries.reduce(
			(total, entry) => total + entry.problems.length,
			0,
		);
		lines.push(
			`REPORT: ${this.counts()}, ${duration(now - this.startedAt)}${problems ? `, ${problems} page(s) or picture(s) left out` : ""}.`,
		);
		for (const entry of this.entries) {
			const took =
				entry.startedAt !== undefined
					? ` (${duration((entry.endedAt ?? now) - entry.startedAt)})`
					: "";
			if (entry.state === "done") {
				lines.push(`- ${entry.name}: ${entry.outcome ?? "read"}${took}`);
			} else if (entry.state === "failed") {
				lines.push(
					`- ${entry.name}: FAILED, ${entry.why ?? "no reason"}${took}`,
				);
			} else if (entry.state === "reading") {
				lines.push(
					`- ${entry.name}: NOT FINISHED, it was at ${where(entry)} and had last moved ${duration(now - (entry.movedAt ?? now))} before the call ended${took}`,
				);
			} else {
				lines.push(
					`- ${entry.name}: NOT READ, ${entry.why ?? "the call ended before its turn"}`,
				);
			}
			for (const problem of entry.problems)
				lines.push(`    left out: ${problem}`);
		}
		return lines;
	}

	/** The error a cancelled call ends with: why, and the whole report. */
	cancellation(extra: readonly string[] = []): Error {
		return new Error(
			[
				`${this.what} was cancelled: ${this.cancelReason ?? "cancelled"}. It is not complete; do not report it as done. Tell the user what the report below says and ask how to go on.`,
				...extra,
				...this.report(),
			].join("\n"),
		);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		clearInterval(this.timer);
		if (this.pendingEmit) clearTimeout(this.pendingEmit);
		this.context?.signal?.removeEventListener("abort", this.onOuterAbort);
		active.delete(this);
		this.log?.(`[library] ${this.what} ended: ${this.standing()}`);
	}
}
