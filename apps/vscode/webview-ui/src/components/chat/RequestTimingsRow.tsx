import type { ClineApiReqInfo } from "@shared/ExtensionMessage"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import React, { memo, useMemo, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { engineName, formatTokens, summarizeTimings, timingRows } from "@/utils/request-timings"

/**
 * What one request cost, under the request.
 *
 * Cline has always recorded a per-request token count and shown none of it:
 * the numbers went into the `api_req_started` row, the row read `cost` as a
 * boolean meaning "the turn ended", and everything else was aggregated into
 * the task header where a single slow request cannot be seen. Asked for on
 * mann1x/cline#64, against a screenshot of Open WebUI's per-message panel.
 *
 * Off by default, because for anyone not chasing a local model this is a row
 * of numbers under every request answering a question they never asked. The
 * data is recorded either way, so switching it on shows the requests already
 * made rather than only the ones after.
 *
 * Collapsed it is one line: wall time, generation rate, time to first token.
 * Expanded it is the whole of what the provider and the engine reported, and
 * on Ollama or llama.cpp that includes the split between reading the prompt
 * and writing the answer -- the one distinction that separates a cache that
 * stopped hitting from a model that simply thought for longer.
 */

interface RequestTimingsRowProps {
	message: { text?: string }
}

export const RequestTimingsRow = memo<RequestTimingsRowProps>(({ message }) => {
	const { showRequestTimings } = useExtensionState()
	const [isExpanded, setIsExpanded] = useState(false)

	const info = useMemo<ClineApiReqInfo | undefined>(() => {
		if (!message.text) {
			return undefined
		}
		try {
			return JSON.parse(message.text) as ClineApiReqInfo
		} catch {
			return undefined
		}
	}, [message.text])

	const rows = useMemo(() => timingRows(info?.timings, info?.tokensOut), [info?.timings, info?.tokensOut])
	const summary = useMemo(() => summarizeTimings(info?.timings, info?.tokensOut), [info?.timings, info?.tokensOut])

	if (!showRequestTimings || !info?.timings || !summary) {
		return null
	}

	const engine = engineName(info.timings)
	const reasoningTokens = formatTokens(info.reasoningTokens)

	return (
		<div className="ml-1 mt-0.5 text-xs text-description">
			<button
				aria-expanded={isExpanded}
				className="flex items-center gap-1 bg-transparent border-0 p-0 cursor-pointer text-left text-description hover:text-foreground"
				onClick={(event) => {
					event.stopPropagation()
					setIsExpanded((expanded) => !expanded)
				}}
				type="button">
				{isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
				<span>{summary}</span>
				{engine && <span className="opacity-60">· {engine}</span>}
			</button>
			{/* The asterisk in the summary needs saying once, where it appears,
			    rather than being a mark the reader has to guess at. */}
			{isExpanded && summary.includes("gen*") && (
				<div className="ml-4 mt-1 opacity-60">
					* generation rate derived from Cline's timing, not reported by the provider
				</div>
			)}
			{isExpanded && (
				<div className="ml-4 mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
					{rows.map((row) => (
						<React.Fragment key={row.label}>
							<span className="opacity-70">{row.label}</span>
							<span>
								{row.value}
								{row.note && <span className="opacity-50"> — {row.note}</span>}
							</span>
						</React.Fragment>
					))}
					{reasoningTokens && (
						<>
							<span className="opacity-70">Reasoning tokens</span>
							<span>{reasoningTokens}</span>
						</>
					)}
				</div>
			)}
		</div>
	)
})

RequestTimingsRow.displayName = "RequestTimingsRow"

export default RequestTimingsRow
