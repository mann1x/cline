/**
 * The history view's query over session records: filter, search, sort, page.
 *
 * Pure, so the paging rules are tested rather than trusted. `SdkController`
 * decides which records to read and maps the page it gets back.
 */

import type { SessionHistoryRecord } from "@cline/core"
import { matchesTagFilter } from "@shared/conversation-tags"
import { arePathsEqual } from "@/utils/path"
import { metadataTags } from "./sdk-task-history"

export interface HistoryQuery {
	favoritesOnly: boolean
	/** Only tasks that ran in this workspace; undefined filters nothing. */
	workspacePath?: string
	searchQuery?: string
	sortBy?: string
	/** Normalized. Empty filters nothing. */
	tags: readonly string[]
	tagsMatchAll: boolean
	limit: number
	offset: number
	/**
	 * The records are already the requested page (plus one, for `hasMore`),
	 * paged by the store. Otherwise they are the whole history.
	 */
	pagedByStore: boolean
}

/**
 * Whether the store's own recency paging answers this query.
 *
 * Only when nothing is filtered and the order is recency. Filtering one page
 * leaves it short, with `hasMore` still true over an empty list. Sorting one
 * page by cost does not find the most expensive tasks. Anything else reads the
 * whole history (metadata only, and cached), then filters, sorts and pages.
 */
export function isStorePagedHistoryQuery(
	request: { favoritesOnly: boolean; currentWorkspaceOnly: boolean; searchQuery?: string; sortBy?: string },
	tags: readonly string[],
): boolean {
	return (
		!request.favoritesOnly &&
		!request.currentWorkspaceOnly &&
		!request.searchQuery &&
		tags.length === 0 &&
		(!request.sortBy || request.sortBy === "newest")
	)
}

function metadataNumber(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): number | undefined {
	const value = metadata?.[key]
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function metadataBoolean(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): boolean | undefined {
	const value = metadata?.[key]
	return typeof value === "boolean" ? value : undefined
}

function metadataString(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): string | undefined {
	const value = metadata?.[key]
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function recency(item: SessionHistoryRecord): number {
	const value = item.updatedAt ?? item.endedAt ?? item.startedAt
	if (!value) {
		return 0
	}
	const timestamp = Date.parse(value)
	return Number.isFinite(timestamp) ? timestamp : 0
}

function tokens(item: SessionHistoryRecord): number {
	return (
		(metadataNumber(item.metadata, "tokensIn") ?? 0) +
		(metadataNumber(item.metadata, "tokensOut") ?? 0) +
		(metadataNumber(item.metadata, "cacheWrites") ?? 0) +
		(metadataNumber(item.metadata, "cacheReads") ?? 0)
	)
}

/** The page of records to show, and whether there is another after it. */
export function selectHistoryPage(
	records: readonly SessionHistoryRecord[],
	query: HistoryQuery,
): { page: SessionHistoryRecord[]; hasMore: boolean } {
	const search = query.searchQuery?.toLowerCase()
	const filtered = records.filter((item) => {
		const task = metadataString(item.metadata, "title") ?? item.prompt ?? ""
		if (!recency(item) || !task) {
			return false
		}

		const isFavorited =
			metadataBoolean(item.metadata, "isFavorited") ?? metadataBoolean(item.metadata, "is_favorited") ?? false
		if (query.favoritesOnly && !isFavorited) {
			return false
		}

		if (query.workspacePath) {
			const sessionWorkspacePath = item.cwd ?? item.workspaceRoot
			if (!sessionWorkspacePath || !arePathsEqual(sessionWorkspacePath, query.workspacePath)) {
				return false
			}
		}

		if (!matchesTagFilter(metadataTags(item.metadata), query.tags, query.tagsMatchAll)) {
			return false
		}

		return !search || task.toLowerCase().includes(search)
	})

	filtered.sort((a, b) => {
		switch (query.sortBy) {
			case "oldest":
				return recency(a) - recency(b)
			case "mostExpensive":
				return (metadataNumber(b.metadata, "totalCost") ?? 0) - (metadataNumber(a.metadata, "totalCost") ?? 0)
			case "mostTokens":
				return tokens(b) - tokens(a)
			default:
				return recency(b) - recency(a)
		}
	})

	if (query.pagedByStore) {
		// The store handed over this page plus one; whether that extra record
		// existed is the only thing that says there is more.
		return { page: filtered.slice(0, query.limit), hasMore: records.length > query.limit }
	}
	const window = filtered.slice(query.offset, query.offset + query.limit + 1)
	return { page: window.slice(0, query.limit), hasMore: window.length > query.limit }
}
