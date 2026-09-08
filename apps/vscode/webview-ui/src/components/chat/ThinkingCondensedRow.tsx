import type { ClineMessage, ClineThinkingCondensedInfo } from "@shared/ExtensionMessage"
import { BrainIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { useState } from "react"

function parseInfo(text: string | undefined): ClineThinkingCondensedInfo | undefined {
	if (!text) {
		return undefined
	}
	try {
		const parsed = JSON.parse(text)
		if (parsed && typeof parsed === "object" && typeof parsed.note === "string") {
			return parsed as ClineThinkingCondensedInfo
		}
	} catch {
		// Fall through to undefined for malformed payloads.
	}
	return undefined
}

function formatChars(count: number | undefined): string | undefined {
	if (typeof count !== "number" || !Number.isFinite(count)) {
		return undefined
	}
	return count < 1_000 ? `${count}` : `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`
}

/**
 * The note a turn left itself when its reasoning ran out of budget.
 *
 * Shown for the same reason the compaction summaries are: what it replaces does
 * not go back to the model, so if this row does not show it, nothing does. It
 * reads as a divider by default — a run can produce a lot of these — and opens
 * on demand, because the times you want it are when the next turn did something
 * strange and the note is the only explanation of what it thought it was doing.
 */
export const ThinkingCondensedRow = ({ message }: { message: ClineMessage }) => {
	const [expanded, setExpanded] = useState(false)
	const info = parseInfo(message.text)

	if (!info) {
		// Virtuoso cannot handle zero-height items; render a spacer instead of null.
		return <div aria-hidden className="h-px" />
	}

	const before = formatChars(info.thinkingChars)
	const after = formatChars(info.noteChars)
	const parts = ["Thinking budget spent · reasoning condensed"]
	if (before && after) {
		parts.push(`${before} → ${after} chars`)
	}

	return (
		<div className="py-1.5 text-description">
			<button
				aria-expanded={expanded}
				className="flex items-center gap-2 w-full text-description hover:text-foreground bg-transparent border-0 p-0 cursor-pointer"
				onClick={() => setExpanded((current) => !current)}
				type="button">
				{expanded ? <ChevronDownIcon className="size-3 shrink-0" /> : <ChevronRightIcon className="size-3 shrink-0" />}
				<BrainIcon className="size-3 shrink-0" />
				<span className="min-w-0 text-left">{parts.join(" · ")}</span>
				<div className="flex-1 min-w-4 border-t border-description/30" />
			</button>
			{expanded ? (
				<pre className="mt-1 ml-4 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-description/30 p-2 text-description">
					{info.note}
				</pre>
			) : null}
		</div>
	)
}

export default ThinkingCondensedRow
