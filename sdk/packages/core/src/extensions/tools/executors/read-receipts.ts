// Records what the model has actually looked at, so an edit cannot be aimed at
// a line it has never seen.
//
// Measured on a live session repairing a dense single-file game: eight
// consecutive `editor` calls and not one `read_files` call. The model addressed
// lines 84-98 from a context summary written several turns earlier, its own
// edits grew the file from ~120 lines to 440, and by the end that range named
// unrelated code — which it then overwrote. Diagnostics went 2 → 20 and the
// class under repair ended up in the file three times.
//
// Every edit in that session was avoidable at the first one: the model had
// never read the file in this session at all.
//
// Two rules, both narrow on purpose:
//
//  - An edit that names line numbers requires a read that covered those lines.
//    "Read the file somewhere" is not enough; the range being changed is the
//    range that has to have been seen.
//  - A write that changes the file's line count retires the receipts for that
//    file. Line numbers below the edit have moved, so what the model read is no
//    longer where it read it. A write that leaves the count alone keeps them:
//    nothing shifted, and forcing a re-read after every in-place edit would
//    cost a turn for no information.
//
// Both rules are about *this* session moving the ground under itself. The
// stamps below are about somebody else moving it: a second agent, a background
// task, a shell command, or the user in their editor. Those cases look
// identical to the model — the file it read is not the file on disk — but they
// cannot be detected from the conversation at all, only by asking the
// filesystem what the file is now and comparing it to what it was when this
// session last looked.

import { stat } from "node:fs/promises";

/**
 * What the filesystem said about a file the last time this session saw it.
 *
 * Size and modification time, not a content hash, and that is the deciding
 * property rather than a shortcut: it costs one `stat` instead of a read, so
 * the *write* path can check it before doing any work and a 4 MB file is as
 * cheap as an empty one. A hash would mean reading every file before every
 * edit to answer a question that is almost always "nothing happened".
 *
 * Nanosecond precision, because millisecond is not enough: a same-length
 * rewrite inside one millisecond is an ordinary thing for a script to do, and
 * the whole point here is catching writes this session did not make.
 *
 * `absent` is a real value, not a failure: a file appearing or disappearing
 * under the session is exactly the kind of change worth reporting. Failure is
 * `undefined`, which never compares unequal to anything — a stamp that cannot
 * be taken must not be allowed to invent a change.
 */
export type FileStamp = string;

const ABSENT_STAMP: FileStamp = "absent";

export async function readFileStamp(
	filePath: string,
): Promise<FileStamp | undefined> {
	try {
		const info = await stat(filePath, { bigint: true });
		return `${info.size}:${info.mtimeNs}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
			return ABSENT_STAMP;
		}
		return undefined;
	}
}

/** A span of lines the model has seen, inclusive at both ends. */
interface Span {
	first: number;
	last: number;
}

export interface ReadReceipts {
	/** Record that `filePath` was read over the given inclusive line span. */
	noteRead(filePath: string, first: number, last: number): void;
	/** Whether a read has covered every line in the inclusive range. */
	covers(filePath: string, first: number, last: number): boolean;
	/** Whether the file has been read at all in this session. */
	hasAny(filePath: string): boolean;
	/**
	 * Whether the file was ever read, counting reads a write has since retired.
	 *
	 * For an edit anchored to text rather than to line numbers. Retirement is
	 * about line numbers having moved, and a text match does not use them: the
	 * file itself is checked for the text at the moment of the edit, so a read
	 * whose line numbers went stale is still a model that has seen this file.
	 *
	 * Measured: a model read the file, made two edits that changed its length,
	 * and its next text-anchored edit was refused with "has not been read in
	 * this session" -- of a file it had read and just successfully edited.
	 */
	hasEverRead(filePath: string): boolean;
	/**
	 * Whether reads of this file were retired by a later write.
	 *
	 * Told apart from "never read" because the two need different advice: one
	 * model has to go and look, the other looked and had the ground move.
	 */
	wasRetired(filePath: string): boolean;
	/**
	 * Record a write. When the line count changed, receipts for the file are
	 * dropped: every line number below the edit now points somewhere else.
	 */
	noteWrite(filePath: string, linesBefore: number, linesAfter: number): void;
	/**
	 * Record what the filesystem said about the file, as of now.
	 *
	 * Called by every tool that reads a file and by every tool that writes one,
	 * the latter *after* its write — otherwise the session's own edit is
	 * indistinguishable from someone else's and the next call bounces on it.
	 * `undefined` records nothing, so a stat that failed leaves the last known
	 * stamp standing rather than erasing it.
	 */
	noteStamp(filePath: string, stamp: FileStamp | undefined): void;
	/**
	 * Whether the file changed since this session last looked at it.
	 *
	 * False unless there is something to compare: an unknown file has not
	 * changed, it has merely never been seen, and reporting a change there
	 * would fire on the first read of everything.
	 */
	changedSince(filePath: string, stamp: FileStamp | undefined): boolean;
	/**
	 * Retire this file's line spans without forgetting that it was read.
	 *
	 * What {@link noteWrite} does when the line count moved, for the case where
	 * the mover was not this session: the spans are wrong either way, and the
	 * model still needs to be told apart from one that never looked — those two
	 * get different advice.
	 */
	retire(filePath: string): void;
	/** Drop everything known about a file. */
	forget(filePath: string): void;
	/**
	 * Record that a read showed only the first `shown` of a line's `length`
	 * characters.
	 *
	 * A line span alone said the whole line was seen. `read_files` cuts a line
	 * at 2,000 characters, so an edit by column past the cut, or a replace of
	 * the whole line, landed on characters the model was never shown (csf-16).
	 * Optional so a registry that does not track it still compiles; one that
	 * does not answers "not cut" for every line.
	 *
	 * `from` is the first column shown, 1 unless the read showed a window from
	 * the middle of the line, as `grep` does. A record with `from` 1 and
	 * `shown` at `length` says the line was seen whole; it is kept, so a later
	 * window does not narrow what an earlier read showed. Each call replaces
	 * the line's record; {@link noteShown} merges a new read into it.
	 */
	noteCut?(
		filePath: string,
		line: number,
		shown: number,
		length: number,
		from?: number,
	): void;
	/**
	 * Move a file's stamp from `from` to `to`, if `from` is the one held.
	 *
	 * For a rewrite that puts back content the session had already seen: the
	 * change protocol's check against the base writes every edited file twice
	 * and ends where it started, but the mtime moves, and the next edit was
	 * refused as "changed since you last read it". Matching on `from` keeps an
	 * outside write made before the rewrite visible. Optional, like `noteCut`.
	 */
	carryStamp?(filePath: string, from: FileStamp, to: FileStamp): void;
	/** How much of `line` the reads showed, when one of them cut it. */
	cutAt?(filePath: string, line: number): LineCut | undefined;
	/** The lines of a file a read cut short. */
	cutLines?(filePath: string): number[];
	/**
	 * Every file read in this session, in the form it was resolved to.
	 *
	 * The receipts are the only record of which files the model has actually
	 * touched, and they are kept whatever the file's location -- which makes
	 * them the honest answer when a workspace-scoped search cannot find one.
	 * Retired reads are included: a file whose receipts a write invalidated was
	 * still read, and is still where it was.
	 */
	paths(): string[];
}

/**
 * What the reads have shown of one long line: columns `from` (1 when absent)
 * to `shown` of `length`.
 */
export interface LineCut {
	shown: number;
	length: number;
	from?: number;
}

/** Whether a cut leaves nothing of the line unseen. */
export function isWhole(cut: LineCut): boolean {
	return (cut.from ?? 1) <= 1 && cut.shown >= cut.length;
}

/**
 * Record that a read showed columns `from` to `to` of a line of `length`.
 *
 * Merged with what the line's record already holds: a window that overlaps or
 * touches it widens it, so `grep` printing 400 characters of a line
 * `read_files` showed whole leaves it whole. A window apart from it replaces
 * it, as the newer of two views the model holds.
 */
export function noteShown(
	receipts: ReadReceipts | undefined,
	filePath: string,
	line: number,
	from: number,
	to: number,
	length: number,
): void {
	if (!receipts?.noteCut) {
		return;
	}
	const held = receipts.cutAt?.(filePath, line);
	if (held && held.length === length) {
		const heldFrom = held.from ?? 1;
		if (heldFrom <= to + 1 && from <= held.shown + 1) {
			from = Math.min(from, heldFrom);
			to = Math.max(to, held.shown);
		}
	}
	receipts.noteCut(filePath, line, to, length, from);
}

/**
 * A path in the form used to compare two paths for identity.
 *
 * The two sides come from different places — the model types the path into the
 * tool call, and the executor resolves it — and on Windows they routinely
 * differ only in the case of the drive letter. A comparison that misses makes
 * the guard fire on a file that was read, which is the one failure mode that
 * would make it worth turning off.
 */
function receiptKey(filePath: string): string {
	return process.platform === "win32" ? filePath.toLowerCase() : filePath;
}

/**
 * The registry as its owner holds it: everything a reader sees, plus the reset
 * that only the owner may call. An agent's overlay view is a `ReadReceipts`
 * and so cannot clear the lead's reads.
 */
export interface OwnedReadReceipts extends ReadReceipts {
	/**
	 * Forget every read. For the owner of a registry that outlives one task:
	 * the next task has read nothing, and the last task's reads would tell its
	 * first read that the file "changed since you last looked at it" (pandorum,
	 * 2026-10-18, ptm1c) and credit edits to lines it never saw.
	 */
	clear(): void;
}

export function createReadReceipts(): OwnedReadReceipts {
	const seen = new Map<string, Span[]>();
	const retired = new Set<string>();
	const stamps = new Map<string, FileStamp>();
	// Keyed the same way, but holding the path as it was resolved: the key is
	// lowercased on Windows and is no use to anyone reading it back.
	const originals = new Map<string, string>();
	// Lines a read cut short, by line number. Dropped with the spans: once the
	// line numbers move, a cut names some other line.
	const cuts = new Map<string, Map<number, LineCut>>();

	return {
		noteRead(filePath, first, last) {
			if (!Number.isFinite(first) || first < 1) {
				return;
			}
			const span: Span = {
				first: Math.max(1, Math.floor(first)),
				// An unbounded read (no end_line) covers the rest of the file.
				last: Number.isFinite(last)
					? Math.floor(last)
					: Number.POSITIVE_INFINITY,
			};
			if (span.last < span.first) {
				return;
			}
			const key = receiptKey(filePath);
			const spans = seen.get(key) ?? [];
			spans.push(span);
			seen.set(key, spans);
			originals.set(key, filePath);
			retired.delete(key);
		},

		covers(filePath, first, last) {
			const spans = seen.get(receiptKey(filePath));
			if (!spans) {
				return false;
			}
			// A single read has to cover the whole range. Stitching two disjoint
			// reads together would let a model claim it had seen a range it only
			// saw the ends of, which is exactly the mistake being guarded.
			return spans.some((span) => span.first <= first && span.last >= last);
		},

		hasAny(filePath) {
			return (seen.get(receiptKey(filePath))?.length ?? 0) > 0;
		},

		hasEverRead(filePath) {
			const key = receiptKey(filePath);
			return (seen.get(key)?.length ?? 0) > 0 || retired.has(key);
		},

		wasRetired(filePath) {
			return retired.has(receiptKey(filePath));
		},

		noteWrite(filePath, linesBefore, linesAfter) {
			if (linesBefore === linesAfter) {
				return;
			}
			const key = receiptKey(filePath);
			cuts.delete(key);
			if (seen.delete(key)) {
				retired.add(key);
			}
		},

		retire(filePath) {
			const key = receiptKey(filePath);
			cuts.delete(key);
			if (seen.delete(key)) {
				retired.add(key);
			}
		},

		noteCut(filePath, line, shown, length, from = 1) {
			const key = receiptKey(filePath);
			const lines = cuts.get(key) ?? new Map();
			// Kept even when nothing is cut (an edit can leave a line no longer
			// than what was shown of it): a whole line is then known as seen
			// whole, and a later window cannot narrow it.
			lines.set(line, {
				shown: Math.min(shown, length),
				length,
				...(from > 1 ? { from } : {}),
			});
			cuts.set(key, lines);
		},

		cutLines(filePath) {
			return [...(cuts.get(receiptKey(filePath))?.keys() ?? [])];
		},

		cutAt(filePath, line) {
			return cuts.get(receiptKey(filePath))?.get(line);
		},

		noteStamp(filePath, stamp) {
			if (stamp === undefined) {
				return;
			}
			stamps.set(receiptKey(filePath), stamp);
		},

		carryStamp(filePath, from, to) {
			const key = receiptKey(filePath);
			if (stamps.get(key) === from) {
				stamps.set(key, to);
			}
		},

		changedSince(filePath, stamp) {
			if (stamp === undefined) {
				return false;
			}
			const known = stamps.get(receiptKey(filePath));
			return known !== undefined && known !== stamp;
		},

		forget(filePath) {
			const key = receiptKey(filePath);
			seen.delete(key);
			retired.delete(key);
			originals.delete(key);
			stamps.delete(key);
			cuts.delete(key);
		},

		paths() {
			return [...originals.values()];
		},

		clear() {
			seen.clear();
			retired.clear();
			stamps.clear();
			originals.clear();
			cuts.clear();
		},
	};
}
