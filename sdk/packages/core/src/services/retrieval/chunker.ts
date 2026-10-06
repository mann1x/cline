/**
 * Splits a document's text into the chunks that are indexed.
 *
 * Every chunk is a contiguous slice of the source, so it carries the offsets
 * it came from and can be shown in place. The steps, in order:
 *
 * 1. With `markdownHeaders`, the text is first cut into sections at its
 *    markdown headers, and each chunk remembers the headers above it.
 * 2. A section larger than `size` is cut at the most natural boundary that
 *    is small enough: paragraphs, then lines, then sentences, then words,
 *    and only then mid-word.
 * 3. Neighbouring pieces are packed into chunks of at most `size`, each
 *    starting up to `overlap` before the end of the one before.
 * 4. With `minSize`, a chunk smaller than that is merged into its neighbour
 *    when the result still fits, forward first and then backward.
 *
 * Sizes are counted in characters, or in estimated tokens (four characters
 * each) unless a real counter is passed as `measure`.
 */

export interface ChunkOptions {
	/** Largest chunk. Default 1500. */
	size?: number;
	/** Shared between neighbouring chunks of one section. Default 100. */
	overlap?: number;
	/** Chunks smaller than this are merged when possible. 0 turns it off. Default 0. */
	minSize?: number;
	/** What `size`, `overlap` and `minSize` count. Default "characters". */
	unit?: "characters" | "tokens";
	/** Cut at markdown headers first, and record them. Default true. */
	markdownHeaders?: boolean;
	/** A real counter, replacing the estimate for `unit`. */
	measure?: (text: string) => number;
}

export interface TextChunk {
	/** Position among the document's chunks, from 0. */
	index: number;
	text: string;
	/** Offsets of `text` in the source: `source.slice(start, end) === text`. */
	start: number;
	end: number;
	/** The markdown headers above the chunk's start, outermost first. */
	headings: string[];
}

interface Range {
	start: number;
	end: number;
}

interface Section extends Range {
	headings: string[];
}

/** Tried in this order; the first that cuts the piece is used. */
const BOUNDARIES: RegExp[] = [
	/\n[ \t]*\n+/g, // paragraphs
	/\n/g, // lines
	/(?<=[.!?。！？])\s+/g, // sentences
	/\s+/g, // words
];

const HEADER = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^\s*(```|~~~)/;

function sectionsOf(source: string, byHeaders: boolean): Section[] {
	if (!byHeaders) {
		return [{ start: 0, end: source.length, headings: [] }];
	}
	const sections: Section[] = [];
	const path: { level: number; title: string }[] = [];
	let sectionStart = 0;
	let headings: string[] = [];
	let inFence = false;
	let offset = 0;
	for (const line of source.split("\n")) {
		if (FENCE.test(line)) {
			inFence = !inFence;
		} else if (!inFence) {
			const match = HEADER.exec(line);
			if (match) {
				if (offset > sectionStart) {
					sections.push({ start: sectionStart, end: offset, headings });
				}
				const level = match[1].length;
				while (path.length > 0 && path[path.length - 1].level >= level) {
					path.pop();
				}
				path.push({ level, title: match[2].trim() });
				headings = path.map((entry) => entry.title);
				sectionStart = offset;
			}
		}
		offset += line.length + 1;
	}
	if (source.length > sectionStart) {
		sections.push({ start: sectionStart, end: source.length, headings });
	}
	return sections;
}

/** Cut a range into pieces no larger than `size`, at the best boundary available. */
function atomsOf(
	source: string,
	range: Range,
	size: number,
	measure: (text: string) => number,
	level = 0,
): Range[] {
	if (measure(source.slice(range.start, range.end)) <= size) {
		return [range];
	}
	if (level >= BOUNDARIES.length) {
		// Nothing natural is left: cut by length. `size` characters is never
		// more than `size` of any unit this is measured in.
		const pieces: Range[] = [];
		const step = Math.max(1, size);
		for (let at = range.start; at < range.end; at += step) {
			pieces.push({ start: at, end: Math.min(range.end, at + step) });
		}
		return pieces;
	}
	const boundary = new RegExp(BOUNDARIES[level].source, "g");
	const text = source.slice(range.start, range.end);
	const pieces: Range[] = [];
	let from = 0;
	for (const match of text.matchAll(boundary)) {
		const cut = match.index + match[0].length;
		if (cut > from && cut < text.length) {
			pieces.push({ start: range.start + from, end: range.start + cut });
			from = cut;
		}
	}
	pieces.push({ start: range.start + from, end: range.end });
	if (pieces.length === 1) {
		return atomsOf(source, range, size, measure, level + 1);
	}
	return pieces.flatMap((piece) =>
		atomsOf(source, piece, size, measure, level + 1),
	);
}

function trimmed(source: string, range: Range): Range | undefined {
	let { start, end } = range;
	while (start < end && /\s/.test(source[start])) start++;
	while (end > start && /\s/.test(source[end - 1])) end--;
	return end > start ? { start, end } : undefined;
}

export function chunkText(
	source: string,
	options: ChunkOptions = {},
): TextChunk[] {
	const size = Math.max(1, Math.floor(options.size ?? 1500));
	const overlap = Math.max(
		0,
		Math.min(Math.floor(options.overlap ?? 100), size - 1),
	);
	const minSize = Math.max(0, Math.floor(options.minSize ?? 0));
	const measure =
		options.measure ??
		(options.unit === "tokens"
			? (text: string) => Math.ceil(text.length / 4)
			: (text: string) => text.length);
	const size_of = (range: Range) =>
		measure(source.slice(range.start, range.end));

	const packed: Section[] = [];
	for (const section of sectionsOf(source, options.markdownHeaders ?? true)) {
		const atoms = atomsOf(source, section, size, measure);
		let first = 0;
		while (first < atoms.length) {
			let last = first;
			while (
				last + 1 < atoms.length &&
				size_of({ start: atoms[first].start, end: atoms[last + 1].end }) <= size
			) {
				last++;
			}
			packed.push({
				start: atoms[first].start,
				end: atoms[last].end,
				headings: section.headings,
			});
			if (last + 1 >= atoms.length) {
				break;
			}
			// The next chunk starts as far back as the overlap allows, on a
			// piece boundary, and always after where this one started.
			let next = last + 1;
			while (
				next - 1 > first &&
				size_of({ start: atoms[next - 1].start, end: atoms[last].end }) <=
					overlap
			) {
				next--;
			}
			first = next;
		}
	}

	const ranges = packed
		.map((chunk) => {
			const range = trimmed(source, chunk);
			return range ? { ...range, headings: chunk.headings } : undefined;
		})
		.filter((chunk): chunk is Section => chunk !== undefined);

	const merged: Section[] = [];
	if (minSize > 0) {
		let index = 0;
		while (index < ranges.length) {
			let current = ranges[index++];
			// Forward: take in the chunks after it while it is still too small.
			while (
				size_of(current) < minSize &&
				index < ranges.length &&
				size_of({ start: current.start, end: ranges[index].end }) <= size
			) {
				current = { ...current, end: ranges[index++].end };
			}
			// Backward: what could not grow forward joins the one before.
			const previous = merged[merged.length - 1];
			if (
				size_of(current) < minSize &&
				previous &&
				size_of({ start: previous.start, end: current.end }) <= size
			) {
				merged[merged.length - 1] = { ...previous, end: current.end };
			} else {
				merged.push(current);
			}
		}
	} else {
		merged.push(...ranges);
	}

	return merged.map((chunk, index) => ({
		index,
		text: source.slice(chunk.start, chunk.end),
		start: chunk.start,
		end: chunk.end,
		headings: chunk.headings,
	}));
}
