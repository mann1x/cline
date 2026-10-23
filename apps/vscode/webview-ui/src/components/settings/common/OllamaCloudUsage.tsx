import type { OllamaCloudLimit, OllamaCloudUsageResponse } from "@shared/proto/cline/models"
import { OllamaReachabilityRequest } from "@shared/proto/cline/models"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState } from "react"
import { ModelsServiceClient } from "@/services/grpc-client"

/**
 * The ollama.com account's balance and usage, read through the configured
 * Ollama or xOllama server (`/api/balance`, `/api/usage`; Ollama 0.40.6+).
 *
 * Polled once a minute while mounted. The host caches per server and never
 * asks ollama.com more often than that -- the 7d and 30d ranges only every
 * five minutes, and a 429 is waited out -- so a settings panel and a task
 * header open at once cost one read between them.
 */
export const OLLAMA_CLOUD_USAGE_POLL_MS = 60_000

export function useOllamaCloudUsage(providerId: string | undefined, modelId?: string): OllamaCloudUsageResponse | undefined {
	const [usage, setUsage] = useState<OllamaCloudUsageResponse | undefined>()

	useEffect(() => {
		setUsage(undefined)
		if (providerId !== "ollama" && providerId !== "xollama") {
			return
		}
		let cancelled = false
		const read = () => {
			ModelsServiceClient.readOllamaCloudUsage(OllamaReachabilityRequest.create({ providerId, modelId }))
				.then((next) => {
					if (!cancelled) {
						setUsage(next)
					}
				})
				.catch(() => {
					// A failed RPC keeps the last answer: one dropped poll is not news.
				})
		}
		read()
		const timer = setInterval(read, OLLAMA_CLOUD_USAGE_POLL_MS)
		return () => {
			cancelled = true
			clearInterval(timer)
		}
	}, [providerId, modelId])

	return usage
}

/** What is left, never rounded up: 99.97 reads 99.9, not 100. */
export function formatRemaining(percent: number): string {
	const floored = Math.floor(percent * 10) / 10
	return `${Number.isInteger(floored) ? floored.toFixed(0) : floored.toFixed(1)}%`
}

/** "in 1h 52m", "in 2d 3h", "now" -- from `nowMs` to an ISO time. */
export function formatResetsIn(iso: string | undefined, nowMs: number = Date.now()): string | undefined {
	if (!iso) {
		return undefined
	}
	const at = Date.parse(iso)
	if (!Number.isFinite(at)) {
		return undefined
	}
	const minutes = Math.max(0, Math.round((at - nowMs) / 60_000))
	if (minutes === 0) {
		return "now"
	}
	const days = Math.floor(minutes / 1440)
	const hours = Math.floor((minutes % 1440) / 60)
	const rest = minutes % 60
	if (days > 0) {
		return `in ${days}d${hours > 0 ? ` ${hours}h` : ""}`
	}
	if (hours > 0) {
		return `in ${hours}h${rest > 0 ? ` ${rest}m` : ""}`
	}
	return `in ${rest}m`
}

function formatUsd(value: number): string {
	return `$${value.toFixed(2)}`
}

function localTime(iso: string | undefined): string | undefined {
	const at = iso ? Date.parse(iso) : Number.NaN
	return Number.isFinite(at) ? new Date(at).toLocaleString() : undefined
}

function limitLine(label: string, limit: OllamaCloudLimit, nowMs: number): string {
	const resets = formatResetsIn(limit.resetsAt, nowMs)
	return `${label}: ${formatRemaining(limit.remainingPercent)} left${resets ? ` · resets ${resets}` : ""}`
}

/** Below this much left, a limit is shown in the warning colour. */
const LOW_PERCENT = 10

/**
 * The account's limits and recent usage, for the Ollama and xOllama settings.
 *
 * Renders nothing for a server that cannot be reached: the account strip and
 * the status dot already say so, and a third voice saying it adds nothing.
 */
export const OllamaCloudUsageStrip = ({ providerId }: { providerId: "ollama" | "xollama" }) => {
	const usage = useOllamaCloudUsage(providerId)
	if (!usage || usage.state === "unreachable") {
		return null
	}

	const note = (() => {
		switch (usage.state) {
			case "signed-out":
				return (
					<>
						Cloud usage needs this server signed in to ollama.com
						{usage.signinUrl ? (
							<>
								{" — "}
								<VSCodeLink className="text-xs" href={usage.signinUrl}>
									sign in
								</VSCodeLink>
							</>
						) : null}
					</>
				)
			case "cloud-disabled":
				return <>Cloud features are turned off on this server, so it reports no cloud usage.</>
			case "unsupported":
				return <>This server does not report cloud usage; that needs Ollama 0.40.6 or later.</>
			case "rate-limited":
				return <>ollama.com is limiting how often usage can be read; it will be read again shortly.</>
			default:
				return undefined
		}
	})()
	if (note) {
		return <div className="mt-[6px] text-xs text-(--vscode-descriptionForeground)">{note}</div>
	}

	const nowMs = Date.now()
	const included =
		usage.includedBalanceUsd !== undefined
			? `Included: ${formatUsd(usage.includedBalanceUsd)}${
					usage.includedAllowanceUsd !== undefined ? ` of ${formatUsd(usage.includedAllowanceUsd)}` : ""
				} left${formatResetsIn(usage.periodUntil, nowMs) ? ` · resets ${formatResetsIn(usage.periodUntil, nowMs)}` : ""}`
			: undefined
	const requests = usage.usage
		.map(
			(totals) =>
				`${Number(totals.requestCount).toLocaleString()} in ${totals.range}${
					totals.usageUsd !== undefined ? ` (${formatUsd(totals.usageUsd)})` : ""
				}`,
		)
		.join(" · ")
	const limitClass = (limit: OllamaCloudLimit | undefined) =>
		limit && limit.remainingPercent <= 0
			? "text-(--vscode-errorForeground)"
			: limit && limit.remainingPercent < LOW_PERCENT
				? "text-(--vscode-editorWarning-foreground)"
				: undefined

	return (
		<div
			className="mt-[6px] text-xs text-(--vscode-descriptionForeground) flex flex-col gap-[2px]"
			title={usage.readAt ? `Read ${localTime(usage.readAt)}, at most once a minute` : undefined}>
			<div className="font-semibold">Cloud usage</div>
			{usage.session && <div className={limitClass(usage.session)}>{limitLine("Session limit", usage.session, nowMs)}</div>}
			{usage.weekly && <div className={limitClass(usage.weekly)}>{limitLine("Weekly limit", usage.weekly, nowMs)}</div>}
			{included && (
				<div
					className={
						usage.includedExhausted && usage.includedBalanceUsd !== undefined
							? "text-(--vscode-errorForeground)"
							: undefined
					}>
					{included}
				</div>
			)}
			{usage.purchasedBalanceUsd !== undefined && <div>Purchased credit: {formatUsd(usage.purchasedBalanceUsd)}</div>}
			{requests && <div>Requests: {requests}</div>}
		</div>
	)
}

/**
 * The cloud limits on one line in the task header, for a cloud model only.
 *
 * Until the server proxied `/api/balance` the header could only say the limit
 * had been reached after a request was refused for it. This says how much is
 * left before that, and when it resets once it is gone.
 */
export const OllamaCloudLimitLine = ({
	providerId,
	modelId,
}: {
	providerId: string | undefined
	modelId: string | undefined
}) => {
	const usage = useOllamaCloudUsage(providerId, modelId || undefined)
	if (!usage || usage.state !== "ok" || usage.cloudModel !== true) {
		return null
	}
	const nowMs = Date.now()
	const limits = [
		usage.session ? { name: "session", limit: usage.session } : undefined,
		usage.weekly ? { name: "weekly", limit: usage.weekly } : undefined,
	].filter((entry): entry is { name: string; limit: OllamaCloudLimit } => entry !== undefined)

	const credit =
		usage.purchasedBalanceUsd !== undefined && usage.purchasedBalanceUsd > 0
			? ` · ${formatUsd(usage.purchasedBalanceUsd)} credit`
			: ""

	let text: string
	let tone = "text-description"
	if (usage.includedExhausted) {
		// The reset that matters is the one that brings it back: the latest of
		// the spent limits.
		const spent = limits.filter((entry) => entry.limit.remainingPercent <= 0)
		const resetIso =
			spent.length > 0
				? spent
						.map((entry) => entry.limit.resetsAt)
						.sort()
						.at(-1)
				: usage.periodUntil
		const resets = formatResetsIn(resetIso, nowMs)
		const which = spent.length > 0 ? spent.map((entry) => entry.name).join(" and ") : "included"
		text = `Cloud ${which} limit reached${resets ? ` · resets ${resets}` : ""}${credit}`
		tone = "text-error"
	} else if (limits.length > 0) {
		text = `Cloud: ${limits.map((entry) => `${entry.name} ${formatRemaining(entry.limit.remainingPercent)} left`).join(" · ")}`
		if (limits.some((entry) => entry.limit.remainingPercent < LOW_PERCENT)) {
			tone = "text-warning"
		}
	} else if (usage.includedBalanceUsd !== undefined) {
		text = `Cloud: ${formatUsd(usage.includedBalanceUsd)}${
			usage.includedAllowanceUsd !== undefined ? ` of ${formatUsd(usage.includedAllowanceUsd)}` : ""
		} left`
	} else {
		return null
	}

	const detail = [
		...limits.map((entry) => limitLine(`${entry.name[0]?.toUpperCase()}${entry.name.slice(1)} limit`, entry.limit, nowMs)),
		usage.purchasedBalanceUsd !== undefined ? `Purchased credit: ${formatUsd(usage.purchasedBalanceUsd)}` : undefined,
		usage.readAt ? `Read ${localTime(usage.readAt)}; refreshed once a minute.` : undefined,
	]
		.filter(Boolean)
		.join("\n")

	return (
		<div className={`mt-0.5 text-xs ${tone}`} title={detail}>
			{text}
		</div>
	)
}
