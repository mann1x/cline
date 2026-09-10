/**
 * Answer a re-read of a file that has not changed with a pointer, not a copy.
 *
 * Measured on a live pandorum session (1789035782295_5ag8n, cline 4.100.87,
 * ornith 27B): `read_files` was called 33 times, and 31 of those calls were
 * byte-identical -- the whole of `manic_miner.html`, over and over, with edits
 * in between. The results totalled 440,013 characters, roughly 110,000 tokens,
 * against a file of about 14 KB. The run's entire reasoning came to 27,000
 * tokens; four times that was spent re-reading one file.
 *
 * The existing loop guard cannot see this. It counts strikes per signature but
 * only for calls that *fail*, deliberately: re-running a check after each edit
 * is how work gets done, and a success clears the tally. These reads all
 * succeed. It also cannot see it as adjacency -- the longest run of consecutive
 * identical calls in that session was two, because an `editor` call always sat
 * in between.
 *
 * So the test here is neither "it repeated" nor "it failed", but something
 * provable: the bytes coming back are the bytes that already went back. When
 * the content is identical, a second copy carries no information the
 * conversation does not already hold.
 *
 * THE HAZARD, and why the valve exists. "Already in the conversation" stops
 * being true after a compaction: the earlier read may have been summarised
 * away, and a model told "unchanged since you last read it" would then be
 * pointed at something it can no longer see. Rather than reach into the
 * compaction machinery, every `REFRESH_EVERY` repeats serves the real content
 * again. A compacted context recovers on its own within a few calls, while a
 * loop still pays a fraction of what it used to.
 */

import { createHash } from "node:crypto";

/** How often a repeat is answered with the content anyway, compaction insurance. */
export const REFRESH_EVERY = 4;

/** What identifies "the same read": the file and the window asked for. */
export interface ReadKeyParts {
	path: string;
	firstLine: number;
	lastLine: number;
	withLineNumbers: boolean;
}

export interface ReadLedger {
	/**
	 * What to return for this read, or `undefined` to return the content.
	 *
	 * Records the content either way, so the next identical read can be
	 * compared against it.
	 */
	noticeFor(parts: ReadKeyParts, text: string): string | undefined;
}

function keyOf(parts: ReadKeyParts): string {
	return [
		parts.path,
		parts.firstLine,
		parts.lastLine,
		parts.withLineNumbers ? "n" : "-",
	].join(" ");
}

function digest(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * What the model is told instead of the copy.
 *
 * States the fact and the ways forward, because a notice that only says "no"
 * is one a model answers by sending the call again. It names the line count so
 * a model that is lost still learns something from the call.
 */
function describeUnchanged(
	parts: ReadKeyParts,
	attempt: number,
	lineCount: number,
): string {
	const span = lineCount === 1 ? "line" : `${lineCount} lines`;
	return [
		`${parts.path} has not changed since you read it earlier in this conversation, so the content is not repeated here.`,
		"",
		`This is read ${attempt} of the same ${span} with the same arguments. Look back at the earlier read rather than asking for it again: it is the same text, character for character.`,
		"",
		"If you want something specific, ask for the part you want by giving `start_line` and `end_line`. If you are checking whether an edit landed, the edit's own result already said what changed.",
	].join("\n");
}

/**
 * A ledger of what this session has already returned for each read.
 *
 * Per session, not per transaction: the conversation is what holds the earlier
 * copy, and it outlives any one transaction.
 */
export function createReadLedger(): ReadLedger {
	const seen = new Map<string, { hash: string; repeats: number }>();

	return {
		noticeFor(parts, text) {
			const key = keyOf(parts);
			const hash = digest(text);
			const previous = seen.get(key);

			if (!previous || previous.hash !== hash) {
				// First sight, or the file moved under it: this is real news.
				seen.set(key, { hash, repeats: 0 });
				return undefined;
			}

			const repeats = previous.repeats + 1;
			seen.set(key, { hash, repeats });

			// The valve. Serving the content still counts the repeat: a loop
			// must not win a fresh budget by waiting.
			if (repeats % REFRESH_EVERY === 0) {
				return undefined;
			}

			const lineCount = parts.lastLine - parts.firstLine + 1;
			return describeUnchanged(parts, repeats + 1, lineCount);
		},
	};
}
