import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { memo, useState } from "react"
import { CopyButton } from "@/components/common/CopyButton"

/**
 * The checklist reminder core appends to a tool's result every few calls. It
 * is written to the model, about the model's own list, and is not part of what
 * the tool did: shown here it ended every third import report.
 */
const TASK_PROGRESS_REMINDER = /\s*<task_progress>[\s\S]*?<\/task_progress>\s*/g

export const reportText = (report: string) => report.replace(TASK_PROGRESS_REMINDER, "\n").trim()

/**
 * What a finished tool that reported its progress came to, kept on its row.
 *
 * An import's report lists every file and what was left out of it, and was
 * gone the moment the call ended. Collapsed to its first line, so a run of
 * imports stays short, and copyable whole.
 */
const ToolReport = ({ report: sent }: { report: string }) => {
	const [open, setOpen] = useState(false)
	const report = reportText(sent)
	if (!report) {
		return null
	}
	const lines = report.split("\n")
	const headline = lines.find((line) => line.trim())?.trim() ?? ""
	return (
		<div className="mt-1.5 bg-code overflow-hidden rounded-xs border border-editor-group-border">
			<div className="flex items-center">
				<button
					aria-expanded={open}
					aria-label={open ? "Collapse report" : "Expand report"}
					className="flex flex-1 min-w-0 items-center gap-1.5 py-1.5 px-2.5 text-xs text-left bg-transparent border-0 cursor-pointer text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)"
					onClick={() => setOpen((value) => !value)}
					type="button">
					{open ? (
						<ChevronDownIcon className="size-3.5 shrink-0" />
					) : (
						<ChevronRightIcon className="size-3.5 shrink-0" />
					)}
					<span className="font-semibold shrink-0">Report</span>
					<span className="truncate">{headline}</span>
					<span className="shrink-0 opacity-70">
						{lines.length} line{lines.length === 1 ? "" : "s"}
					</span>
				</button>
				<CopyButton ariaLabel="Copy report" className="shrink-0 mr-1" textToCopy={report} />
			</div>
			{open ? (
				<pre className="m-0 px-2.5 pb-2 max-h-96 overflow-auto text-xs whitespace-pre-wrap break-words font-(--vscode-editor-font-family)">
					{report}
				</pre>
			) : null}
		</div>
	)
}

export default memo(ToolReport)
