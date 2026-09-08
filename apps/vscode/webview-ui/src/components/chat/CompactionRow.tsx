import type { ClineCompactionInfo, ClineMessage } from "@shared/ExtensionMessage"
import { ChevronDownIcon, ChevronRightIcon, FoldVerticalIcon, LoaderCircleIcon } from "lucide-react"
import { useState } from "react"
import { cn } from "@/lib/utils"

/** Mirrors the CLI's formatTokenCount (apps/cli/src/tui/utils/compaction-status.ts). */
function formatTokenCount(count: number): string {
	if (count < 1_000) {
		return `${count}`
	}
	if (count < 1_000_000) {
		return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`
	}
	return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

function parseCompactionInfo(text: string | undefined): ClineCompactionInfo | undefined {
	if (!text) {
		return undefined
	}
	try {
		const parsed = JSON.parse(text)
		if (parsed && typeof parsed === "object" && typeof parsed.status === "string") {
			return parsed as ClineCompactionInfo
		}
	} catch {
		// Fall through to undefined for malformed payloads.
	}
	return undefined
}

/** Mirrors the CLI's formatCompactionDividerLabel wording for product consistency. */
function formatCompactionLabel(info: ClineCompactionInfo): string {
	if (info.status === "started") {
		return info.mode === "manual" ? "Compacting context" : "Auto compacting context"
	}
	if (info.status === "failed") {
		return "Compaction failed"
	}
	if (info.status === "cancelled") {
		return "Compaction cancelled"
	}
	if (info.status === "skipped") {
		return "Compaction skipped"
	}
	const parts: string[] = [info.mode === "manual" ? "Context compacted (manual)" : "Context compacted"]
	if (typeof info.tokensBefore === "number" && typeof info.tokensAfter === "number") {
		parts.push(`${formatTokenCount(info.tokensBefore)} → ${formatTokenCount(info.tokensAfter)} tokens`)
	}
	if (typeof info.messagesBefore === "number" && typeof info.messagesAfter === "number") {
		parts.push(`${info.messagesBefore} → ${info.messagesAfter} messages`)
	}
	return parts.join(" · ")
}

/**
 * One of the two things a compaction produced, shown on demand.
 *
 * Collapsed by default because the row is a divider and has to keep reading as
 * one; a compaction that went well is not something anyone wants to read twice.
 * But it is the one operation whose output is otherwise invisible — it replaces
 * the messages it was written from, so there is nothing to scroll back to.
 */
const CompactionDetail = ({ label, body }: { label: string; body: string }) => {
	const [expanded, setExpanded] = useState(false)

	return (
		<div className="mt-1">
			<button
				aria-expanded={expanded}
				className="flex items-center gap-1 text-description hover:text-foreground bg-transparent border-0 p-0 cursor-pointer"
				onClick={() => setExpanded((current) => !current)}
				type="button">
				{expanded ? <ChevronDownIcon className="size-3 shrink-0" /> : <ChevronRightIcon className="size-3 shrink-0" />}
				<span>{label}</span>
			</button>
			{expanded ? (
				<pre className="mt-1 ml-4 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-description/30 p-2 text-description">
					{body}
				</pre>
			) : null}
		</div>
	)
}

/**
 * Divider row for context compaction progress and results — the webview
 * counterpart of the CLI's CompactionDividerRow. Shows a spinner while a
 * compaction is running; the same message (same ts) is updated in place to
 * its terminal state when it finishes.
 */
export const CompactionRow = ({ message }: { message: ClineMessage }) => {
	const info = parseCompactionInfo(message.text)
	if (!info) {
		// Virtuoso cannot handle zero-height items; render a spacer instead of null.
		return <div aria-hidden className="h-px" />
	}

	const inProgress = info.status === "started"
	const isFailed = info.status === "failed"
	const isMuted = info.status === "skipped" || info.status === "cancelled"
	const summary = info.summary?.trim()
	const thinkingSummary = info.thinkingSummary?.trim()

	return (
		<div
			className={cn("py-1.5 text-description", {
				"text-error": isFailed,
				"opacity-70": isMuted,
			})}>
			<div className="flex items-center gap-2">
				{inProgress ? (
					<LoaderCircleIcon className="size-2 shrink-0 animate-spin" />
				) : (
					<FoldVerticalIcon className="size-2 shrink-0" />
				)}
				<span className="min-w-0">
					{formatCompactionLabel(info)}
					{inProgress ? "…" : ""}
				</span>
				<div className="flex-1 min-w-4 border-t border-description/30" />
			</div>
			{summary ? <CompactionDetail body={summary} label="Summary" /> : null}
			{thinkingSummary ? <CompactionDetail body={thinkingSummary} label="Retrospective" /> : null}
		</div>
	)
}

export default CompactionRow
