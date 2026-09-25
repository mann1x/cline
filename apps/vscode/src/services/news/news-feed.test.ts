import { describe, expect, it } from "vitest"
import { currentNews, localDay, MAX_NEWS_ITEMS, type NewsItem, parseNewsFeed } from "./news-feed"

const item = (overrides: Partial<NewsItem> & { id: string }): NewsItem => ({
	date: "2026-09-20",
	title: `Title ${overrides.id}`,
	...overrides,
})

describe("parseNewsFeed", () => {
	it("reads a version-1 feed", () => {
		expect(
			parseNewsFeed({
				version: 1,
				items: [
					{
						id: "v9",
						date: "2026-09-25",
						title: "v9-agentic is out",
						body: "Tool calling, **fast**.",
						url: "https://huggingface.co/mann1x",
						expires: "2026-10-25",
					},
				],
			}),
		).toEqual([
			{
				id: "v9",
				date: "2026-09-25",
				title: "v9-agentic is out",
				body: "Tool calling, **fast**.",
				url: "https://huggingface.co/mann1x",
				expires: "2026-10-25",
			},
		])
	})

	// The file is edited by hand. A typo in one announcement must not blank the
	// panel for everyone.
	it("drops a malformed item and keeps the rest", () => {
		const parsed = parseNewsFeed({
			version: 1,
			items: [
				{ id: "ok", date: "2026-09-25", title: "Fine" },
				{ id: "no-title", date: "2026-09-25" },
				{ id: "bad-date", date: "25/09/2026", title: "Wrong format" },
				"not an object",
				{ id: "ok", date: "2026-09-24", title: "Duplicate id" },
			],
		})
		expect(parsed?.map((entry) => entry.title)).toEqual(["Fine"])
	})

	// The link opens in the user's browser; anything but https is not worth the risk.
	it("drops a non-https link but keeps the item", () => {
		const parsed = parseNewsFeed({
			version: 1,
			items: [{ id: "a", date: "2026-09-25", title: "T", url: "javascript:alert(1)" }],
		})
		expect(parsed).toEqual([{ id: "a", date: "2026-09-25", title: "T" }])
	})

	// An unusable document says nothing about the news, so the caller keeps the
	// feed it already has rather than replacing it with an empty one.
	it("rejects a document that is not the version-1 shape", () => {
		expect(parseNewsFeed(undefined)).toBeUndefined()
		expect(parseNewsFeed({ items: [] })).toBeUndefined()
		expect(parseNewsFeed({ version: 2, items: [] })).toBeUndefined()
		expect(parseNewsFeed({ version: 1, items: {} })).toBeUndefined()
		expect(parseNewsFeed({ version: 1, items: [] })).toEqual([])
	})
})

describe("currentNews", () => {
	it("shows newest first", () => {
		const shown = currentNews(
			[item({ id: "old", date: "2026-09-01" }), item({ id: "new", date: "2026-09-24" })],
			"2026-09-25",
		)
		expect(shown.map((entry) => entry.id)).toEqual(["new", "old"])
	})

	it("hides an item from its expiry day on", () => {
		const items = [item({ id: "a", expires: "2026-09-25" })]
		expect(currentNews(items, "2026-09-24")).toHaveLength(1)
		expect(currentNews(items, "2026-09-25")).toHaveLength(0)
	})

	// An announcement can be written and pushed ahead of the day it is for.
	it("holds an item back until its date", () => {
		const items = [item({ id: "a", date: "2026-10-01" })]
		expect(currentNews(items, "2026-09-30")).toHaveLength(0)
		expect(currentNews(items, "2026-10-01")).toHaveLength(1)
	})

	it("caps the list", () => {
		const items = Array.from({ length: MAX_NEWS_ITEMS + 3 }, (_, index) =>
			item({ id: String(index), date: `2026-09-${String(10 + index).padStart(2, "0")}` }),
		)
		expect(currentNews(items, "2026-09-30")).toHaveLength(MAX_NEWS_ITEMS)
	})
})

describe("localDay", () => {
	it("formats the local calendar day", () => {
		expect(localDay(new Date(2026, 8, 5, 23, 59))).toBe("2026-09-05")
	})
})
