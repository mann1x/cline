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

export function createReadReceipts(): ReadReceipts {
	const seen = new Map<string, Span[]>();
	const retired = new Set<string>();
	const stamps = new Map<string, FileStamp>();
	// Keyed the same way, but holding the path as it was resolved: the key is
	// lowercased on Windows and is no use to anyone reading it back.
	const originals = new Map<string, string>();

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
			if (seen.delete(key)) {
				retired.add(key);
			}
		},

		retire(filePath) {
			const key = receiptKey(filePath);
			if (seen.delete(key)) {
				retired.add(key);
			}
		},

		noteStamp(filePath, stamp) {
			if (stamp === undefined) {
				return;
			}
			stamps.set(receiptKey(filePath), stamp);
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
		},

		paths() {
			return [...originals.values()];
		},
	};
}
