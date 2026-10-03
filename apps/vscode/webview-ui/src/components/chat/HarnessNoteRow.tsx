import { ChevronDownIcon, ChevronRightIcon, InfoIcon } from "lucide-react"
import { useState } from "react"
import type { HarnessNote } from "./harnessNote"

/**
 * A note the harness sent the model: one line, and the whole note on request.
 *
 * It is the model's reading, not the user's, so it stays out of the way --
 * muted, one line -- but it is not hidden: what the lead was told is how its
 * next move is explained.
 */
export function HarnessNoteRow({ note }: { note: HarnessNote }) {
	const [open, setOpen] = useState(false)
	const Chevron = open ? ChevronDownIcon : ChevronRightIcon
	return (
		<div className="text-xs text-(--vscode-descriptionForeground)">
			<div className="flex items-start gap-1.5">
				<InfoIcon className="size-3 mt-0.5 shrink-0" />
				<span className="break-words min-w-0">
					<span className="opacity-80">Note to the model: </span>
					{note.headline}
				</span>
			</div>
			{note.detail && (
				<>
					<button
						aria-expanded={open}
						className="flex items-center gap-1 mt-1 ml-4 bg-transparent border-0 p-0 cursor-pointer text-(--vscode-textLink-foreground)"
						onClick={() => setOpen(!open)}
						type="button">
						<Chevron className="size-3" />
						{open ? "Hide the full note" : "Show the full note"}
					</button>
					{open && (
						<pre className="mt-1 ml-4 p-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-(--vscode-textCodeBlock-background)">
							{note.detail}
						</pre>
					)}
				</>
			)}
		</div>
	)
}
