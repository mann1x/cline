import type { OllamaCloudLimit, OllamaCloudUsageResponse } from "@shared/proto/cline/models"
import { OllamaReachabilityRequest } from "@shared/proto/cline/models"
import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import type React from "react"
import { useEffect, useState } from "react"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { ModelsServiceClient } from "@/services/grpc-client"
import { updateSetting } from "../utils/settingsHandlers"

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

/**
 * What is used, as ollama.com shows it: the complement of `formatRemaining`, in
 * whole tenths so the two always add up to 100 (23.1% left is 76.9% used).
 */
export function formatUsed(remainingPercent: number): string {
	const tenths = 1000 - Math.floor(remainingPercent * 10 + 1e-9)
	return `${tenths % 10 === 0 ? (tenths / 10).toFixed(0) : (tenths / 10).toFixed(1)}%`
}

function formatUsd(value: number): string {
	return `$${value.toFixed(2)}`
}

function localTime(iso: string | undefined): string | undefined {
	const at = iso ? Date.parse(iso) : Number.NaN
	return Number.isFinite(at) ? new Date(at).toLocaleString() : undefined
}

function resetsAfter(limit: OllamaCloudLimit, nowMs: number): string | undefined {
	const resets = formatResetsIn(limit.resetsAt, nowMs)
	return resets ? `resets ${resets}` : undefined
}

function limitLine(label: string, limit: OllamaCloudLimit, nowMs: number): string {
	const resets = resetsAfter(limit, nowMs)
	return `${label}: ${formatUsed(limit.remainingPercent)} used${resets ? ` · ${resets}` : ""}`
}

/** Below this much left, a limit is shown in the warning colour. */
const LOW_PERCENT = 10

function limitTone(limit: OllamaCloudLimit): { text?: string; fill: string } {
	if (limit.remainingPercent <= 0) {
		return { text: "text-(--vscode-errorForeground)", fill: "bg-(--vscode-errorForeground)" }
	}
	if (limit.remainingPercent < LOW_PERCENT) {
		return { text: "text-(--vscode-editorWarning-foreground)", fill: "bg-(--vscode-editorWarning-foreground)" }
	}
	return { fill: "bg-(--vscode-progressBar-background)" }
}

/**
 * One limit as ollama.com's settings draw it: the name, a bar filling as the
 * limit is used, and the percentage used on the right. It said "% left" until
 * 4.100.266, and "session 23.1% left" was read as 23.1% used.
 */
const LimitBar = ({ label, limit, after }: { label: string; limit: OllamaCloudLimit; after?: string }) => {
	const tone = limitTone(limit)
	const used = formatUsed(limit.remainingPercent)
	return (
		<>
			<span className={tone.text}>{label}</span>
			<div
				aria-label={`${label}: ${used} used`}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={100 - limit.remainingPercent}
				className="relative h-1.5 w-full overflow-hidden rounded-full bg-code-foreground/20"
				role="progressbar">
				<div className={`h-full ${tone.fill}`} style={{ width: `${100 - limit.remainingPercent}%` }} />
			</div>
			<span className={`tabular-nums text-right ${tone.text ?? ""}`}>
				{used} used{after ? ` · ${after}` : ""}
			</span>
		</>
	)
}

/** Rows of `LimitBar`, their bars lined up in one column. */
const LimitBars = ({ children }: { children: React.ReactNode }) => (
	<div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-[3px]">{children}</div>
)

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
	return (
		<div
			className="mt-[6px] text-xs text-(--vscode-descriptionForeground) flex flex-col gap-[2px]"
			title={usage.readAt ? `Read ${localTime(usage.readAt)}, at most once a minute` : undefined}>
			<div className="font-semibold">Cloud usage</div>
			{(usage.session || usage.weekly) && (
				<LimitBars>
					{usage.session && (
						<LimitBar after={resetsAfter(usage.session, nowMs)} label="Session" limit={usage.session} />
					)}
					{usage.weekly && <LimitBar after={resetsAfter(usage.weekly, nowMs)} label="Weekly" limit={usage.weekly} />}
				</LimitBars>
			)}
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

	const detail = [
		...limits.map((entry) => limitLine(`${entry.name[0]?.toUpperCase()}${entry.name.slice(1)} limit`, entry.limit, nowMs)),
		usage.purchasedBalanceUsd !== undefined ? `Purchased credit: ${formatUsd(usage.purchasedBalanceUsd)}` : undefined,
		usage.readAt ? `Read ${localTime(usage.readAt)}; refreshed once a minute.` : undefined,
	]
		.filter(Boolean)
		.join("\n")

	let text: string | undefined
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
		text = undefined
	} else if (usage.includedBalanceUsd !== undefined) {
		text = `Cloud: ${formatUsd(usage.includedBalanceUsd)}${
			usage.includedAllowanceUsd !== undefined ? ` of ${formatUsd(usage.includedAllowanceUsd)}` : ""
		} left`
	} else {
		return null
	}

	return (
		<div className="mt-0.5 text-xs text-description flex flex-col gap-[3px]" title={detail}>
			{limits.length > 0 && (
				<LimitBars>
					{limits.map((entry) => (
						<LimitBar key={entry.name} label={`Cloud ${entry.name}`} limit={entry.limit} />
					))}
				</LimitBars>
			)}
			{text && <div className={tone}>{text}</div>}
		</div>
	)
}

/**
 * The switch for `OllamaCloudLimitLine`: the bars take two rows of the task
 * header, so they can be hidden. On by default; this panel's own strip shows
 * the limits either way.
 */
export const OllamaCloudUsageHeaderToggle = () => {
	const { showCloudUsageInTaskHeader } = useExtensionState()

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between w-full">
				<Label className="text-xs font-medium text-foreground" htmlFor="showCloudUsageInTaskHeader">
					Show cloud usage in the task header
				</Label>
				<Switch
					checked={showCloudUsageInTaskHeader !== false}
					className="shrink-0"
					id="showCloudUsageInTaskHeader"
					onCheckedChange={(checked) => updateSetting("showCloudUsageInTaskHeader", checked)}
					size="default"
				/>
			</div>
			<p className="text-xs mt-0 mb-0 text-description">
				A bar each for the session and weekly limits under the context window, while a cloud model is selected. Applies to
				Ollama and xOllama.
			</p>
		</div>
	)
}
