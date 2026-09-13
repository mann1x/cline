import type { ClineEscalationInfo, ClineMessage } from "@shared/ExtensionMessage"
import { ChevronDownIcon, ChevronRightIcon, LoaderIcon, PauseIcon, SendIcon, SquareUserIcon, UserCheckIcon } from "lucide-react"
import { useState } from "react"
import { formatLargeNumber } from "@/utils/format"
import { formatDuration, formatRate } from "@/utils/request-timings"
import { MarkdownRow } from "./MarkdownRow"

function parseInfo(text: string | undefined): ClineEscalationInfo | undefined {
	if (!text) {
		return undefined
	}
	try {
		const parsed = JSON.parse(text)
		if (parsed && typeof parsed === "object" && typeof parsed.phase === "string" && typeof parsed.text === "string") {
			return parsed as ClineEscalationInfo
		}
	} catch {
		// Fall through to undefined for malformed payloads.
	}
	return undefined
}

/**
 * One turn of the exchange with the expert.
 *
 * The asymmetry is the design. A hand-over is a fact about the run and its
 * brief is long, so it is named on one line and readable on demand. A delivery
 * is the thing the user opened the chat to read — the base model is about to
 * act on it, and a user who is paying for this model by the token should not
 * have to click to find out what they bought.
 *
 * The changed files are not a detail either. A second model has just edited the
 * workspace: every read the base model had of those files is stale, and so is
 * anything the user had open in an editor.
 */
export const EscalationRow = ({ message }: { message: ClineMessage }) => {
	const info = parseInfo(message.text)
	const [expanded, setExpanded] = useState(false)

	if (!info) {
		// Virtuoso cannot handle zero-height items; render a spacer instead of null.
		return <div aria-hidden className="h-px" />
	}

	if (info.phase === "started") {
		const counted =
			info.index !== undefined && info.of !== undefined ? `Escalation ${info.index} of ${info.of}` : "Escalation"
		return (
			<div className="py-1.5 text-description">
				<button
					aria-expanded={expanded}
					className="flex items-center gap-2 w-full text-inherit hover:text-foreground bg-transparent border-0 p-0 cursor-pointer"
					onClick={() => setExpanded((current) => !current)}
					type="button">
					{expanded ? (
						<ChevronDownIcon className="size-3 shrink-0" />
					) : (
						<ChevronRightIcon className="size-3 shrink-0" />
					)}
					<SquareUserIcon className="size-3 shrink-0" />
					<span className="min-w-0 text-left">{counted} — the task was handed to the expert</span>
					<div className="flex-1 min-w-4 border-t border-description/30" />
				</button>
				{expanded ? (
					<pre className="mt-1 ml-4 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-description/30 p-2">
						{info.text}
					</pre>
				) : null}
			</div>
		)
	}

	if (info.phase === "ended") {
		return (
			<div className="flex items-center gap-2 py-1.5 text-description">
				<PauseIcon className="size-3 shrink-0" />
				<span className="min-w-0">{info.text}</span>
				<div className="flex-1 min-w-4 border-t border-description/30" />
			</div>
		)
	}

	// What the expert is doing, while it is still doing it. A hand-over is one
	// tool call from the base model's side, so without this the panel shows the
	// collapsed line above and nothing else until the delivery lands -- twenty
	// minutes of it, on a run where the expert made twelve tool calls. Rewritten
	// in place rather than appended, and the delivery takes this row over.
	if (info.phase === "working") {
		const elapsed = formatDuration(info.usage?.wallMs)
		const calls = info.toolCalls ?? 0
		return (
			<div className="flex items-center gap-2 py-1.5 text-description">
				<LoaderIcon className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
				<span className="min-w-0">
					The expert is working
					{calls > 0 ? ` — ${calls} tool call${calls === 1 ? "" : "s"}` : ""}
					{info.lastTool ? `, last ${info.lastTool}` : ""}
				</span>
				{info.usage ? (
					<span className="flex items-center gap-2 text-xs" title="What this turn has spent so far">
						<span>↑ {formatLargeNumber(info.usage.tokensIn)}</span>
						<span>↓ {formatLargeNumber(info.usage.tokensOut)}</span>
						{elapsed ? <span>{elapsed}</span> : null}
					</span>
				) : null}
				<div className="flex-1 min-w-4 border-t border-description/30" />
			</div>
		)
	}

	if (info.phase === "message") {
		return (
			<div className="py-1.5 text-description">
				<div className="flex items-center gap-2">
					<SendIcon className="size-3 shrink-0" />
					<span>Back to the expert</span>
					<div className="flex-1 min-w-4 border-t border-description/30" />
				</div>
				<div className="mt-1 ml-4 border-l-2 border-description/30 pl-2">
					<MarkdownRow markdown={info.text} />
				</div>
			</div>
		)
	}

	const rate =
		info.usage && info.usage.generateMs > 0
			? formatRate((info.usage.generateTokens / info.usage.generateMs) * 1000)
			: undefined

	return (
		<div className="py-1.5">
			<div className="flex items-center gap-2 text-description">
				<UserCheckIcon className="size-3 shrink-0" />
				<span>The expert</span>
				{info.usage ? (
					<span className="flex items-center gap-2 text-xs" title="What this delivery cost">
						<span>↑ {formatLargeNumber(info.usage.tokensIn)}</span>
						<span>↓ {formatLargeNumber(info.usage.tokensOut)}</span>
						{rate ? <span>{rate}</span> : null}
					</span>
				) : null}
				<div className="flex-1 min-w-4 border-t border-description/30" />
			</div>
			<div className="mt-1 ml-4 border-l-2 border-description/30 pl-2">
				<MarkdownRow markdown={info.text} />
			</div>
			{info.changed?.length ? (
				<div className="mt-1 ml-4 text-xs text-description">Changed under you: {info.changed.join(", ")}</div>
			) : null}
		</div>
	)
}

export default EscalationRow
