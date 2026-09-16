/**
 * What the transcript said before a compaction replaced it.
 *
 * Compaction is the one operation in this runtime that destroys its own input.
 * Every other thing the model does to state is recoverable — an edit has a
 * revision, a transaction has a base snapshot, a file has the disk — and the
 * transcript had nothing. If the summary came back wrong, or thin, or about the
 * wrong half of the session, the turns it stood for were already gone and the
 * only evidence that anything had been lost was the model's later behaviour.
 *
 * That is tolerable while a recency tail survives, because the tail is a
 * fallback in itself. It stops being tolerable the moment the summary *is* the
 * context: a bad no-tail compaction is terminal, and this is the configuration
 * an experiment elsewhere reportedly had to withdraw.
 *
 * So the messages are kept. In memory, per session, bounded, and never on the
 * wire — a journal that reached the model would be the transcript it exists to
 * replace.
 *
 * **Why not disk.** A transcript holds file contents, command output, and
 * whatever the user typed; writing it somewhere durable is a new place for that
 * to leak from and a new thing to clean up. The lifetime that matters is the
 * session, and the session lives in memory.
 *
 * **Why bounded, and bounded by entries rather than bytes.** The entries are
 * whole transcripts, so the cap is small: two. That is what `restore` needs —
 * the state before the compaction that just ran, and the one before that, so a
 * generation-2 summary built on a bad generation-1 summary can be unwound past
 * both. Anything older is a transcript the session has already worked from for
 * several turns, and restoring to it would discard more than it recovered.
 */

import type { MessageWithMetadata } from "@cline/shared";

/** One compaction, and what it replaced. */
export interface CompactionJournalEntry {
	/** 1-based, matching the summary message's own generation. */
	generation: number;
	/** The transcript as it stood before this compaction ran. */
	before: readonly MessageWithMetadata[];
	/** Messages it produced, for reporting what the trade actually was. */
	afterMessageCount: number;
	/** Which strategy wrote it, so a restore can say what it is undoing. */
	strategy: string;
	/** Whether a recency tail survived. A no-tail entry is the risky one. */
	keptRecentMessages: boolean;
	at: number;
}

/** How many pre-compaction transcripts are held. See the module comment. */
export const COMPACTION_JOURNAL_DEPTH = 2;

export interface CompactionJournal {
	record(entry: Omit<CompactionJournalEntry, "at">): void;
	/** The most recent entry, or the one at `generation` when given. */
	latest(generation?: number): CompactionJournalEntry | undefined;
	/**
	 * The transcript to go back to, undoing the last compaction.
	 *
	 * Returns the messages rather than applying them: what to do with a restored
	 * transcript is the caller's decision — a host may want to confirm it, and
	 * the runtime may want to re-run compaction with different settings rather
	 * than simply put the oversized transcript back.
	 */
	restore(generation?: number): readonly MessageWithMetadata[] | undefined;
	entries(): readonly CompactionJournalEntry[];
	clear(): void;
}

export function createCompactionJournal(
	depth: number = COMPACTION_JOURNAL_DEPTH,
): CompactionJournal {
	const kept = Math.max(1, Math.floor(depth));
	let entries: CompactionJournalEntry[] = [];

	return {
		record(entry) {
			entries.push({ ...entry, at: Date.now() });
			if (entries.length > kept) {
				entries = entries.slice(-kept);
			}
		},

		latest(generation) {
			if (generation === undefined) {
				return entries[entries.length - 1];
			}
			return entries.find((entry) => entry.generation === generation);
		},

		restore(generation) {
			return this.latest(generation)?.before;
		},

		entries() {
			return entries;
		},

		clear() {
			entries = [];
		},
	};
}
