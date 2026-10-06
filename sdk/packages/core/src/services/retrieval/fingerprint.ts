/**
 * A text's fingerprint: a few numbers that say how much of two texts is the
 * same, without keeping either.
 *
 * This is how the Library tells that a file is a book it already has under
 * another name or in another format, and how it tells a new edition (much
 * the same, not all) from a copy (all but the same). It needs no model.
 *
 * MinHash over five-word shingles: the share of positions where two
 * fingerprints agree estimates the share of five-word runs the texts have in
 * common.
 */

export const FINGERPRINT_SIZE = 64;
const SHINGLE = 5;

/** Odd multipliers, one per position, fixed so fingerprints compare across machines. */
const MULTIPLIERS = Array.from(
	{ length: FINGERPRINT_SIZE },
	(_unused, index) => (Math.imul(index + 1, 0x9e3779b1) | 1) >>> 0,
);

function hashWord(word: string, seed: number): number {
	let hash = seed ^ 0x811c9dc5;
	for (let at = 0; at < word.length; at++) {
		hash = Math.imul(hash ^ word.charCodeAt(at), 0x01000193);
	}
	return hash >>> 0;
}

function mix(value: number): number {
	let hash = value;
	hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
	hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
	return (hash ^ (hash >>> 16)) >>> 0;
}

/**
 * The fingerprint of a text. Markup, case, punctuation and line breaks are
 * not part of it, so the same book read out of a PDF and out of an EPUB come
 * out close. Empty for a text of fewer than five words.
 */
export function textFingerprint(text: string): number[] {
	const words = text
		.toLowerCase()
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.match(/[\p{L}\p{N}]+/gu);
	if (!words || words.length < SHINGLE) return [];
	const minima = new Array<number>(FINGERPRINT_SIZE).fill(0xffffffff);
	const hashes = words.map((word) => hashWord(word, 0));
	for (let at = 0; at + SHINGLE <= hashes.length; at++) {
		let shingle = 0;
		for (let n = 0; n < SHINGLE; n++) {
			shingle = Math.imul(shingle ^ hashes[at + n], 0x01000193) + n;
		}
		shingle >>>= 0;
		for (let position = 0; position < FINGERPRINT_SIZE; position++) {
			const value = mix(Math.imul(shingle, MULTIPLIERS[position]) ^ position);
			if (value < minima[position]) minima[position] = value;
		}
	}
	return minima;
}

/** How much of two texts is the same, 0 to 1, from their fingerprints. */
export function fingerprintSimilarity(
	a: readonly number[],
	b: readonly number[],
): number {
	if (a.length === 0 || a.length !== b.length) return 0;
	let same = 0;
	for (let at = 0; at < a.length; at++) {
		if (a[at] === b[at]) same++;
	}
	return same / a.length;
}
