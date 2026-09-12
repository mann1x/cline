import type { ClineEmptyTurnInfo, ClineMessage } from "@shared/ExtensionMessage"
import { CircleSlashIcon } from "lucide-react"

function parseInfo(text: string | undefined): ClineEmptyTurnInfo {
	if (!text) {
		return {}
	}
	try {
		const parsed = JSON.parse(text)
		if (parsed && typeof parsed === "object") {
			return parsed as ClineEmptyTurnInfo
		}
	} catch {
		// An older or malformed payload still deserves the row — the fact that
		// the turn was empty is the message, and the reasoning count is detail.
	}
	return {}
}

function formatCount(count: number | undefined): string | undefined {
	if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) {
		return undefined
	}
	return count < 1_000 ? `${count}` : `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`
}

/**
 * A turn that produced no assistant text and called no tool.
 *
 * Without this the turn leaves no row at all, and a gap between two request
 * rows is indistinguishable from the model still working — which is exactly
 * how a turn that emitted 22 tokens and nothing visible was read as lost model
 * output. A model answering with an empty turn is a real failure mode, and it
 * was previously visible only as a token count in the extension log.
 *
 * Reasoning does not make a turn non-empty: a turn that thought at length and
 * then said nothing and called nothing is the case most worth seeing. So the
 * row reports the reasoning rather than being suppressed by it, and the two
 * cases read differently — "no output" against "no output · thought 8.2k
 * chars".
 */
export const EmptyTurnRow = ({ message }: { message: ClineMessage }) => {
	const info = parseInfo(message.text)
	const reasoning = formatCount(info.reasoningChars)

	return (
		<div className="py-1.5 text-description">
			<div className="flex items-center gap-2">
				<CircleSlashIcon className="size-3 shrink-0" />
				<span className="min-w-0 text-left">
					{reasoning
						? `No output this turn · reasoned ${reasoning} chars, called nothing`
						: "No output this turn · no text, no tool call"}
				</span>
				<div className="flex-1 min-w-4 border-t border-description/30" />
			</div>
		</div>
	)
}

export default EmptyTurnRow
