import type { NewsItem } from "@shared/News"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const openUrl = vi.fn(() => Promise.resolve())
vi.mock("@/services/grpc-client", () => ({ UiServiceClient: { openUrl: (request: unknown) => openUrl(request) } }))

import NewsPanel, { NEWS_COLLAPSED_AT_KEY } from "./NewsPanel"

const item = (id: string, overrides: Partial<NewsItem> = {}): NewsItem => ({
	id,
	date: "2026-09-25",
	title: `Title ${id}`,
	...overrides,
})

// jsdom without a page URL has no localStorage; the panel copes (it starts
// open), but remembering the collapse is what is under test here.
const store = new Map<string, string>()
vi.stubGlobal("localStorage", {
	getItem: (key: string) => store.get(key) ?? null,
	setItem: (key: string, value: string) => store.set(key, value),
	removeItem: (key: string) => store.delete(key),
	clear: () => store.clear(),
})

beforeEach(() => {
	store.clear()
	openUrl.mockClear()
})

describe("NewsPanel", () => {
	it("renders nothing when there is no news", () => {
		const { container } = render(<NewsPanel news={[]} />)
		expect(container.innerHTML).toBe("")
	})

	it("shows each item with its markdown body", () => {
		render(<NewsPanel news={[item("a", { body: "Now **faster**." })]} />)
		expect(screen.getByText("Title a")).toBeTruthy()
		expect(screen.getByText("faster").tagName).toBe("STRONG")
	})

	it("opens Read more in the browser", () => {
		render(<NewsPanel news={[item("a", { url: "https://huggingface.co/mann1x" })]} />)
		fireEvent.click(screen.getByText("Read more"))
		expect(openUrl).toHaveBeenCalledWith({ value: "https://huggingface.co/mann1x" })
	})

	it("collapses, and stays collapsed across a reload", () => {
		const news = [item("b"), item("a")]
		const { unmount } = render(<NewsPanel news={news} />)
		fireEvent.click(screen.getByRole("button", { name: /news/i }))
		expect(screen.queryByText("Title b")).toBeNull()
		expect(screen.getByText("(2)")).toBeTruthy()

		unmount()
		render(<NewsPanel news={news} />)
		expect(screen.queryByText("Title b")).toBeNull()
	})

	// Collapsing hides what was read. A newer item has not been, so it must not
	// stay hidden behind a choice made about an older one.
	it("opens again when a newer item arrives", () => {
		localStorage.setItem(NEWS_COLLAPSED_AT_KEY, "a")
		render(<NewsPanel news={[item("b"), item("a")]} />)
		expect(screen.getByText("Title b")).toBeTruthy()
	})
})
