/**
 * The quick filter used by long lists (skills, API configuration profiles).
 *
 * Every word typed has to appear somewhere in the fields, in any order and any
 * case: "qwen 128k" finds "local · qwen36 27b 128k". Plain substrings rather
 * than fuzzy scoring, because these are names the user chose and remembers in
 * pieces; a fuzzy match on short names puts unrelated entries in the list.
 */
export function matchesFilter(query: string, ...fields: (string | undefined)[]): boolean {
	const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
	if (words.length === 0) {
		return true
	}
	const haystack = fields
		.filter((field): field is string => Boolean(field))
		.join("\n")
		.toLowerCase()
	return words.every((word) => haystack.includes(word))
}
