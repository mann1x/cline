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
	/**
	 * One line saying what this revision is, so the list can be chosen from.
	 *
	 * Without it every entry reads `editor — 136 lines` and the only one
	 * carrying meaning is `#1 original`, which is measurably the only one the
	 * model ever asked for: 132 restores across three runs, 132 to the
	 * original. A number is an address; this is the reason to go to it.
	 *
	 * `model` when the tool call said what it was for, `derived` when we had to
	 * work it out. Never absent — an unlabelled revision is one the model
	 * cannot choose, which is the whole defect.
	 */
	readonly note: string;
	readonly noteSource: "model" | "derived";
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
	/**
	 * Content held across every file before the middle is released.
	 *
	 * The per-file cap alone is only a bound when the log's lifetime is a
	 * transaction, which is short and touches a handful of files. A log that
	 * lives for the session touches as many files as the session does, and 32 MB
	 * each is not a limit — it is a limit per file, multiplied by a number
	 * nobody chose.
	 */
	maxBytesTotal?: number;
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
 * Content held across all files before the oldest is released.
 *
 * 128 MB: four times the per-file cap, so one pathological file cannot starve
 * the rest, and small enough that a session holding the maximum is a number a
 * person would recognise as deliberate rather than a leak. A session editing
 * fifteen-kilobyte source files reaches it after roughly eight thousand
 * revisions, which is not a session.
 */
export const DEFAULT_MAX_REVISION_BYTES_TOTAL = 128 * 1024 * 1024;

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

/** What a caller can say about a revision it is recording. */
export interface RevisionNote {
	/** The model's own words, when the tool call carried them. */
	readonly intent?: string;
	/** What the writing tool reported doing, e.g. "Replaced line 90". */
	readonly summary?: string;
	/** What the checker said about this file afterwards, when it said anything. */
	readonly check?: string;
}

/** Longest note kept. A list of forty of these is read by a 9B model. */
const MAX_NOTE_CHARS = 120;

function tidy(text: string | undefined): string | undefined {
	if (!text) return undefined;
	// One line: these are printed in a list, and a note that wraps to six lines
	// buries the numbers either side of it.
	const flat = text.replace(/\s+/g, " ").trim();
	if (!flat) return undefined;
	return flat.length <= MAX_NOTE_CHARS
		? flat
		: `${flat.slice(0, MAX_NOTE_CHARS - 1)}…`;
}

/**
 * The label, in order of how much it is worth.
 *
 * The model's own sentence first: it is the only source that knows *why*. Then
 * what the tool reported doing, which is always available and always about this
 * edit. The checker's verdict is appended rather than substituted — it says
 * whether things were working at this point, which is a different question from
 * what changed, and for many files it says nothing at all.
 *
 * The line delta is the floor. It is computed from the bytes, so there is
 * always something: a revision nobody described is still "3 lines longer than
 * #4", which is enough to tell two entries apart.
 */
function deriveNote(
	note: RevisionNote | undefined,
	lines: number,
	previousLines: number | undefined,
	existed: boolean,
): { note: string; noteSource: "model" | "derived" } {
	const intent = tidy(note?.intent);
	const summary = tidy(note?.summary);
	const check = tidy(note?.check);
	const delta =
		previousLines === undefined || !existed
			? undefined
			: lines === previousLines
				? "same length"
				: `${lines > previousLines ? "+" : "−"}${Math.abs(lines - previousLines)} lines`;
	const head = intent ?? summary ?? delta ?? (existed ? "written" : "deleted");
	const parts = [head];
	if (intent && summary) parts.push(summary);
	if (check) parts.push(`check: ${check}`);
	return {
		note: tidy(parts.join(" — ")) ?? head,
		noteSource: intent ? "model" : "derived",
	};
}

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
	note: string;
	noteSource: "model" | "derived";
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

/**
 * The revisions a file has, as one short label like `#1–#7`.
 *
 * What the compaction ledger prints beside a file, so the model reading a
 * summary knows the earlier content exists and what to ask for. A range rather
 * than a count because the numbers are the addresses: `3 revisions` leaves the
 * reader to guess whether they are numbered from zero.
 *
 * A single revision is `#1`, never `#1–#1` — a range with nothing in the
 * middle reads as a mistake, and this audience is a small model that will
 * repeat what it reads.
 */
export function revisionSpan(
	revisions: readonly FileRevision[],
): string | undefined {
	const first = revisions[0];
	const last = revisions[revisions.length - 1];
	if (!first || !last) {
		return undefined;
	}
	return last.index > first.index
		? `#${first.index}–#${last.index}`
		: `#${last.index}`;
}

/**
 * What `#1` is, in the two worlds this log lives in.
 *
 * `transaction` is the base snapshot — a rollback can return the whole tree to
 * it. `session` is the file's own content at first touch, which undoes this
 * session's writes to that file and promises nothing about the tree.
 */
export type RevisionOrigin = "transaction" | "session";

const ORIGIN_LABELS: Record<
	RevisionOrigin,
	{ by: string; existed: string; absent: string }
> = {
	transaction: {
		by: "transaction open",
		existed: "the file as this transaction found it",
		absent: "did not exist when this transaction opened",
	},
	session: {
		by: "first seen",
		existed: "the file as it stood before this session first wrote to it",
		absent: "did not exist when this session first wrote to it",
	},
};

export interface RevisionLog {
	/**
	 * Record the file as it was found. Ignored if already seeded.
	 *
	 * `origin` is what `#1` is said to be, and it is not cosmetic: inside a
	 * transaction `#1` is the base the rollback goes back to, and outside one it
	 * is merely what the file said the first time this session wrote to it. The
	 * second is a weaker promise, and a label claiming the first would teach the
	 * model to expect a rollback that cannot happen.
	 */
	seed(
		absolutePath: string,
		body: Buffer | undefined,
		origin?: RevisionOrigin,
	): void;
	/**
	 * Record what a tool left behind. Returns the new revision, or nothing when
	 * the content is what it already was -- a tool that reported a refusal, or
	 * an edit that replaced text with itself, has not made a revision.
	 */
	record(
		absolutePath: string,
		body: Buffer | undefined,
		by: string,
		note?: RevisionNote,
	): FileRevision | undefined;
	revisions(absolutePath: string): readonly FileRevision[];
	resolve(absolutePath: string, requested: string): RevisionLookup;
	tracked(): readonly string[];
	/** Distinct bytes held for one file, after de-duplication. */
	heldBytes(absolutePath: string): number;
	/** Forget everything. A discard puts the tree back, so the history goes too. */
	reset(): void;
	/**
	 * Close the current compaction span and release what the next one cannot use.
	 *
	 * The retention policy, and it is semantic rather than a size. A revision
	 * exists so the ledger in a compaction summary can say "the content is not
	 * here, it is at `#4`", and so the model can go back to it. Both of those
	 * stop being possible two compactions later: the summary that named `#4`
	 * has itself been folded into a newer summary, and nothing the model can
	 * still read mentions it. Holding it after that is holding bytes no one can
	 * address.
	 *
	 * So a file's history survives while it was written inside the last two
	 * spans, and beyond that only while something the model can still see names
	 * it — the summary just written, and the retained tail when there is one.
	 * `keep` is that whitelist, and a file in it is never dropped however old.
	 *
	 * Whole files, not individual revisions. A file written inside the window is
	 * live and its whole history is worth having; one that has not been touched
	 * for two compactions and is named nowhere is not half-interesting. Dropping
	 * revisions out of the middle of a surviving file is what the byte cap does,
	 * for a different reason, and mixing the two would leave histories with
	 * holes that mean two different things.
	 *
	 * Returns how many files it released, for the log line.
	 */
	noteCompaction(keep?: Iterable<string>): number;
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

/**
 * Which version a `restore_file` call asked for, as something that can be said
 * out loud.
 *
 * The chat row that reports a restore has to name its target, and it only has
 * the call's arguments to name it from -- the row is built when the call
 * starts. It used to name none of them: the header was the constant sentence
 * "put this file back as the transaction found it", written when the base was
 * the only place the tool could go. A restore to `#3` was reported as a
 * restore to the base.
 *
 * This goes through `parseRevision`, the same reader the tool itself uses, so
 * the aliases stay one set. Add an alias there and every caller says the right
 * thing without being told.
 */
export type RestoreTarget =
	| { readonly kind: "original" }
	| { readonly kind: "last" }
	| { readonly kind: "numbered"; readonly index: number }
	| { readonly kind: "unreadable"; readonly requested: string };

export function describeRestoreTarget(
	requested: string | undefined | null,
): RestoreTarget {
	const text = typeof requested === "string" ? requested.trim() : "";
	// An absent `revision` is the documented default, not a bad one.
	if (text === "") return { kind: "original" };
	const parsed = parseRevision(text);
	if (parsed === null) return { kind: "unreadable", requested: text };
	if (parsed === "original") return { kind: "original" };
	if (parsed === "last") return { kind: "last" };
	return { kind: "numbered", index: parsed };
}

export function createRevisionLog(
	_unused?: unknown,
	limits: RevisionLimits = {},
): RevisionLog {
	const maxBytes =
		limits.maxBytesPerFile ?? DEFAULT_MAX_REVISION_BYTES_PER_FILE;
	const maxBytesTotal =
		limits.maxBytesTotal ?? DEFAULT_MAX_REVISION_BYTES_TOTAL;
	const logs = new Map<string, MutableRevision[]>();
	const blobs = new Map<string, Blob>();
	// Which compaction span each file was last written in, and which span is
	// open. Per file rather than per revision: the question asked at eviction is
	// "has anything touched this file lately", and a file that has been touched
	// is worth its whole history.
	const lastWrittenSpan = new Map<string, number>();
	let span = 0;

	const bodyOf = (entry: MutableRevision): Buffer | undefined =>
		entry.dropped || !entry.existed ? undefined : blobs.get(entry.hash)?.body;

	const frozen = (entry: MutableRevision): FileRevision => ({
		index: entry.index,
		body: bodyOf(entry),
		hash: entry.hash,
		by: entry.by,
		note: entry.note,
		noteSource: entry.noteSource,
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

	/** Distinct bytes every live revision holds, across all files. */
	const heldBytesTotal = (): number => {
		let total = 0;
		for (const blob of blobs.values()) {
			total += blob.body.length;
		}
		return total;
	};

	/**
	 * Release content from the oldest files until the log is under the cap.
	 *
	 * Across files the ordering that matters is different from the one within
	 * one file. Inside a file the interesting revisions are at the ends — `#1`
	 * to go back to the start, the newest to undo a mistake — so the hole is
	 * punched in the middle. Across files it is recency: a file the session
	 * stopped touching an hour ago is the one whose history is least likely to
	 * be asked for, and unlike a revision index a file has no `#1` that must
	 * survive.
	 *
	 * `#1` of each file is still the last thing to go, because a file whose
	 * base is gone cannot be put back at all, and that is the single operation
	 * this store exists for.
	 */
	const enforceTotalCap = (): void => {
		if (heldBytesTotal() <= maxBytesTotal) return;
		// Oldest-touched first. Map iteration is insertion order, and a file is
		// re-inserted on every write, so this is a least-recently-written walk.
		const order = [...logs.keys()];
		for (const pass of [false, true]) {
			for (const key of order) {
				const entries = logs.get(key);
				if (!entries) continue;
				for (let i = entries.length - 1; i >= 0; i -= 1) {
					// Second pass only: the base revision, once nothing else is
					// left to give.
					if (i === 0 && !pass) continue;
					const entry = entries[i];
					if (!entry || entry.dropped || !entry.existed) continue;
					if ((blobs.get(entry.hash)?.refs ?? 0) > 1) continue;
					release(entry);
					entry.dropped = true;
					if (heldBytesTotal() <= maxBytesTotal) return;
				}
			}
		}
	};

	const append = (
		absolutePath: string,
		body: Buffer | undefined,
		by: string,
		note?: RevisionNote,
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
		const lines = countLines(body);
		const previous = entries[entries.length - 1];
		const labelled = deriveNote(
			note,
			lines,
			previous?.lines,
			body !== undefined,
		);
		const entry: MutableRevision = {
			index: entries.length + 1,
			hash,
			by,
			note: labelled.note,
			noteSource: labelled.noteSource,
			lines,
			bytes: body?.byteLength ?? 0,
			dropped: false,
			existed: body !== undefined,
			...(earlier ? { sameAs: earlier.index } : {}),
		};
		entries.push(entry);
		lastWrittenSpan.set(absolutePath, span);
		// Deleted first so the re-insert moves this file to the end of the map,
		// which is what makes iteration order a least-recently-written walk for
		// `enforceTotalCap`.
		logs.delete(absolutePath);
		logs.set(absolutePath, entries);
		enforceCap(entries);
		enforceTotalCap();
		return frozen(entry);
	};

	return {
		seed(absolutePath, body, origin = "transaction") {
			if (logs.has(absolutePath)) return;
			const labels = ORIGIN_LABELS[origin];
			append(absolutePath, body, labels.by, {
				summary: body === undefined ? labels.absent : labels.existed,
			});
		},

		record(absolutePath, body, by, note) {
			const entries = logs.get(absolutePath);
			if (!entries || entries.length === 0) {
				// Nothing seeded it, so this write is the first thing known about
				// the file. Recording it as #1 would claim the log opened with
				// content the file never had, so the absence is #1 and the write
				// is #2 -- which is also exactly true of a file that was created.
				append(absolutePath, undefined, ORIGIN_LABELS.transaction.by, {
					summary: ORIGIN_LABELS.transaction.absent,
				});
			}
			const current = logs.get(absolutePath);
			const newest = current?.[current.length - 1];
			if (newest && newest.hash === hashOf(body)) return undefined;
			return append(absolutePath, body, by, note);
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
			lastWrittenSpan.clear();
		},

		noteCompaction(keep) {
			span += 1;
			// Two spans: the one just closed and the one before it. A file
			// written in either is still addressable from a summary the model
			// can read, because a summary survives exactly one further
			// compaction before being folded into the next one.
			const cutoff = span - 2;
			if (cutoff < 0) {
				return 0;
			}
			const whitelist = new Set<string>();
			for (const path of keep ?? []) {
				whitelist.add(path);
			}
			let released = 0;
			for (const [path, entries] of [...logs.entries()]) {
				if (whitelist.has(path)) {
					continue;
				}
				if ((lastWrittenSpan.get(path) ?? span) >= cutoff) {
					continue;
				}
				for (const entry of entries) {
					if (!entry.dropped && entry.existed) {
						release(entry);
					}
				}
				logs.delete(path);
				lastWrittenSpan.delete(path);
				released += 1;
			}
			return released;
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
	// Newest first. The model is nearly always asking about something it has
	// just done -- "undo that", "go back to before I broke it" -- and reading
	// ascending meant the answer was at the bottom of a list whose top was the
	// one revision it should reach for least. #1 keeps its place at the end as
	// the floor of the history rather than its headline.
	const limit = options.limit ?? DEFAULT_REVISION_LIST_LIMIT;
	const newestFirst = [...revisions].reverse();
	const oldest = revisions[0] as FileRevision;
	const shown: (FileRevision | "gap")[] =
		revisions.length <= limit
			? newestFirst
			: [...newestFirst.slice(0, limit - 1), "gap", oldest];
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
		// The note on its own line: it is the part being chosen between, and
		// putting it after the size buries it behind three numbers.
		return `  #${revision.index}  ${what} — ${notes.join(", ")}\n        ${revision.note}`;
	});
	return [
		`Revisions of \`${display}\` in this transaction:`,
		...lines,
		"",
		`Restore any of them with \`restore_file\` and \`revision\`: a number, \`"${ORIGINAL_REVISION}"\` for #1, or \`"${LAST_REVISION}"\` to undo just the most recent change.`,
	].join("\n");
}

/** Revisions reported for one search before the list is cut. */
const SEARCH_RESULT_LIMIT = 8;
/** Characters of a matching line shown either side of nothing — the line, trimmed. */
const MATCH_EXCERPT_CHARS = 120;

/**
 * Find the revisions that contain something, so a number can be looked up
 * rather than remembered.
 *
 * The list answers "what are my options"; this answers "which one had the thing
 * I want back". Those are different questions, and only the second one is
 * asked by a model that has just deleted a method and knows exactly what it is
 * looking for. Without it the model's only recourse is to restore candidates
 * one at a time and read the file after each, which spends the restore budget
 * on searching.
 *
 * Notes are searched as well as content: once a revision is labelled with the
 * model's own sentence, "the dBoss brace" is a likelier query than the code.
 */
export function searchRevisions(
	display: string,
	revisions: readonly FileRevision[],
	query: string,
): string {
	const needle = query.trim();
	if (!needle) {
		return `Say what to look for. \`find\` takes the text you want to locate among the revisions of \`${display}\`.`;
	}
	const lower = needle.toLowerCase();
	const hits: { revision: FileRevision; where: string }[] = [];
	for (const revision of revisions) {
		if (revision.note.toLowerCase().includes(lower)) {
			hits.push({ revision, where: "in its note" });
			continue;
		}
		if (!revision.body) continue;
		const text = revision.body.toString("utf8");
		const at = text.toLowerCase().indexOf(lower);
		if (at < 0) continue;
		const line = text.slice(0, at).split(/\r\n|\r|\n/).length;
		const source = text.split(/\r\n|\r|\n/)[line - 1] ?? "";
		const excerpt =
			source.trim().length > MATCH_EXCERPT_CHARS
				? `${source.trim().slice(0, MATCH_EXCERPT_CHARS - 1)}…`
				: source.trim();
		hits.push({ revision, where: `line ${line}: ${excerpt}` });
	}
	if (hits.length === 0) {
		const released = revisions.filter((r) => r.dropped).length;
		const caveat = released
			? ` ${released} revision${released === 1 ? " has" : "s have"} had its content released and could not be searched.`
			: "";
		return `No revision of \`${display}\` in this transaction contains \`${needle}\`.${caveat} The history is below.\n\n${describeRevisions(display, revisions)}`;
	}
	// Newest first: the same reason the list is. What is being looked for is
	// usually the most recent version of it that still worked.
	const ordered = [...hits].reverse().slice(0, SEARCH_RESULT_LIMIT);
	const lines = ordered.map(
		({ revision, where }) =>
			`  #${revision.index}  ${revision.by} — ${revision.lines} line${revision.lines === 1 ? "" : "s"}\n        ${revision.note}\n        ${where}`,
	);
	const more =
		hits.length > ordered.length
			? [`  …  ${hits.length - ordered.length} older match(es) not listed`]
			: [];
	return [
		`${hits.length} of ${revisions.length} revision${revisions.length === 1 ? "" : "s"} of \`${display}\` contain \`${needle}\`:`,
		...lines,
		...more,
		"",
		`Go back to one with \`restore_file\` and \`revision\`, e.g. \`revision: "#${ordered[0]?.revision.index ?? 1}"\`.`,
	].join("\n");
}
