import type { ClineMessage } from "@shared/ExtensionMessage"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { memo, useMemo, useState } from "react"
import { cn } from "@/lib/utils"

/**
 * The checklist the model is working from, under the context window.
 *
 * The model writes it as a side effect of tool calls it was already making, so
 * it arrives as `say: "task_progress"` messages and the newest one wins — it
 * replaces the previous list rather than appending to it.
 *
 * Rewritten rather than restored: the original component and three of its four
 * dependencies were deleted upstream, and it re-parsed the markdown in the
 * webview. Parsing here is a display concern only — the core tracker does its
 * own parsing to decide when to remind — but the two agree on what counts as an
 * item, and neither invents one.
 */

export interface TaskProgressItem {
	text: string
	done: boolean
}

/** `- [x] text` / `- [ ] text`; anything else is prose, not an item. */
const CHECKLIST_ITEM = /^- \[( |x|X)\]\s*(.*)$/

export function parseTaskProgressMarkdown(markdown: string): TaskProgressItem[] {
	const items: TaskProgressItem[] = []
	for (const raw of markdown.split("\n")) {
		const match = CHECKLIST_ITEM.exec(raw.trim())
		if (!match) {
			continue
		}
		const text = match[2].trim()
		if (text === "") {
			continue
		}
		items.push({ text, done: match[1] !== " " })
	}
	return items
}

/** The most recent checklist in the transcript, or undefined. */
export function findLatestTaskProgress(messages: ClineMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]
		if (message.say === "task_progress" && message.text?.trim()) {
			return message.text
		}
	}
	return undefined
}

interface TaskProgressPanelProps {
	clineMessages: ClineMessage[]
	/** The Focus Chain feature toggle. Off means render nothing at all. */
	enabled?: boolean
}

export const TaskProgressPanel = memo(({ clineMessages, enabled = true }: TaskProgressPanelProps) => {
	const [isExpanded, setIsExpanded] = useState(false)

	const items = useMemo(() => {
		const markdown = findLatestTaskProgress(clineMessages)
		return markdown ? parseTaskProgressMarkdown(markdown) : []
	}, [clineMessages])

	// No checklist is the normal state for a model that never sends one, and an
	// empty panel would be a permanent fixture advertising a feature that is not
	// running. Nothing is the honest render.
	if (!enabled || items.length === 0) {
		return null
	}

	const completed = items.filter((item) => item.done).length
	const total = items.length
	const allDone = completed === total

	return (
		<div className="flex flex-col mt-1 text-description" data-testid="task-progress-panel">
			<button
				aria-expanded={isExpanded}
				className="flex items-center gap-1 w-full text-left cursor-pointer bg-transparent border-0 p-0 text-description"
				onClick={() => setIsExpanded((value) => !value)}
				type="button">
				{isExpanded ? (
					<ChevronDownIcon className="!size-1 shrink-0" />
				) : (
					<ChevronRightIcon className="!size-1 shrink-0" />
				)}
				<span className="text-xs font-bold">Tasks</span>
				<span className={cn("text-xs", { "text-success": allDone })}>
					({completed}/{total})
				</span>
				{/*
				 * The current item is the useful thing at a glance — what the model
				 * says it is doing right now. Shown only while collapsed, since the
				 * expanded list already says it.
				 */}
				{!isExpanded && !allDone && (
					<span className="text-xs truncate min-w-0 opacity-80">{items.find((item) => !item.done)?.text}</span>
				)}
			</button>

			{isExpanded && (
				<ul className="list-none pl-2 m-0 mt-0.5 flex flex-col gap-0.5">
					{items.map((item, index) => (
						<li
							className={cn("text-xs flex items-baseline gap-1 min-w-0", {
								"line-through opacity-60": item.done,
							})}
							// Checklist text repeats across renders and items can duplicate;
							// position is what identifies a row here.
							key={`${index}-${item.text}`}>
							<span className="shrink-0">{item.done ? "✓" : "○"}</span>
							<span className="break-words min-w-0">{item.text}</span>
						</li>
					))}
				</ul>
			)}
		</div>
	)
})

TaskProgressPanel.displayName = "TaskProgressPanel"
