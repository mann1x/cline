import { ChevronDown } from "lucide-react"
import React, { memo, useCallback } from "react"
import { cn } from "@/lib/utils"

interface JumpToPresentProps {
	readonly isVisible: boolean
	readonly onJump: () => void
}

/**
 * Returns the reader to the newest message and puts the view back into tailing.
 *
 * Scrolling up sets `disableAutoScrollRef`, and the only thing that clears it is
 * Virtuoso reporting the list at the bottom within `atBottomThreshold` — ten
 * pixels. That is a fine rule when the list is still, and an unreachable one
 * while a turn is streaming: every token appended pushes the bottom further away
 * than the scroll gained, so a reader who looked up at anything has to fight the
 * list to get tailing back. Hence a button rather than a smaller threshold —
 * widening the threshold would re-engage tailing while the user is still
 * reading, which is the opposite complaint.
 *
 * The jump itself is the caller's, because clearing the flag is the half that
 * matters: scrolling to the bottom without it lands there once and stops
 * following again on the next token.
 */
export const JumpToPresent: React.FC<JumpToPresentProps> = memo(({ isVisible, onJump }) => {
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault()
				onJump()
			}
		},
		[onJump],
	)

	if (!isVisible) {
		return null
	}

	return (
		<div
			aria-label="Jump to the newest message and resume following"
			className={cn(
				"absolute bottom-2 left-1/2 -translate-x-1/2 z-20",
				"flex items-center gap-1 px-2.5 py-1 cursor-pointer select-none",
				"text-xs shadow-sm backdrop-blur-sm",
				"hover:brightness-110",
			)}
			onClick={onJump}
			onKeyDown={handleKeyDown}
			role="button"
			style={{
				backgroundColor: "var(--vscode-badge-background)",
				color: "var(--vscode-badge-foreground)",
				borderRadius: "10px",
			}}
			tabIndex={0}
			title="Jump to present">
			<ChevronDown size={12} />
			<span>Jump to present</span>
		</div>
	)
})

JumpToPresent.displayName = "JumpToPresent"
