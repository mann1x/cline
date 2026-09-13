/**
 * A per-file history inside the open transaction.
 *
 * The transaction's base snapshot is one point in time, and `restore_file`
 * could only ever go back to it. That is the whole complaint: a model that
 * has fixed three things and broken the fourth has to choose between keeping
 * the break and throwing away the three (user, 2026-09-13: "restoring to
 * original doesn't work, the model is loosing all the wins or half wins and
 * starts from scratch"). Measured in the same shape on arm p01 -- three
 * transactions, 8 discards, not one kept.
 *
 * So every write to a file appends a revision holding what the file said
 * afterwards, and the model can go back to any of them by number. Revision 1
 * is always the file as the transaction opened, which is what `restore_file`
 * used to be able to do and nothing more.
 *
 * Why per-file and not a tree snapshot per change. `takeSnapshot` walks the
 * whole workspace and reads every file; doing that after each edit would make
 * a 5,000-file repository unusable. A revision is already addressed per file
 * -- the model asks to put *one file* back -- so only the file a tool wrote is
 * captured.
 *
 * Why numbers and not hashes. The audience is a 9B model reading its own
 * conversation. `#4` is orderable, self-describing and cannot be confused with
 * a path; `a3f9c21` is a token this model class invents when it half-remembers
 * one, and a fabricated hash is indistinguishable from a real one until it is
 * refused.
 *
 * Append-only. Restoring to #2 does not renumber anything -- it appends a new
 * revision whose content equals #2. A model re-reads its own history
 * constantly, and a #3 that silently stops meaning what it meant is worse than
 * a larger number.
 */

import { createHash } from "node:crypto";

/** What a file said at one point in the transaction. */
export interface FileRevision {
	/** One-based, in the order they were made. #1 is the transaction's base. */
	readonly index: number;
	/** The content, or nothing when the file did not exist at that point. */
	readonly body: Buffer | undefined;
	readonly hash: string;
	/** What produced it: a tool name, or `transaction open` for #1. */
	readonly by: string;
	readonly lines: number;
	readonly bytes: number;
	/** Content released to stay under the memory cap; the entry remains. */
	readonly dropped: boolean;
	/**
	 * The earliest revision holding exactly these bytes, when it is not this
	 * one.
	 *
	 * Worth surfacing rather than just exploiting. A model that edits, undoes
	 * and edits back to the same text is in the loop this whole feature exists
	 * to break, and its own history is the one place that can show it the shape
	 * of what it has been doing.
	 */
	readonly sameAs?: number;
}

export type RevisionLookup =
	| { kind: "found"; revision: FileRevision }
	| { kind: "untracked" }
	| { kind: "dropped"; index: number }
	| { kind: "unknown"; requested: string; available: readonly number[] };

export interface RevisionLimits {
	/** Content held for one file before the middle is released. */
	maxBytesPerFile?: number;
}

/**
 * Content held per file before revisions start being released.
 *
 * A 4 MB file -- the snapshot's own per-file ceiling -- edited fifty times is
 * 200 MB for one transaction, and a transaction is not the only thing in the
 * process. 32 MB covers the realistic case (a 15 KB source file has room for
 * two thousand revisions) and bounds the pathological one.
 */
export const DEFAULT_MAX_REVISION_BYTES_PER_FILE = 32 * 1024 * 1024;

/**
 * Newest revisions never released, however tight the cap.
 *
 * The two things a model reaches for are "put it back to how it was" and "undo
 * what I just did". The first is #1, which is never released; the second is
 * within the last few, and releasing those would leave `last` pointing at
 * content that is gone.
 */
const KEEP_NEWEST = 5;

/** Revisions listed in a receipt before the middle is elided. */
export const DEFAULT_REVISION_LIST_LIMIT = 10;

/** The name for the transaction's own base revision. */
export const ORIGINAL_REVISION = "original";
/** The state before the most recent change. */
export const LAST_REVISION = "last";

const ABSENT_HASH = "absent";

function hashOf(body: Buffer | undefined): string {
	return body ? createHash("sha256").update(body).digest("hex") : ABSENT_HASH;
}

/**
 * Lines, counted as the reader counts them: a trailing newline ends the last
 * line rather than starting an empty one. The model sees this next to the
 * number `read_files` prints for the same file, and two tools disagreeing
 * about a file's length sends it looking for a line that is not there.
 */
function countLines(body: Buffer | undefined): number {
	if (!body) return 0;
	const text = body.toString("utf8");
	if (text === "") return 0;
	const lines = text.split(/\r\n|\r|\n/);
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

interface MutableRevision {
	index: number;
	hash: string;
	by: string;
	lines: number;
	bytes: number;
	dropped: boolean;
	/** Whether the file existed at all, kept once the body is released. */
	existed: boolean;
	sameAs?: number;
}

/**
 * One copy of each distinct content, however many revisions hold it.
 *
 * The suggestion that produced this (user, 2026-09-13: "maybe it's better to
 * add de-dup to the snapshots? mostly will be the same content"), sharpened by
 * where the duplication actually is. In a per-file log it is not tree-wide --
 * only the file a tool wrote is captured -- it is temporal: a restore writes a
 * version that already exists, and a model that edits, undoes and edits back
 * produces the same bytes over and over. Those are exactly the runs that go
 * long, so the case that costs the most memory is the case dedup answers best.
 *
 * Reference-counted, and shared across files as well as within one, so two
 * files that come to hold the same text cost one copy.
 */
interface Blob {
	body: Buffer;
	refs: number;
}

export interface RevisionLog {
	/** Record the file as the transaction found it. Ignored if already seeded. */
	seed(absolutePath: string, body: Buffer | undefined): void;
	/**
	 * Record what a tool left behind. Returns the new revision, or nothing when
	 * the content is what it already was -- a tool that reported a refusal, or
	 * an edit that replaced text with itself, has not made a revision.
	 */
	record(
		absolutePath: string,
		body: Buffer | undefined,
		by: string,
	): FileRevision | undefined;
	revisions(absolutePath: string): readonly FileRevision[];
	resolve(absolutePath: string, requested: string): RevisionLookup;
	tracked(): readonly string[];
	/** Distinct bytes held for one file, after de-duplication. */
	heldBytes(absolutePath: string): number;
	/** Forget everything. A discard puts the tree back, so the history goes too. */
	reset(): void;
}

/**
 * Read a revision the way a model writes one.
 *
 * Generous on purpose. `#2`, `2`, `rev 2`, `revision 2` and `v2` are all the
 * same request, and refusing four of them teaches nothing except that the tool
 * is fussy. What is NOT accepted is anything that does not name a revision at
 * all -- that comes back as unknown, with the numbers that exist.
 */
function parseRevision(requested: string): number | "original" | "last" | null {
	const text = requested.trim().toLowerCase();
	if (text === "") return null;
	if (text === ORIGINAL_REVISION || text === "base" || text === "first") {
		return "original";
	}
	if (text === LAST_REVISION || text === "previous" || text === "undo") {
		return "last";
	}
	const match = text.match(/^(?:#|v|rev(?:ision)?\s*#?\s*)?(\d+)$/);
	if (!match?.[1]) return null;
	const value = Number(match[1]);
	return Number.isInteger(value) && value > 0 ? value : null;
}

export function createRevisionLog(
	_unused?: unknown,
	limits: RevisionLimits = {},
): RevisionLog {
	const maxBytes =
		limits.maxBytesPerFile ?? DEFAULT_MAX_REVISION_BYTES_PER_FILE;
	const logs = new Map<string, MutableRevision[]>();
	const blobs = new Map<string, Blob>();

	const bodyOf = (entry: MutableRevision): Buffer | undefined =>
		entry.dropped || !entry.existed ? undefined : blobs.get(entry.hash)?.body;

	const frozen = (entry: MutableRevision): FileRevision => ({
		index: entry.index,
		body: bodyOf(entry),
		hash: entry.hash,
		by: entry.by,
		lines: entry.lines,
		bytes: entry.bytes,
		dropped: entry.dropped,
		...(entry.sameAs === undefined ? {} : { sameAs: entry.sameAs }),
	});

	const release = (entry: MutableRevision): void => {
		const blob = blobs.get(entry.hash);
		if (!blob) return;
		blob.refs -= 1;
		if (blob.refs <= 0) blobs.delete(entry.hash);
	};

	/** Distinct bytes a file's live revisions hold between them. */
	const heldBytesOf = (entries: readonly MutableRevision[]): number => {
		const seen = new Set<string>();
		let total = 0;
		for (const entry of entries) {
			if (entry.dropped || !entry.existed || seen.has(entry.hash)) continue;
			seen.add(entry.hash);
			total += entry.bytes;
		}
		return total;
	};

	/**
	 * Release content from the middle until the file is under the cap.
	 *
	 * From the middle outwards rather than oldest-first: the oldest is #1, the
	 * one revision that must survive, and the newest are the ones `last` and a
	 * just-noticed mistake address. What is left is a history with a hole in it
	 * that says where the hole is, which is a better answer than a cap that
	 * refuses to record anything once it is reached.
	 *
	 * A revision whose bytes another live revision also holds is never a
	 * candidate: releasing it would reclaim nothing and lose a restore target
	 * for no gain. That is what makes an oscillating transaction cheap.
	 */
	const enforceCap = (entries: MutableRevision[]): void => {
		const droppable = (index: number): boolean =>
			index > 0 && index < entries.length - KEEP_NEWEST;
		for (;;) {
			if (heldBytesOf(entries) <= maxBytes) return;
			const candidates: number[] = [];
			for (let i = 0; i < entries.length; i += 1) {
				const entry = entries[i];
				if (!entry || entry.dropped || !entry.existed) continue;
				if (!droppable(i)) continue;
				// Only when this entry is the last thing holding the bytes.
				if ((blobs.get(entry.hash)?.refs ?? 0) > 1) continue;
				candidates.push(i);
			}
			if (candidates.length === 0) return;
			// The middle-most, so the hole grows outwards from the least
			// interesting part of the history rather than from one end.
			const pick = candidates[Math.floor(candidates.length / 2)];
			const entry = pick === undefined ? undefined : entries[pick];
			if (!entry) return;
			release(entry);
			entry.dropped = true;
		}
	};

	const append = (
		absolutePath: string,
		body: Buffer | undefined,
		by: string,
	): FileRevision => {
		const entries = logs.get(absolutePath) ?? [];
		const hash = hashOf(body);
		const earlier = entries.find(
			(candidate) => candidate.existed && candidate.hash === hash,
		);
		if (body) {
			const blob = blobs.get(hash);
			if (blob) {
				blob.refs += 1;
			} else {
				blobs.set(hash, { body, refs: 1 });
			}
		}
		const entry: MutableRevision = {
			index: entries.length + 1,
			hash,
			by,
			lines: countLines(body),
			bytes: body?.byteLength ?? 0,
			dropped: false,
			existed: body !== undefined,
			...(earlier ? { sameAs: earlier.index } : {}),
		};
		entries.push(entry);
		logs.set(absolutePath, entries);
		enforceCap(entries);
		return frozen(entry);
	};

	return {
		seed(absolutePath, body) {
			if (logs.has(absolutePath)) return;
			append(absolutePath, body, "transaction open");
		},

		record(absolutePath, body, by) {
			const entries = logs.get(absolutePath);
			if (!entries || entries.length === 0) {
				// Nothing seeded it, so this write is the first thing known about
				// the file. Recording it as #1 would claim the transaction opened
				// with content it never had, so the absence is #1 and the write
				// is #2 -- which is also exactly true of a file the transaction
				// created.
				append(absolutePath, undefined, "transaction open");
			}
			const current = logs.get(absolutePath);
			const newest = current?.[current.length - 1];
			if (newest && newest.hash === hashOf(body)) return undefined;
			return append(absolutePath, body, by);
		},

		revisions(absolutePath) {
			return (logs.get(absolutePath) ?? []).map(frozen);
		},

		resolve(absolutePath, requested) {
			const entries = logs.get(absolutePath);
			if (!entries || entries.length === 0) return { kind: "untracked" };
			const available = entries.map((entry) => entry.index);
			const parsed = parseRevision(requested);
			if (parsed === null) {
				return { kind: "unknown", requested, available };
			}
			let index: number;
			if (parsed === "original") {
				index = 1;
			} else if (parsed === "last") {
				// The state BEFORE the most recent change. The newest revision is
				// what is on disk, so restoring to it would be a no-op every time
				// -- which is not what "revert the last change" means.
				index = Math.max(1, entries.length - 1);
			} else {
				index = parsed;
			}
			const entry = entries[index - 1];
			if (!entry) return { kind: "unknown", requested, available };
			if (entry.dropped) return { kind: "dropped", index: entry.index };
			return { kind: "found", revision: frozen(entry) };
		},

		tracked() {
			return [...logs.keys()];
		},

		heldBytes(absolutePath) {
			return heldBytesOf(logs.get(absolutePath) ?? []);
		},

		reset() {
			logs.clear();
			blobs.clear();
		},
	};
}

/**
 * The history, written for the model rather than for a log file.
 *
 * Stated in full on every read of a covered file, and not only in the receipt
 * for an edit. The ids are useless if they live only in scrollback: run 0295
 * auto-compacted eight times, and a long thrashing run -- the exact run that
 * needs to go back three revisions -- is the one whose early receipts are gone.
 * Re-stating the list makes it recoverable from one call.
 */
export function describeRevisions(
	display: string,
	revisions: readonly FileRevision[],
	options: { limit?: number } = {},
): string {
	if (revisions.length === 0) {
		return `No revisions of \`${display}\` have been recorded in this transaction.`;
	}
	// A file edited forty times would otherwise put forty lines into every
	// receipt. The ends are what get asked for -- #1 and the recent ones -- so
	// the middle is elided and said to be elided, rather than the whole list
	// being dropped once it grows.
	const limit = options.limit ?? DEFAULT_REVISION_LIST_LIMIT;
	const shown: (FileRevision | "gap")[] =
		revisions.length <= limit
			? [...revisions]
			: [
					revisions[0] as FileRevision,
					"gap",
					...revisions.slice(revisions.length - (limit - 1)),
				];
	const lines = shown.map((revision) => {
		if (revision === "gap") {
			const hidden = revisions.length - limit;
			return `  …  ${hidden + 1} older revision${hidden === 0 ? "" : "s"} not listed — ask for one by number`;
		}
		const newest = revision.index === revisions.length;
		const what =
			revision.index === 1
				? `${ORIGINAL_REVISION} (${revision.by})`
				: revision.by;
		const size = revision.body
			? `${revision.lines} line${revision.lines === 1 ? "" : "s"}`
			: revision.index === 1
				? "did not exist"
				: "deleted";
		const notes = [size];
		if (revision.sameAs !== undefined) {
			notes.push(`identical to #${revision.sameAs}`);
		}
		if (revision.dropped) {
			notes.push("content released to save memory — it cannot be restored");
		}
		if (newest) notes.push("on disk now");
		return `  #${revision.index}  ${what} — ${notes.join(", ")}`;
	});
	return [
		`Revisions of \`${display}\` in this transaction:`,
		...lines,
		"",
		`Restore any of them with \`restore_file\` and \`revision\`: a number, \`"${ORIGINAL_REVISION}"\` for #1, or \`"${LAST_REVISION}"\` to undo just the most recent change.`,
	].join("\n");
}
