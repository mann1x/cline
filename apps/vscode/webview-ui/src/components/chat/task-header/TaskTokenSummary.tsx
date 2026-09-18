import type { ExpertApiMetrics, ProviderApiMetrics } from "@shared/getApiMetrics"
import { memo, useState } from "react"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"
import { formatRate } from "@/utils/request-timings"
import { ConnectionBreakdown } from "./ConnectionBreakdown"

interface TaskTokenSummaryProps {
	tokensIn: number
	tokensOut: number
	/** Tokens generated across the requests whose provider timed itself. */
	generateTokens: number
	generateMs: number
	byProvider: ProviderApiMetrics[]
	/**
	 * What the expert spent, when the task escalated.
	 *
	 * Beside the session's own rather than added to it. The expert is usually
	 * the metered model -- a cloud account, a shared allowance -- and a single
	 * total answers neither "what did this task cost me" nor "what did my own
	 * model do". Absent when nothing was escalated, and then this line looks
	 * exactly as it did before the feature existed.
	 */
	expert?: ExpertApiMetrics
}

/**
 * What this task has spent, on one line under the context bar.
 *
 * The numbers were already being computed and already had a home, in an
 * accordion inside a hover card over the progress bar -- which is to say they
 * were two interactions away from anyone who wanted to know how many tokens a
 * run produced, and unreachable at a glance while it was still running. The
 * totals are cumulative over the task, including sub-agents; the bar above
 * shows the last request alone, which is a different question.
 *
 * The rate is generation only, and only from requests whose provider reported
 * its own timings. Dividing tokens by wall-clock would fold in queueing,
 * prompt processing and tool time, and a "speed" that moves when the model
 * does not is worse than no speed at all.
 */
export const TaskTokenSummary = memo<TaskTokenSummaryProps>(
	({ tokensIn, tokensOut, generateTokens, generateMs, byProvider, expert }) => {
		const [expanded, setExpanded] = useState(false)

		if (!tokensIn && !tokensOut) {
			return null
		}

		const rate = generateMs > 0 ? formatRate((generateTokens / generateMs) * 1000) : undefined
		// Only worth saying when it is true; the ordinary task runs on one.
		const connections = byProvider.filter((entry) => entry.providerId)
		// Same rule as the session's own rate: only from a provider that timed
		// itself. A rate of zero would read as a very slow expert rather than as
		// one nobody timed.
		const expertRate =
			expert && expert.generateMs > 0 ? formatRate((expert.generateTokens / expert.generateMs) * 1000) : undefined

		return (
			<div className="mt-1 text-xs text-description">
				<div className="flex flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
					<span title="Total tokens sent in this task, including sub-agents">↑ {formatTokenNumber(tokensIn)}</span>
					<span title="Total tokens generated in this task, including sub-agents">
						↓ {formatTokenNumber(tokensOut)}
					</span>
					{rate && (
						<span title="Generation speed, averaged over the requests whose provider reported timings">{rate}</span>
					)}
					{connections.length > 1 && (
						// A disclosure rather than a tooltip, for the same reason
						// the task row has one: the split is the interesting part
						// when it exists, and it exists rarely enough that it has
						// to be readable without knowing to hover.
						<button
							aria-expanded={expanded}
							className="flex flex-row items-center gap-x-1 bg-transparent border-none p-0 text-xs text-description cursor-pointer"
							onClick={() => setExpanded((previous) => !previous)}
							title="What each connection spent. The rows add up to the totals on this line."
							type="button">
							<span className={`codicon codicon-chevron-${expanded ? "down" : "right"} text-[10px]`} />
							{connections.length} connections
						</button>
					)}
					{expert && (
						<span
							className="ml-auto flex flex-row items-center gap-x-2"
							title={`What the expert spent over ${expert.requests} request${expert.requests === 1 ? "" : "s"}. Kept apart from the totals on the left: the expert is usually the metered model.`}>
							<span>Expert:</span>
							<span>↑ {formatTokenNumber(expert.tokensIn)}</span>
							<span>↓ {formatTokenNumber(expert.tokensOut)}</span>
							{expertRate && <span>{expertRate}</span>}
						</span>
					)}
				</div>
				{expanded && connections.length > 1 && <ConnectionBreakdown connections={connections} />}
			</div>
		)
	},
)
TaskTokenSummary.displayName = "TaskTokenSummary"
