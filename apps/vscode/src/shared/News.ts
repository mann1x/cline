/** One announcement from the fork's `news.json`. See `services/news/news-feed.ts`. */
export interface NewsItem {
	/** Stable across edits; the panel uses it to tell a new item from an edited one. */
	id: string
	/** `YYYY-MM-DD`. Sorts the feed, newest first. */
	date: string
	title: string
	/** Short markdown. */
	body?: string
	/** Where "Read more" goes. https only. */
	url?: string
	/** `YYYY-MM-DD`. The item is hidden from this day on. */
	expires?: string
}
