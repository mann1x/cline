/**
 * The revision log, as compaction needs to see it.
 *
 * Two jobs, and they are the two halves of the same bargain. The ledger a
 * summary carries says "the content is not here, it is at `#4`", which is only
 * worth writing if `#4` is still there when the model reads it; and the log
 * only knows which histories are still addressable because compaction tells it
 * what the summary it just wrote names. Neither half works alone.
 *
 * A narrow port rather than the log itself, for the reason `forgetReads` is
 * one: the context extension has no business importing the atomic runtime, and
 * a host that has no revision log at all should be able to leave this out and
 * still compact. Absent, ledger entries say nothing about files -- which is
 * honest, since a wrong revision number is worse than none.
 */

export interface CompactionRevisions {
	/**
	 * The revisions holding a file's content before and after a call, if the
	 * log has them. Fed straight to the tool ledger.
	 */
	revisionsFor(
		filePath: string,
	): { before?: string; after?: string } | undefined;
	/** Every file the log currently holds a history for, as absolute paths. */
	tracked(): readonly string[];
	/**
	 * Close the compaction span and release what the next one cannot use.
	 * `keep` is the whitelist — see `RevisionLog.noteCompaction`.
	 */
	noteCompaction(keep?: Iterable<string>): number;
}

/**
 * Which tracked files the text still refers to.
 *
 * The whitelist that survives eviction. A tracked file counts as named if its
 * **basename** appears in the text at a boundary, and that is the whole rule:
 * the log's keys are absolute because tools resolve before they record, while
 * a summary is prose and names a file however the model wrote it — absolute,
 * workspace-relative, or bare in a sentence. Matching the longest tail of the
 * path first sounds stricter and is not: any longer tail that appears puts a
 * separator immediately before the basename, which is a boundary, so the
 * basename matches in every case the longer one does. The extra comparisons
 * decide nothing, and a rule that looks stricter than it is invites the reader
 * to trust a precision it does not have.
 *
 * It follows that two files sharing a basename are kept or dropped together.
 * That is the safe direction: a file kept that nothing names costs bytes the
 * total cap already bounds and goes at the next compaction anyway, while a
 * file dropped that the summary does name turns `#4` into an address the model
 * will try to restore and cannot — the failure this mechanism exists to avoid.
 *
 * The one thing it will not do is match inside a word. `session.ts` found in
 * `my-session.ts` is a different file, and a rule that cannot tell them apart
 * keeps everything and decides nothing.
 */
export function mentionedPaths(
	text: string,
	tracked: readonly string[],
): ReadonlySet<string> {
	const named = new Set<string>();
	for (const absolutePath of tracked) {
		const basename = absolutePath
			.split(/[\\/]+/)
			.filter(Boolean)
			.pop();
		if (basename && containsAtBoundary(text, basename)) {
			named.add(absolutePath);
		}
	}
	return named;
}

/**
 * Whether `needle` appears in `text` as a name of its own rather than as the
 * end of a longer one.
 *
 * Only the leading edge needs checking. The needle is a file's own name, so
 * whatever follows it -- a quote, a comma, a line break, a closing brace --
 * ends the reference; what would make it the wrong file is a character glued
 * to its front, as in `my-session.ts`. A path separator is not such a
 * character, which is what lets a bare basename stand in for every way of
 * writing the path, escaped JSON and Windows separators included.
 */
function containsAtBoundary(text: string, needle: string): boolean {
	let from = 0;
	for (;;) {
		const at = text.indexOf(needle, from);
		if (at < 0) return false;
		const before = at === 0 ? "" : text[at - 1];
		if (!before || !/[\w.-]/.test(before)) {
			return true;
		}
		from = at + 1;
	}
}

/**
 * Close the compaction span, keeping the histories the new transcript can
 * still reach.
 *
 * The whitelist is read off the compacted messages themselves, which is both
 * halves of what the user asked for in one rule: after a compaction those
 * messages *are* the summary plus the retained tail, so scanning them covers
 * the tail when there is one and needs no special case when there is not.
 *
 * The messages are scanned as JSON rather than as rendered text, deliberately.
 * A path can be named in the summary prose, in the tool ledger appended after
 * it, or in a tool call still sitting in the tail, and those are three
 * different shapes; their serialisation is the one place all three are
 * visible at once.
 */
export function releaseUnreachableRevisions(
	revisions: CompactionRevisions | undefined,
	messages: readonly unknown[],
	logger?: { log(message: string, meta?: Record<string, unknown>): void },
): number {
	if (!revisions) return 0;
	const tracked = revisions.tracked();
	if (tracked.length === 0) return 0;
	const keep = mentionedPaths(JSON.stringify(messages), tracked);
	const released = revisions.noteCompaction(keep);
	if (released > 0) {
		logger?.log("Released file revisions no summary still refers to", {
			released,
			kept: keep.size,
			tracked: tracked.length,
		});
	}
	return released;
}
