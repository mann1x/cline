import type { ClineMessage, ClineTransactionInfo } from "@shared/ExtensionMessage"
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, UndoIcon } from "lucide-react"
import { useState } from "react"

function parseInfo(text: string | undefined): ClineTransactionInfo | undefined {
	if (!text) {
		return undefined
	}
	try {
		const parsed = JSON.parse(text)
		if (parsed && typeof parsed === "object" && typeof parsed.transaction === "number" && typeof parsed.kept === "boolean") {
			return parsed as ClineTransactionInfo
		}
	} catch {
		// Fall through to undefined for malformed payloads.
	}
	return undefined
}

function label(transaction: number): string {
	return `TX-${String(transaction).padStart(2, "0")}`
}

/**
 * What happened to one transaction's changes.
 *
 * A discarded transaction is the row that has to be unmissable: every file it
 * touched went back to what it was, and without this the transcript reads the
 * same as a run that got it right the first time — the model's own account of
 * the change is still sitting there above it, describing edits that no longer
 * exist on disk.
 *
 * A discarded one therefore stays open, and a kept one collapses to a divider.
 * The asymmetry is deliberate: the failures are the ones you need to read, and
 * they are the minority in a run that finishes.
 */
export const TransactionRow = ({ message }: { message: ClineMessage }) => {
	const info = parseInfo(message.text)
	const [expanded, setExpanded] = useState(info ? !info.kept : false)

	if (!info) {
		// Virtuoso cannot handle zero-height items; render a spacer instead of null.
		return <div aria-hidden className="h-px" />
	}

	const parts = [info.message || `${label(info.transaction)} ${info.kept ? "kept" : "discarded"}`]
	if (!info.kept && info.filesPutBack) {
		parts.push(`${info.filesPutBack} file${info.filesPutBack === 1 ? "" : "s"} put back`)
	}

	return (
		<div className={`py-1.5 ${info.kept ? "text-description" : "text-error"}`}>
			<button
				aria-expanded={expanded}
				className="flex items-center gap-2 w-full text-inherit hover:text-foreground bg-transparent border-0 p-0 cursor-pointer"
				disabled={!info.output}
				onClick={() => setExpanded((current) => !current)}
				type="button">
				{info.output ? (
					expanded ? (
						<ChevronDownIcon className="size-3 shrink-0" />
					) : (
						<ChevronRightIcon className="size-3 shrink-0" />
					)
				) : (
					<span className="size-3 shrink-0" />
				)}
				{info.kept ? <CheckIcon className="size-3 shrink-0" /> : <UndoIcon className="size-3 shrink-0" />}
				<span className="min-w-0 text-left">{parts.join(" · ")}</span>
				<div className="flex-1 min-w-4 border-t border-description/30" />
			</button>
			{expanded && info.output ? (
				<pre className="mt-1 ml-4 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-description/30 p-2 text-description">
					{info.output}
				</pre>
			) : null}
		</div>
	)
}

export default TransactionRow
