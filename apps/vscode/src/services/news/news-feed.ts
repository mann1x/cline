/**
 * The fork's news feed: what `news.json` may contain and what the panel shows.
 *
 * Pure, so every decision that could be wrong in a way that looks like working
 * is tested here. `news-service.ts` only fetches and pushes.
 *
 * The feed is a file the maintainer edits by hand in the repo, so the parser is
 * lenient per item and strict per field. One malformed entry is dropped. It
 * never takes the rest of the feed with it, because a typo in an announcement
 * should not blank the panel for everyone.
 */

import type { NewsItem } from "@shared/News"

/** Where the feed lives. `main` is the trunk; see docs/protocols/BUILD-RELEASE-DEPLOY.md. */
export const NEWS_FEED_URL = "https://raw.githubusercontent.com/mann1x/cline/main/news.json"

/** How many items the panel shows at most. */
export const MAX_NEWS_ITEMS = 5

export type { NewsItem }

const DAY = /^\d{4}-\d{2}-\d{2}$/

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function day(value: unknown): string | undefined {
	const candidate = text(value)
	return candidate && DAY.test(candidate) && !Number.isNaN(Date.parse(candidate)) ? candidate : undefined
}

function httpsUrl(value: unknown): string | undefined {
	const candidate = text(value)
	if (!candidate) {
		return undefined
	}
	try {
		return new URL(candidate).protocol === "https:" ? candidate : undefined
	} catch {
		return undefined
	}
}

function toItem(raw: unknown): NewsItem | undefined {
	if (!raw || typeof raw !== "object") {
		return undefined
	}
	const record = raw as Record<string, unknown>
	const id = text(record.id)
	const date = day(record.date)
	const title = text(record.title)
	if (!id || !date || !title) {
		return undefined
	}
	const body = text(record.body)
	const url = httpsUrl(record.url)
	const expires = day(record.expires)
	return {
		id,
		date,
		title,
		...(body ? { body } : {}),
		...(url ? { url } : {}),
		...(expires ? { expires } : {}),
	}
}

/**
 * Read a fetched `news.json`. Returns `undefined` when the document itself is
 * unusable (not the version-1 shape), so the caller keeps what it had rather
 * than replacing a good feed with nothing.
 */
export function parseNewsFeed(document: unknown): NewsItem[] | undefined {
	if (!document || typeof document !== "object") {
		return undefined
	}
	const { version, items } = document as { version?: unknown; items?: unknown }
	if (version !== 1 || !Array.isArray(items)) {
		return undefined
	}
	const seen = new Set<string>()
	const parsed: NewsItem[] = []
	for (const raw of items) {
		const item = toItem(raw)
		// A duplicated id keeps the first: it is the one a reader would see
		// first in the file, and the panel keys its "new" state on the id.
		if (item && !seen.has(item.id)) {
			seen.add(item.id)
			parsed.push(item)
		}
	}
	return parsed
}

/** Today as `YYYY-MM-DD` in local time, the calendar the maintainer writes dates in. */
export function localDay(now: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0")
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * What the panel shows today: unexpired, dated no later than today (so an item
 * can be written ahead of its announcement), newest first, capped.
 */
export function currentNews(items: readonly NewsItem[], today: string): NewsItem[] {
	return items
		.filter((item) => item.date <= today && (!item.expires || item.expires > today))
		.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
		.slice(0, MAX_NEWS_ITEMS)
}
