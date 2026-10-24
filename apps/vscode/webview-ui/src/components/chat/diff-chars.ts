/**
 * Which characters of an edit's removed and added lines are the same text.
 *
 * The diff card coloured every added line green, so an edit that sent its
 * own `old_text` back as `new_text` looked like a change. Measured on
 * pandorum session 1792835223239_4odkd (jackodf-9b): three calls retyping a
 * 387-character line unchanged, refused as no-ops, and nothing in the card
 * showed it. Marking the characters both sides share lets the eye tell a
 * copy (all of it marked) from a change (only what differs left unmarked).
 *
 * Bounded so a large or minified hunk cannot stall the webview: the shared
 * start and end are found in linear time, which covers the usual edit of a
 * few characters on a long line; the middle gets an exact character match
 * only while its table stays small, and is otherwise all "changed".
 */

/** A run of one line's text, and whether the other side holds it too. */
export interface DiffSegment {
	text: string
	same: boolean
}

/** The most cells the middle's match table may have. */
const MAX_CELLS = 1_000_000

/** Past this many characters on the two sides together, nothing is marked. */
const MAX_HUNK_CHARS = 200_000

/** A shared run shorter than this, inside a change, is noise, not shared text. */
const MIN_INNER_RUN = 3

/** The code of a diff line, without its `+`/`-` prefix. */
export function diffLineCode(line: string): string {
	const marked = line.startsWith("+") || line.startsWith("-")
	if (!marked) return line
	return line.slice(line.startsWith("+ ") || line.startsWith("- ") ? 2 : 1)
}

/** Mark the characters of `a` and `b` that a longest common subsequence pairs. */
function matchMiddle(a: string, b: string, sameA: Uint8Array, sameB: Uint8Array, offA: number, offB: number): void {
	const rows = a.length
	const cols = b.length
	if (rows === 0 || cols === 0 || (rows + 1) * (cols + 1) > MAX_CELLS) return
	const width = cols + 1
	const table = new Uint16Array((rows + 1) * width)
	for (let i = rows - 1; i >= 0; i--) {
		for (let j = cols - 1; j >= 0; j--) {
			table[i * width + j] =
				a[i] === b[j]
					? table[(i + 1) * width + j + 1] + 1
					: Math.max(table[(i + 1) * width + j], table[i * width + j + 1])
		}
	}
	let i = 0
	let j = 0
	while (i < rows && j < cols) {
		if (a[i] === b[j]) {
			sameA[offA + i] = 1
			sameB[offB + j] = 1
			i++
			j++
		} else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
			i++
		} else {
			j++
		}
	}
}

/** Drop shared runs too short to mean anything, between `from` and `to`. */
function dropShortRuns(same: Uint8Array, from: number, to: number): void {
	let start = from
	while (start < to) {
		if (!same[start]) {
			start++
			continue
		}
		let end = start
		while (end < to && same[end]) end++
		if (end - start < MIN_INNER_RUN) same.fill(0, start, end)
		start = end
	}
}

function toSegments(lines: readonly string[], same: Uint8Array): DiffSegment[][] {
	const out: DiffSegment[][] = []
	let at = 0
	for (const line of lines) {
		const segments: DiffSegment[] = []
		for (let k = 0; k < line.length; k++) {
			const isSame = same[at + k] === 1
			const last = segments[segments.length - 1]
			if (last && last.same === isSame) last.text += line[k]
			else segments.push({ text: line[k], same: isSame })
		}
		out.push(segments)
		at += line.length + 1
	}
	return out
}

/**
 * For a run of removed lines and the added lines that replace them, each
 * line's segments: `same` where the other side has that text in the same
 * order. Undefined when the hunk is too large to mark.
 */
export function markHunk(
	removed: readonly string[],
	added: readonly string[],
): { removed: DiffSegment[][]; added: DiffSegment[][] } | undefined {
	const a = removed.join("\n")
	const b = added.join("\n")
	if (a.length + b.length > MAX_HUNK_CHARS) return undefined
	const sameA = new Uint8Array(a.length)
	const sameB = new Uint8Array(b.length)
	let prefix = 0
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++
	let suffix = 0
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
		suffix++
	}
	sameA.fill(1, 0, prefix)
	sameB.fill(1, 0, prefix)
	sameA.fill(1, a.length - suffix)
	sameB.fill(1, b.length - suffix)
	matchMiddle(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix), sameA, sameB, prefix, prefix)
	dropShortRuns(sameA, prefix, a.length - suffix)
	dropShortRuns(sameB, prefix, b.length - suffix)
	return { removed: toSegments(removed, sameA), added: toSegments(added, sameB) }
}

/**
 * Segments for the added lines of a diff, by index: each run of `-` lines
 * with the `+` lines straight after it is marked as one hunk. Removed lines,
 * lines outside such a pair, and hunks too large to mark have none.
 */
export function markDiffLines(lines: readonly string[]): (DiffSegment[] | undefined)[] {
	const out: (DiffSegment[] | undefined)[] = new Array(lines.length).fill(undefined)
	let index = 0
	while (index < lines.length) {
		if (!lines[index].startsWith("-")) {
			index++
			continue
		}
		const removedStart = index
		while (index < lines.length && lines[index].startsWith("-")) index++
		const addedStart = index
		while (index < lines.length && lines[index].startsWith("+")) index++
		if (index === addedStart) continue
		const marked = markHunk(
			lines.slice(removedStart, addedStart).map(diffLineCode),
			lines.slice(addedStart, index).map(diffLineCode),
		)
		if (!marked) continue
		// Only the added side is marked: a removed line is removed whatever it
		// shares, and reads as such all in red.
		marked.added.forEach((segments, k) => {
			out[addedStart + k] = segments
		})
	}
	return out
}
