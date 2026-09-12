import type { ClineMessage, ClineOutputLimitRetryInfo } from "@shared/ExtensionMessage"
import { RotateCcwIcon } from "lucide-react"

function parseInfo(text: string | undefined): ClineOutputLimitRetryInfo {
	if (!text) {
		return {}
	}
	try {
		const parsed = JSON.parse(text)
		if (parsed && typeof parsed === "object") {
			return parsed as ClineOutputLimitRetryInfo
		}
	} catch {
		// The retry is the message; the numbers are detail. A payload that will
		// not parse still deserves a row saying the turn was thrown away.
	}
	return {}
}

function formatTokenCount(count: number): string {
	if (count < 1_000) {
		return `${count}`
	}
	if (count < 1_000_000) {
		return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`
	}
	return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

/** The cap's provenance, in words rather than the wire slug. */
function describeCapSource(source: string | undefined): string | undefined {
	switch (source) {
		case "remaining-context":
			return "what was left of the context window"
		case "model-max-output":
			return "the model's output limit"
		case "requested":
			return "the configured output limit"
		default:
			return undefined
	}
}

/**
 * A turn that hit its output cap mid-answer and is being taken again.
 *
 * The core already emitted this as a status notice, but with no parser it fell
 * through to the generic info row and rendered as the bare sentence "output
 * limit reached before the turn finished — retrying", directly abutting two
 * more raw slugs from the compaction that follows it. Every number a reader
 * needs to act on — which attempt this is, how many are left, what the cap was
 * and where it came from — was already in the notice's metadata and was being
 * thrown away.
 *
 * `compacting` is the one that changes what the reader should do: false means
 * the ceiling was set by configuration, so retrying against a smaller context
 * cannot help and the limit itself is what needs raising.
 */
export const OutputLimitRetryRow = ({ message }: { message: ClineMessage }) => {
	const info = parseInfo(message.text)

	const parts: string[] = ["Output limit reached before the turn finished — retrying"]
	if (typeof info.attempt === "number" && typeof info.maxAttempts === "number") {
		parts.push(`attempt ${info.attempt} of ${info.maxAttempts}`)
	} else if (typeof info.attempt === "number") {
		parts.push(`attempt ${info.attempt}`)
	}
	if (typeof info.capTokens === "number") {
		const source = describeCapSource(info.capSource)
		parts.push(
			source
				? `capped at ${formatTokenCount(info.capTokens)} by ${source}`
				: `capped at ${formatTokenCount(info.capTokens)}`,
		)
	}
	if (info.compacting === true) {
		parts.push("compacting first to make room")
	} else if (info.compacting === false) {
		parts.push("the limit is configured, not the context")
	}

	return (
		<div className="py-1.5 text-description">
			<div className="flex items-center gap-2">
				<RotateCcwIcon className="size-3 shrink-0" />
				<span className="min-w-0 text-left">{parts.join(" · ")}</span>
				<div className="flex-1 min-w-4 border-t border-description/30" />
			</div>
		</div>
	)
}

export default OutputLimitRetryRow
