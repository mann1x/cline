/**
 * A document's running heads: the lines printed on most of its pages, and
 * what they say about which document it is.
 *
 * Text in common says two documents are related, not that one is a version of
 * the other. Measured on a folder of AMD's processor manuals: two Processor
 * Programming References for different processors share 77% of their five-word
 * runs, more than two revisions of one revision guide (68%), because whole
 * register chapters are reused from product to product. No threshold on the
 * text separates them. The running head does: "55803 Rev 0.54 - Sep 12, 2019
 * PPR for AMD Family 17h Model 31h B0" against "56176 Rev 3.06 - Jul 17, 2019
 * PPR for AMD Family 17h Model 71h B0". Between revisions of one document only
 * the revision and the date change; between two documents the number and the
 * subject do.
 *
 * So the head is not stripped as boilerplate: it is read as the document's
 * name. Only its identifying part is compared -- the tokens that carry a
 * digit, once revision numbers and dates are taken out -- because the words
 * around them ("AMD64 Technology", "PPR for AMD Family") are shared by a
 * whole series.
 */

/** The page headings the reader writes: `## Page 12`, `## Slide 3`. */
const PAGE_BREAK = /\n#{1,6}[ \t]+(?:page|slide)[ \t]+\d+[ \t]*\n/i;
/** Fewer pages than this, and a line on most of them says nothing. */
const MIN_PAGES = 4;
/** On this share of the pages, at least three, a line is a running head. */
const HEAD_SHARE = 0.4;
const MAX_HEADS = 5;
const MAX_HEAD_LENGTH = 200;

const MONTH = String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const WORD = /[\p{L}\p{N}]+/gu;

/**
 * The lines that repeat, word for word, on most pages. A page number printed
 * on the same line makes it differ from page to page, so it drops out; a
 * table heading that recurs is kept, and carries no identity (see below).
 * Empty for a document without pages: an ebook has none to repeat on.
 */
export function runningHeads(markdown: string): string[] {
	const pages = `\n${markdown}`
		.split(PAGE_BREAK)
		// What comes before the first page heading is not a page.
		.filter((page) => page.trim() !== "");
	if (pages.length < MIN_PAGES) return [];
	const seen = new Map<string, number>();
	for (const page of pages) {
		const lines = new Set<string>();
		for (const raw of page.split("\n")) {
			const line = raw.split(/\s+/).filter(Boolean).join(" ").toLowerCase();
			if (line.length > MAX_HEAD_LENGTH) continue;
			if ((line.match(/[\p{L}]{2,}/gu) ?? []).length < 3) continue;
			lines.add(line);
		}
		for (const line of lines) seen.set(line, (seen.get(line) ?? 0) + 1);
	}
	const floor = Math.max(3, HEAD_SHARE * pages.length);
	return [...seen]
		.filter(([, count]) => count >= floor)
		.sort((a, b) => b[1] - a[1])
		.slice(0, MAX_HEADS)
		.map(([line]) => line);
}

/** The identifying tokens of one head: those with a digit, less revision and date. */
function headIdentity(head: string): string[] {
	const text = head
		// "processors55723", "2020software": a number run into a word.
		.replace(/(?<=\d)(?=\p{L}{3,})|(?<=\p{L}{3})(?=\d)/gu, " ")
		.replace(/\b(?:rev(?:ision)?|version|ver)\b\.?\s*[\p{L}\p{N}.]+/gu, " ")
		.replace(new RegExp(String.raw`\b${MONTH}\b\.?(?:\s+\d{1,2}\b)?`, "g"), " ")
		.replace(/\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b|\b(?:19|20)\d\d\b/g, " ");
	return (text.match(WORD) ?? []).filter((token) => /\d/.test(token));
}

/** What the running heads say the document is, as sorted tokens; empty if they say nothing. */
export function documentIdentity(heads: readonly string[]): string[] {
	return [...new Set(heads.flatMap(headIdentity))].sort();
}

/**
 * Whether two documents are the same one by their running heads: true when
 * the identities match, false when both have one and they differ, undefined
 * when either says nothing -- then the text and the title decide, as before.
 */
export function sameDocument(
	a: readonly string[] | undefined,
	b: readonly string[] | undefined,
): boolean | undefined {
	const one = documentIdentity(a ?? []);
	const other = documentIdentity(b ?? []);
	if (one.length === 0 || other.length === 0) return undefined;
	return (
		one.length === other.length && one.every((token, at) => token === other[at])
	);
}

/** The head that names the document, for a message: the first with an identity. */
export function namingHead(
	heads: readonly string[] | undefined,
): string | undefined {
	return (heads ?? []).find((head) => headIdentity(head).length > 0);
}
