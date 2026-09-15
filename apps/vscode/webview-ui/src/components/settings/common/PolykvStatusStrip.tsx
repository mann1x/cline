import { StringRequest } from "@shared/proto/cline/common"
import type { PolykvStatusResponse } from "@shared/proto/cline/models"
import { useEffect, useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"

/**
 * What the configured opencoti server is actually doing, read once.
 *
 * Every number here comes from `/props`, `/polykv/pools` or `/polykv/tps`,
 * which are served from a published snapshot and are safe to read while the
 * server is busy. `/capacity` is not on that list and must never be added: on
 * the published c7 engine every GET of it folds the settle and bias EWMAs the
 * admission projection is built from, so a strip that refreshed would corrupt
 * the measurement it was drawing. `kv_headroom_pct` and the SWA arm live only
 * there, which is why they are not shown.
 *
 * Read once on mount, deliberately. There is nothing here worth a timer, and a
 * panel that polls is the habit that would eventually be pointed at the one
 * endpoint that cannot take it.
 *
 * Pool ages are absent for their own reason: on c7 the pool timestamps are
 * monotonic stamps since boot rather than epoch seconds, so rendering either
 * the value or its distance from now gives a number that is simply wrong.
 */
export const PolykvStatusStrip = ({ providerId }: { providerId: string }) => {
	const [status, setStatus] = useState<PolykvStatusResponse | undefined>()
	const [failed, setFailed] = useState(false)

	useEffect(() => {
		let cancelled = false
		ModelsServiceClient.readPolykvStatus(StringRequest.create({ value: providerId }))
			.then((next) => {
				if (!cancelled) {
					setStatus(next)
				}
			})
			.catch(() => {
				if (!cancelled) {
					setFailed(true)
				}
			})
		return () => {
			cancelled = true
		}
	}, [providerId])

	if (failed || (status && !status.reachable)) {
		return (
			<p className="text-xs mt-[10px] text-(--vscode-descriptionForeground)">
				The server could not be reached, so nothing is known about its pools. This says nothing about whether it has them.
			</p>
		)
	}
	if (!status) {
		return null
	}

	const slots =
		status.slotsLive !== undefined && status.slotsMax !== undefined
			? `${status.slotsLive} of ${status.slotsMax} slots live`
			: undefined

	return (
		<div className="mt-[10px] text-xs text-(--vscode-descriptionForeground) flex flex-col gap-[4px]">
			<div>
				{status.release ? `opencoti ${status.release}` : "opencoti"}
				{status.poolsEnabled ? " · pools on" : " · pools off"}
				{status.elastic ? " · elastic" : ""}
			</div>
			{slots && (
				<div>
					{slots}
					{status.elasticReason ? ` — ${status.elasticReason}` : ""}
				</div>
			)}
			{status.vramFreeMib !== undefined && <div>{status.vramFreeMib} MiB VRAM free</div>}
			{status.pools.length > 0 && (
				<div className="flex flex-col gap-[2px]">
					<div>
						{status.pools.length} of {status.poolsMax ?? status.pools.length} pools
						{status.treeDepth !== undefined ? `, ${status.treeDepth} deep` : ""}
					</div>
					{status.pools.map((pool) => (
						<div className="pl-[10px]" key={pool.poolId}>
							<code>#{pool.poolId}</code>
							{pool.parent !== undefined ? ` from #${pool.parent}` : " root"}
							{pool.prefixLen !== undefined ? ` · ${pool.prefixLen.toLocaleString()} tokens` : ""}
							{pool.pinned ? " · pinned" : ""}
							{pool.ephemeral ? " · ephemeral" : ""}
							{pool.sourceSession ? ` · from ${pool.sourceSession}` : ""}
							{pool.orphanedPin && (
								<span className="text-(--vscode-errorForeground)"> · orphaned pin, nothing will reclaim it</span>
							)}
						</div>
					))}
				</div>
			)}
			{status.sessions.length > 0 && (
				<div className="flex flex-col gap-[2px]">
					<div>{status.sessions.length} live sessions</div>
					{status.sessions.map((session) => (
						<div className="pl-[10px]" key={session.sessionId}>
							<code>{session.sessionId}</code>
							{session.tps !== undefined
								? ` · ${session.tps.toFixed(1)} tok/s`
								: session.active
									? " · warming"
									: " · idle"}
							{session.ctxUsed !== undefined && session.ctxTotal !== undefined
								? ` · ${session.ctxUsed.toLocaleString()} of ${session.ctxTotal.toLocaleString()} ctx`
								: ""}
						</div>
					))}
				</div>
			)}
		</div>
	)
}

export default PolykvStatusStrip
