import { XIcon } from "lucide-react"
import type { MouseEvent } from "react"
import { AGENT_HUES } from "@/components/chat/subagentIdentity"
import { cn } from "@/lib/utils"

/**
 * A tag's colour: the agent-name palette, picked by the tag's name.
 *
 * Agents take their hue from their position in a row, which keeps a row free
 * of collisions. A tag has to keep one colour everywhere it appears (every
 * row, the filter, the menu), so here the name decides. Lower-cased, because
 * "Work" and "work" are one tag.
 */
export function tagStyle(tag: string): { backgroundColor: string; borderColor: string } {
	let hash = 2166136261
	for (const char of tag.toLowerCase()) {
		hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
	}
	const hue = AGENT_HUES[(hash >>> 0) % AGENT_HUES.length]
	return {
		backgroundColor: `hsl(${hue} 70% 50% / 0.18)`,
		borderColor: `hsl(${hue} 70% 50% / 0.55)`,
	}
}

type TagChipProps = {
	tag: string
	/** Clicking the name, e.g. to filter by it. */
	onSelect?: () => void
	/** Shows the remove icon. */
	onRemove?: () => void
	className?: string
}

const stop = (handler: () => void) => (event: MouseEvent) => {
	// Chips sit on a row that opens the conversation when clicked.
	event.stopPropagation()
	handler()
}

export const TagChip = ({ tag, onSelect, onRemove, className }: TagChipProps) => (
	<span
		className={cn(
			"inline-flex max-w-full items-center gap-0.5 rounded-xs border px-1.5 py-[1px] text-[10px] font-medium text-foreground",
			className,
		)}
		style={tagStyle(tag)}>
		{onSelect ? (
			<button
				className="truncate border-none bg-transparent p-0 text-inherit cursor-pointer"
				onClick={stop(onSelect)}
				title={`Show conversations tagged ${tag}`}
				type="button">
				{tag}
			</button>
		) : (
			<span className="truncate">{tag}</span>
		)}
		{onRemove && (
			<button
				aria-label={`Remove tag ${tag}`}
				className="-mr-0.5 flex border-none bg-transparent p-0 text-inherit opacity-70 hover:opacity-100 cursor-pointer"
				onClick={stop(onRemove)}
				type="button">
				<XIcon className="size-2.5" />
			</button>
		)}
	</span>
)
