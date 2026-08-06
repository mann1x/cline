/**
 * Deciding whether two reads of the same file saw the same text.
 *
 * Read results are rendered with line numbers — `"  80 | const x = 1"` — and
 * the number is padded to the width of the widest line number *in that read*
 * (see `file-read.ts`). So a read of lines 80-120 renders `" 80 | "` while a
 * whole-file read of a 1000-line file renders `"  80 | "` for the same source
 * line. Hashing the rendered text directly would therefore report "changed"
 * for two reads that saw identical content, which is exactly backwards: the
 * comparison would fail closed and nothing would ever be collapsed.
 *
 * Everything here works on the text *after* the delimiter, keyed by line
 * number, so padding cannot influence the answer.
 */

/** `"  80 | const x = 1"` → line 80, `"const x = 1"`. */
const NUMBERED_LINE = /^\s*(\d+)\s\|\s?(.*)$/;

/**
 * Parse a rendered read result into line number → source text.
 *
 * Lines that do not carry a number are skipped rather than guessed at: a read
 * result also contains headers and truncation markers, and treating those as
 * source would make two reads of the same range compare unequal purely because
 * one of them was truncated somewhere else.
 */
export function parseNumberedLines(content: string): Map<number, string> {
	const lines = new Map<number, string>();
	for (const raw of content.split("\n")) {
		const match = NUMBERED_LINE.exec(raw);
		if (!match) {
			continue;
		}
		lines.set(Number(match[1]), match[2]);
	}
	return lines;
}

/**
 * Whether two reads saw identical text everywhere their ranges overlap.
 *
 * This is the equality witness for collapsing a redundant read. The dangerous
 * case is an edit landing between the two reads: then the later read is the
 * fresh one and the earlier is stale, and collapsing in the wrong direction
 * feeds the model source that no longer exists. Comparing the overlap turns
 * "did the file change?" from an inference into a check — and it catches edits
 * made outside the agent, which scanning the transcript for editor calls
 * cannot.
 *
 * Returns false when the overlap is empty or when either side is missing a
 * line the other has. Both are "cannot prove equal", and the caller must treat
 * an unproven overlap as changed — the whole point is to never collapse on a
 * guess.
 */
export function readOverlapUnchanged(
	earlier: string,
	later: string,
	overlapStart: number,
	overlapEnd: number,
): boolean {
	if (overlapEnd < overlapStart) {
		return false;
	}
	const earlierLines = parseNumberedLines(earlier);
	const laterLines = parseNumberedLines(later);
	for (let line = overlapStart; line <= overlapEnd; line++) {
		const earlierText = earlierLines.get(line);
		const laterText = laterLines.get(line);
		if (earlierText === undefined || laterText === undefined) {
			return false;
		}
		if (earlierText !== laterText) {
			return false;
		}
	}
	return true;
}
