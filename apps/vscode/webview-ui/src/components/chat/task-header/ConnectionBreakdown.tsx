import type { ProviderApiMetrics } from "@shared/getApiMetrics"
import { memo } from "react"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"
import { formatRate } from "@/utils/request-timings"

/**
 * What one connection was, in words.
 *
 * Reported as: "if there are 2 connections that should be the sum and same as
 * tasks with > should expand the stats for each one, identifying which
 * connection was and for". The identity is the provider *and* the model — a
 * task that switches models mid-run is two connections on one provider, and the
 * provider name alone says nothing about which — and the "for" is the role.
 *
 * Only two roles are reported, because only two are recorded. A delegated batch
 * tags itself `subagents`; everything else is the task's own turns. Vision and
 * the scoped tabs are not tagged at the request, so inventing a label for them
 * here would be a guess presented as a reading. The escalation expert has a row
 * of its own on the line above and is deliberately not one of these.
 */
export function describeConnection(entry: ProviderApiMetrics): { name: string; role: string; detail?: string } {
	const name = entry.modelId ? `${entry.providerId} · ${entry.modelId}` : (entry.providerId ?? "unknown")
	if (entry.source === "subagents") {
		return {
			name,
			role: "sub-agents",
			...(entry.agents > 0 ? { detail: `${entry.agents} agent${entry.agents === 1 ? "" : "s"}` } : {}),
		}
	}
	return {
		name,
		role: "main",
		...(entry.requests > 0 ? { detail: `${entry.requests} request${entry.requests === 1 ? "" : "s"}` } : {}),
	}
}

/**
 * The per-connection rows behind the header's connection count.
 *
 * The rows add up to the totals on the line above them — every request that
 * contributes to one contributes to a row — so the breakdown can be read as an
 * explanation of that line rather than as a second, unrelated set of numbers.
 */
export const ConnectionBreakdown = memo<{ connections: ProviderApiMetrics[] }>(({ connections }) => (
	<div className="flex flex-col gap-0.5 mt-0.5 pl-3 text-xs text-description">
		{connections.map((entry) => {
			const { name, role, detail } = describeConnection(entry)
			const rate = entry.generateMs > 0 ? formatRate((entry.generateTokens / entry.generateMs) * 1000) : undefined
			return (
				<div
					className="flex flex-row flex-wrap items-center gap-x-2"
					key={`${entry.providerId}/${entry.modelId ?? ""}/${entry.source ?? ""}`}>
					<span className="truncate" title={name}>
						{name}
					</span>
					<span className="opacity-75">{role}</span>
					<span className="whitespace-nowrap">↑ {formatTokenNumber(entry.tokensIn)}</span>
					<span className="whitespace-nowrap">↓ {formatTokenNumber(entry.tokensOut)}</span>
					{rate && <span className="whitespace-nowrap">{rate}</span>}
					{detail && <span className="opacity-75 whitespace-nowrap">{detail}</span>}
					{entry.cost > 0 && <span className="whitespace-nowrap">${entry.cost.toFixed(4)}</span>}
				</div>
			)
		})}
	</div>
))
ConnectionBreakdown.displayName = "ConnectionBreakdown"
