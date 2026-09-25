import type { SessionHistoryRecord } from "@cline/core"
import { describe, expect, it } from "vitest"
import { type HistoryQuery, isStorePagedHistoryQuery, selectHistoryPage } from "./history-query"

/** Newest first: record 0 is the most recent. */
function records(count: number, metadataFor: (index: number) => Record<string, unknown> = () => ({})): SessionHistoryRecord[] {
	return Array.from(
		{ length: count },
		(_, index) =>
			({
				sessionId: `s${index}`,
				prompt: `task ${index}`,
				updatedAt: new Date(Date.UTC(2026, 8, 25) - index * 60_000).toISOString(),
				metadata: { title: `task ${index}`, ...metadataFor(index) },
			}) as unknown as SessionHistoryRecord,
	)
}

const query = (overrides: Partial<HistoryQuery> = {}): HistoryQuery => ({
	favoritesOnly: false,
	tags: [],
	tagsMatchAll: false,
	limit: 3,
	offset: 0,
	pagedByStore: false,
	...overrides,
})

const ids = (page: SessionHistoryRecord[]) => page.map((record) => record.sessionId)

describe("selectHistoryPage", () => {
	// The bug this replaced: the store's page was filtered after the fact, so a
	// tag used on older conversations came back as an empty page with more to load.
	it("finds tagged conversations anywhere in the history, a full page at a time", () => {
		const all = records(20, (index) => (index % 4 === 0 ? { conversationTags: ["work"] } : {}))

		const first = selectHistoryPage(all, query({ tags: ["work"] }))
		expect(ids(first.page)).toEqual(["s0", "s4", "s8"])
		expect(first.hasMore).toBe(true)

		const second = selectHistoryPage(all, query({ tags: ["work"], offset: 3 }))
		expect(ids(second.page)).toEqual(["s12", "s16"])
		expect(second.hasMore).toBe(false)
	})

	it("matches any tag by default, and every tag in all mode", () => {
		const all = records(3, (index) => ({ conversationTags: [["a"], ["a", "b"], ["b"]][index] }))
		expect(ids(selectHistoryPage(all, query({ tags: ["a", "b"] })).page)).toEqual(["s0", "s1", "s2"])
		expect(ids(selectHistoryPage(all, query({ tags: ["a", "b"], tagsMatchAll: true })).page)).toEqual(["s1"])
	})

	// Sorting one page by cost is not "most expensive".
	it("sorts the whole history, not one page of it", () => {
		const all = records(10, (index) => ({ totalCost: index === 9 ? 5 : index / 100 }))
		expect(ids(selectHistoryPage(all, query({ sortBy: "mostExpensive" })).page)[0]).toBe("s9")
	})

	it("combines the title search with the tag filter", () => {
		const all = records(6, (index) => ({ conversationTags: index < 3 ? ["work"] : [] }))
		expect(ids(selectHistoryPage(all, query({ tags: ["work"], searchQuery: "task 2" })).page)).toEqual(["s2"])
	})

	it("keeps the store's page as it is when the store paged it", () => {
		const pageFromStore = records(4)
		const result = selectHistoryPage(pageFromStore, query({ pagedByStore: true }))
		expect(ids(result.page)).toEqual(["s0", "s1", "s2"])
		expect(result.hasMore).toBe(true)
	})
})

describe("isStorePagedHistoryQuery", () => {
	const plain = { favoritesOnly: false, currentWorkspaceOnly: false, searchQuery: "", sortBy: "newest" }

	it("lets the store page only the unfiltered, newest-first view", () => {
		expect(isStorePagedHistoryQuery(plain, [])).toBe(true)
		expect(isStorePagedHistoryQuery({ ...plain, sortBy: undefined }, [])).toBe(true)
		expect(isStorePagedHistoryQuery(plain, ["work"])).toBe(false)
		expect(isStorePagedHistoryQuery({ ...plain, favoritesOnly: true }, [])).toBe(false)
		expect(isStorePagedHistoryQuery({ ...plain, searchQuery: "x" }, [])).toBe(false)
		expect(isStorePagedHistoryQuery({ ...plain, sortBy: "mostTokens" }, [])).toBe(false)
	})
})
