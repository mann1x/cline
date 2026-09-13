import type { ExpertApiMetrics, ProviderApiMetrics } from "@shared/getApiMetrics"
import { memo } from "react"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"
import { formatRate } from "@/utils/request-timings"

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
		if (!tokensIn && !tokensOut) {
			return null
		}

		const rate = generateMs > 0 ? formatRate((generateTokens / generateMs) * 1000) : undefined
		// Only worth saying when it is true; the ordinary task runs on one.
		const connections = byProvider.filter((entry) => entry.providerId).length
		// Same rule as the session's own rate: only from a provider that timed
		// itself. A rate of zero would read as a very slow expert rather than as
		// one nobody timed.
		const expertRate =
			expert && expert.generateMs > 0 ? formatRate((expert.generateTokens / expert.generateMs) * 1000) : undefined

		return (
			<div className="flex flex-row flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 text-xs text-description">
				<span title="Total tokens sent in this task, including sub-agents">↑ {formatTokenNumber(tokensIn)}</span>
				<span title="Total tokens generated in this task, including sub-agents">↓ {formatTokenNumber(tokensOut)}</span>
				{rate && <span title="Generation speed, averaged over the requests whose provider reported timings">{rate}</span>}
				{connections > 1 && (
					<span title="This task ran on more than one connection; the breakdown is under Token Usage">
						{connections} connections
					</span>
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
		)
	},
)
TaskTokenSummary.displayName = "TaskTokenSummary"
