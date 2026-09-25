/**
 * Tags on conversations: the rules the host store and the webview share.
 *
 * One module, imported by both, so the webview cannot accept a tag the host
 * would then rewrite, and the filter cannot match differently from the chips
 * the user sees.
 */

/**
 * The session-metadata key tags are stored under.
 *
 * Not `tags`: the LLM gateway reads a request's `metadata.tags` for tracing,
 * and a name of our own keeps conversation labels out of that question.
 */
export const CONVERSATION_TAGS_METADATA_KEY = "conversationTags"

/** Long enough for a project or topic name, short enough to stay a chip. */
export const MAX_TAG_LENGTH = 32

/** Past this, a conversation's tags stop being a label and become a description. */
export const MAX_TAGS_PER_CONVERSATION = 12

/** One tag as stored: trimmed, inner whitespace collapsed, clipped. Empty means none. */
export function normalizeTag(raw: string): string {
	return raw.trim().replace(/\s+/g, " ").slice(0, MAX_TAG_LENGTH).trim()
}

/**
 * A conversation's tag list as stored: normalized, without duplicates (case
 * does not make a new tag -- the first spelling wins), in the order given,
 * capped.
 */
export function normalizeTags(raw: readonly unknown[]): string[] {
	const seen = new Set<string>()
	const tags: string[] = []
	for (const value of raw) {
		if (typeof value !== "string") {
			continue
		}
		const tag = normalizeTag(value)
		const key = tag.toLowerCase()
		if (tag && !seen.has(key)) {
			seen.add(key)
			tags.push(tag)
		}
		if (tags.length === MAX_TAGS_PER_CONVERSATION) {
			break
		}
	}
	return tags
}

/**
 * Whether a conversation passes a tag filter. `matchAll` is the "all" mode;
 * the default is any. An empty filter passes everything. Case-insensitive,
 * like the de-duplication.
 */
export function matchesTagFilter(tags: readonly string[], filter: readonly string[], matchAll = false): boolean {
	if (filter.length === 0) {
		return true
	}
	const have = new Set(tags.map((tag) => tag.toLowerCase()))
	const wanted = filter.map((tag) => tag.toLowerCase())
	return matchAll ? wanted.every((tag) => have.has(tag)) : wanted.some((tag) => have.has(tag))
}

/**
 * Tags written as `#tag` in a search query, and the query with them removed.
 *
 * The history search box takes both: free text for the title search, `#tag`
 * for the filter. The text half goes to the host's substring search, so the
 * tags must come out of it -- left in, "#work" would match no title at all.
 */
export function splitTagQuery(query: string): { text: string; tags: string[] } {
	const tags: string[] = []
	const text = query
		.replace(/(^|\s)#([^\s#]+)/g, (_match, lead: string, tag: string) => {
			tags.push(tag)
			return lead
		})
		.replace(/\s+/g, " ")
		.trim()
	return { text, tags: normalizeTags(tags) }
}

/**
 * The query with a `#tag` removed, whatever case it was typed in, and the rest
 * left as typed. Removing a tag's chip from the filter has to take it out of
 * the search box too, or the next keystroke would put it straight back.
 */
export function removeTagFromQuery(query: string, tag: string): string {
	const wanted = normalizeTag(tag).toLowerCase()
	return (
		query
			.split(/\s+/)
			// Compared as the filter saw it: a typed tag is normalized (clipped) on
			// the way in, so the raw word may be longer than the chip it made.
			.filter((word) => !(word.startsWith("#") && normalizeTag(word.slice(1)).toLowerCase() === wanted))
			.join(" ")
			.trim()
	)
}
