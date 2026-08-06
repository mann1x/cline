import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { memo, useCallback, useEffect, useRef, useState } from "react"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

interface ThinkingRowProps {
	showTitle: boolean
	reasoningContent?: string
	isVisible: boolean
	isExpanded: boolean
	onToggle?: () => void
	title?: string
	isStreaming?: boolean
	showChevron?: boolean
}

export const ThinkingRow = memo(
	({
		showTitle = false,
		reasoningContent,
		isVisible,
		isExpanded,
		onToggle,
		title = "Thinking",
		isStreaming = false,
		showChevron = true,
	}: ThinkingRowProps) => {
		const scrollRef = useRef<HTMLDivElement>(null)
		const [canScrollUp, setCanScrollUp] = useState(false)
		const [canScrollDown, setCanScrollDown] = useState(false)

		const checkScrollable = useCallback(() => {
			if (scrollRef.current) {
				const { scrollTop, scrollHeight, clientHeight } = scrollRef.current
				setCanScrollUp(scrollTop > 1)
				setCanScrollDown(scrollTop + clientHeight < scrollHeight - 1)
			}
		}, [])

		// Only auto-scroll to bottom during streaming (showCursor=true)
		// For expanded collapsed thinking, start at top
		useEffect(() => {
			if (scrollRef.current && isVisible) {
				scrollRef.current.scrollTop = scrollRef.current.scrollHeight
			}
			checkScrollable()
		}, [reasoningContent, isVisible, checkScrollable])

		if (!isVisible) {
			return null
		}

		// Don't render anything if collapsed and no title (nothing to show)
		if (!isExpanded && !showTitle) {
			return null
		}

		return (
			<div className="ml-1 pl-0 mb-0 -mt-[2px]">
				{showTitle ? (
					<Button
						className={cn(
							"inline-flex justify-baseline gap-0.5 text-left select-none px-0 py-0 my-0 h-auto min-h-0 w-full text-description overflow-visible",
							{
								"cursor-pointer": !!onToggle,
								"cursor-default": !onToggle,
							},
						)}
						onClick={onToggle}
						size="icon"
						variant="icon">
						<span
							className={cn("text-[13px] leading-[1.2]", {
								"animate-shimmer bg-linear-90 from-foreground to-description bg-[length:200%_100%] bg-clip-text text-transparent":
									isStreaming,
								"select-none": isStreaming,
							})}>
							{title}
						</span>
						{showChevron &&
							(isExpanded ? (
								<ChevronDownIcon className="!size-1 text-description" />
							) : (
								<ChevronRightIcon className="!size-1 text-description" />
							))}
					</Button>
				) : null}

				{/*
				 * A div, not a Button. Reasoning renders as Markdown now,
				 * and Markdown carries its own interactive elements — file
				 * links are buttons — which cannot be nested inside one.
				 * Losing click-to-collapse on the body is the point rather
				 * than the cost: the title still toggles, and selecting a
				 * line of reasoning no longer collapses the block out from
				 * under the selection.
				 */}
				{isExpanded && (
					<div
						className={cn(
							"flex gap-0 overflow-hidden w-full min-w-0 max-h-0 opacity-0 items-baseline justify-baseline text-left p-0 pl-0",
							{
								"max-h-[200px] opacity-100": isVisible,
								"transition-[max-height] duration-[250ms] ease-[cubic-bezier(0.4,0,0.2,1)] [transition:max-height_250ms_cubic-bezier(0.4,0,0.2,1),opacity_150ms_ease-out]":
									isVisible,
							},
						)}>
						<div className="relative flex-1">
							<div
								className={cn(
									"flex max-h-[150px] overflow-y-auto overflow-x-hidden text-description leading-normal truncated break-words pl-0 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden [direction:ltr]",
									// Markdown brings its own wide content — fenced code, tables,
									// long URLs — and none of it wraps by default, so a rendered
									// thinking block pushed its text off the side of the panel with
									// no way to reach it. The block itself never scrolls sideways;
									// only the elements that genuinely cannot wrap do, inside their
									// own box.
									"[&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto",
									"[&_*]:min-w-0 [&_p]:break-words [&_code]:break-words [&_a]:break-all",
								)}
								onScroll={checkScrollable}
								ref={scrollRef}>
								{/*
								 * Reasoning arrives as Markdown and was being
								 * shown as its source. Models write headings,
								 * lists and fenced code while they think, and a
								 * wall of `##` and backticks is what a reader
								 * had to work through. `whitespace-pre-wrap`
								 * goes with it: Markdown owns the line breaks
								 * now, and keeping it would double every blank
								 * line.
								 */}
								{/*
								 * Markdown only once the text has stopped arriving.
								 *
								 * Two things go wrong rendering a live stream as
								 * Markdown. Single newlines are not line breaks in
								 * Markdown, so reasoning — which is mostly single-newline
								 * prose — collapses into one running paragraph; and the
								 * text is re-parsed on every token, with the tail
								 * routinely mid-construct (an unclosed fence, a half
								 * written list), so what is on screen stops tracking what
								 * has arrived until the turn ends and the last parse
								 * finally succeeds. Both were reported together:
								 * a code snippet flattened to one line, then no updates
								 * at all, then the whole block appearing complete.
								 *
								 * While streaming this is what the model is emitting, so
								 * it is shown verbatim with its line breaks intact.
								 * Once complete the same text renders as Markdown, which
								 * is what makes a long thinking block readable afterwards.
								 */}
								<span className="pb-2 block text-sm w-full min-w-0">
									{isStreaming ? (
										<span className="whitespace-pre-wrap break-words">{reasoningContent}</span>
									) : (
										<MarkdownBlock markdown={reasoningContent} />
									)}
								</span>
							</div>
							{canScrollUp && (
								<div className="absolute top-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-b from-background to-transparent" />
							)}
							{canScrollDown && (
								<div className="absolute bottom-0 left-0 right-0 h-6 pointer-events-none bg-gradient-to-t from-background to-transparent" />
							)}
						</div>
					</div>
				)}
			</div>
		)
	},
)

ThinkingRow.displayName = "ThinkingRow"
