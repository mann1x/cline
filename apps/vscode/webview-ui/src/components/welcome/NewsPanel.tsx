import type { NewsItem } from "@shared/News"
import { memo, useCallback, useState } from "react"
import Markdown from "react-markdown"
import { UiServiceClient } from "@/services/grpc-client"

/**
 * Remembers which item the panel was collapsed at, not just that it was.
 *
 * Collapsing hides what you have read. A newer item is by definition unread,
 * so the panel opens again for it rather than hiding an announcement behind a
 * choice made about an older one.
 */
export const NEWS_COLLAPSED_AT_KEY = "cerebriline.news.collapsedAt"

function readCollapsedAt(): string | null {
	try {
		return localStorage.getItem(NEWS_COLLAPSED_AT_KEY)
	} catch {
		// Storage can be unavailable; the panel then simply starts open.
		return null
	}
}

function writeCollapsedAt(id: string | null): void {
	try {
		if (id === null) {
			localStorage.removeItem(NEWS_COLLAPSED_AT_KEY)
		} else {
			localStorage.setItem(NEWS_COLLAPSED_AT_KEY, id)
		}
	} catch {
		// Not remembered across reloads; the toggle still works for this view.
	}
}

function formatDay(day: string): string {
	const [year, month, date] = day.split("-").map(Number)
	return new Date(year, month - 1, date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

const openUrl = (url: string) => {
	UiServiceClient.openUrl({ value: url }).catch(console.error)
}

type NewsPanelProps = {
	/** Current items, newest first, as the host sends them. */
	news: readonly NewsItem[]
}

/** The fork's announcements on the home view. Renders nothing when there are none. */
const NewsPanel = ({ news }: NewsPanelProps) => {
	const newest = news[0]?.id
	const [collapsedAt, setCollapsedAt] = useState(readCollapsedAt)
	const collapsed = newest !== undefined && collapsedAt === newest

	const toggle = useCallback(() => {
		const next = collapsed ? null : (newest ?? null)
		writeCollapsedAt(next)
		setCollapsedAt(next)
	}, [collapsed, newest])

	if (!newest) {
		return null
	}

	return (
		<section aria-label="News" className="px-4 pb-2 shrink-0">
			<button
				aria-expanded={!collapsed}
				className="flex w-full items-center gap-1 bg-transparent border-none cursor-pointer px-0 py-2.5 text-description hover:text-foreground"
				onClick={toggle}
				type="button">
				<span className="codicon codicon-megaphone" style={{ transform: "scale(0.9)" }} />
				<span className="text-[0.85em] font-medium uppercase tracking-wide">News</span>
				{collapsed && <span className="ml-1 text-[0.85em]">({news.length})</span>}
				<span className={`codicon codicon-chevron-${collapsed ? "right" : "down"} ml-auto`} />
			</button>
			{!collapsed && (
				<ul className="m-0 p-0 list-none flex flex-col gap-2">
					{news.map((item) => (
						<li
							className="rounded px-3 py-2.5"
							key={item.id}
							style={{
								backgroundColor: "color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 65%, transparent)",
							}}>
							<div className="flex items-baseline gap-2">
								<strong className="flex-1 min-w-0 break-words">{item.title}</strong>
								<span className="shrink-0 text-[0.85em] text-description">{formatDay(item.date)}</span>
							</div>
							{item.body && (
								<div className="mt-1 text-description break-words [&_p]:m-0 [&_p+p]:mt-1">
									<Markdown
										components={{
											a: ({ href, children }) => (
												<a
													href={href}
													rel="noopener noreferrer"
													style={{ color: "var(--vscode-textLink-foreground)" }}
													target="_blank">
													{children}
												</a>
											),
										}}>
										{item.body}
									</Markdown>
								</div>
							)}
							{item.url && (
								<button
									className="mt-1 bg-transparent border-none p-0 cursor-pointer text-[0.85em]"
									onClick={() => item.url && openUrl(item.url)}
									style={{ color: "var(--vscode-textLink-foreground)" }}
									type="button">
									Read more
								</button>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	)
}

export default memo(NewsPanel)
