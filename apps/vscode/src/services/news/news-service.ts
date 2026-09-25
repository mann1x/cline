/**
 * Fetch the fork's `news.json` and hand it to the home view.
 *
 * Thin by design: what the feed may contain and what is shown today live in
 * `news-feed.ts`, which is pure and tested. This part fetches on a timer and
 * pushes, and is the part that cannot be unit-tested because it is the network
 * and the editor.
 *
 * The fetch happens here, in the extension host, not in the webview: the
 * webview's CSP only lets it connect to posthog and cline.bot, so a fetch of
 * raw.githubusercontent.com from there would be blocked in production (and only
 * there; the dev CSP allows it, which is how that kind of bug ships).
 */

import type * as vscode from "vscode"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { currentNews, localDay, NEWS_FEED_URL, type NewsItem, parseNewsFeed } from "./news-feed"

/** Long enough not to compete with activation. */
const FIRST_FETCH_DELAY_MS = 5_000

/** Announcements are not urgent; a few hours late is fine and keeps GitHub unbothered. */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000

const FETCH_TIMEOUT_MS = 10_000

/** The last feed that parsed. Kept through failures so a network blip does not blank the panel. */
let feed: NewsItem[] = []

/** What the home view shows now. Read by `getStateToPostToWebview`. */
export function getCurrentNews(now: Date = new Date()): NewsItem[] {
	return currentNews(feed, localDay(now))
}

async function readFeed(): Promise<unknown> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
	try {
		const response = await fetch(NEWS_FEED_URL, {
			signal: controller.signal,
			headers: { accept: "application/json", "user-agent": "cerebriline-news" },
		})
		if (!response.ok) {
			throw new Error(`GitHub answered ${response.status} ${response.statusText}`.trimEnd())
		}
		return await response.json()
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Fetch once. Returns whether what the panel shows changed, so the caller only
 * re-posts the whole extension state when there is something new to show.
 */
export async function refreshNews(): Promise<boolean> {
	const before = JSON.stringify(getCurrentNews())
	try {
		const parsed = parseNewsFeed(await readFeed())
		if (!parsed) {
			Logger.warn("[News] news.json is not a version-1 feed; keeping the last one")
			return false
		}
		feed = parsed
	} catch (error) {
		// Offline, rate-limited, or GitHub having a moment. The panel keeps what
		// it had; the next tick tries again.
		Logger.debug(`[News] fetch failed: ${error instanceof Error ? error.message : String(error)}`)
		return false
	}
	return JSON.stringify(getCurrentNews()) !== before
}

/**
 * Fetch shortly after activation, then every few hours.
 *
 * `onChange` re-posts the extension state; it is passed in rather than
 * imported so this module does not reach for the webview itself.
 */
export function registerNewsRefresh(context: vscode.ExtensionContext, onChange: () => Promise<void>): void {
	const tick = async () => {
		if (await refreshNews()) {
			await onChange().catch(() => undefined)
		}
	}
	const first = setTimeout(() => void tick(), FIRST_FETCH_DELAY_MS)
	const every = setInterval(() => void tick(), REFRESH_INTERVAL_MS)
	context.subscriptions.push({
		dispose: () => {
			clearTimeout(first)
			clearInterval(every)
		},
	})
}
