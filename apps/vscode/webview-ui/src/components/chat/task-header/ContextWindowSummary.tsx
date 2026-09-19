import type { ContextBreakdown } from "@shared/ExtensionMessage"
import type { ProviderApiMetrics } from "@shared/getApiMetrics"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import React, { memo, useCallback, useMemo, useState } from "react"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"
import { formatRate } from "@/utils/request-timings"
import { describeConnection } from "./ConnectionBreakdown"
import { CONTEXT_SEGMENT_COLORS } from "./ContextWindowBar"

interface TokenUsageInfoProps {
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	/** What each connection spent, when the task used more than the session's. */
	byProvider?: ProviderApiMetrics[]
	/** Generation throughput across every request that reported timings. */
	generateTokens?: number
	generateMs?: number
}

interface TokenDetail {
	title: string
	value?: number
	icon: string
}

interface TaskContextWindowButtonsProps extends TokenUsageInfoProps {
	percentage: number
	tokenUsed: number
	contextWindow: number
	autoCompactThreshold?: number
	/** The fixed price of the last request, as the bar's colours show it. */
	breakdown?: ContextBreakdown
	isThresholdChanged?: boolean
	isThresholdFadingOut?: boolean
}

// New accordion item component
const AccordionItem = memo<{
	title: string
	value: React.ReactNode
	isExpanded: boolean
	onToggle: (event?: React.MouseEvent) => void
	children?: React.ReactNode
}>(({ title, value, isExpanded, onToggle, children }) => {
	const handleClick = useCallback(
		(event: React.MouseEvent) => {
			event.preventDefault()
			event.stopPropagation()
			onToggle(event)
		},
		[onToggle],
	)

	return (
		<div className="flex flex-col w-full">
			<div
				className="flex justify-between items-center gap-1 cursor-pointer hover:bg-foreground/5 rounded p-0.5 transition-colors w-full"
				onClick={handleClick}>
				<div className="flex items-center gap-1">
					{isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
					<div className="font-semibold">{title}</div>
				</div>
				<div className="text-muted-foreground">{value}</div>
			</div>
			{isExpanded && children && <div className="ml-5 my-1 text-xs text-muted-foreground">{children}</div>}
		</div>
	)
})
AccordionItem.displayName = "AccordionItem"

// Constants
const TOKEN_DETAILS_CONFIG: Omit<TokenDetail, "value">[] = [
	{ title: "Prompt Tokens", icon: "codicon-arrow-up" },
	{ title: "Completion Tokens", icon: "codicon-arrow-down" },
	{ title: "Cache Writes", icon: "codicon-arrow-left" },
	{ title: "Cache Reads", icon: "codicon-arrow-right" },
]

const TokenUsageDetails = memo<TokenUsageInfoProps>(
	({ tokensIn, tokensOut, cacheWrites, cacheReads, byProvider, generateTokens, generateMs }) => {
		const contextTokenDetails = useMemo(() => {
			const values = [tokensIn, tokensOut, cacheWrites || 0, cacheReads || 0]
			return TOKEN_DETAILS_CONFIG.map((config, index) => ({ ...config, value: values[index] })).filter((item) => item.value)
		}, [tokensIn, tokensOut, cacheWrites, cacheReads])

		// Every connection the task actually billed, named. One entry is the
		// ordinary case and says nothing the totals above do not, so it is only
		// broken out when the work was genuinely split -- which is when it
		// matters, because one of those endpoints is usually free and another
		// is not.
		const connections = (byProvider ?? []).filter((entry) => entry.providerId)
		const rate = generateMs && generateMs > 0 ? formatRate(((generateTokens ?? 0) / generateMs) * 1000) : undefined

		if (!tokensIn) {
			return <div>No token usage data available</div>
		}

		return (
			<div className="space-y-1">
				{contextTokenDetails.map((item) => (
					<div className="flex justify-between" key={item.title}>
						<span>{item.title}</span>
						{/* Exact, not abbreviated: this panel is where someone
						    who wants the number comes to read it. */}
						<span className="font-mono" title={(item.value || 0).toLocaleString()}>
							{formatTokenNumber(item.value || 0)}
						</span>
					</div>
				))}
				{rate && (
					<div className="flex justify-between">
						<span>Generation Speed</span>
						<span className="font-mono">{rate}</span>
					</div>
				)}
				{connections.length > 1 && (
					<div className="mt-1.5 space-y-1 border-t border-border-panel pt-1.5">
						{connections.map((entry) => {
							const entryRate =
								entry.generateMs > 0 ? formatRate((entry.generateTokens / entry.generateMs) * 1000) : undefined
							// The same identity the header's breakdown uses: the
							// provider alone cannot tell two models apart, and a
							// sub-agent batch on the lead's own endpoint is a
							// different row that would otherwise look identical.
							const { name, role, detail } = describeConnection(entry)
							return (
								<div key={`${entry.providerId}/${entry.modelId ?? ""}/${entry.source ?? ""}`}>
									<div className="flex justify-between gap-2">
										<span className="truncate" title={`${name} — ${role}${detail ? `, ${detail}` : ""}`}>
											{name}
										</span>
										<span className="font-mono whitespace-nowrap">
											{entry.cost > 0 ? `$${entry.cost.toFixed(4)}` : "free"}
										</span>
									</div>
									<div className="flex justify-between gap-2 opacity-75">
										<span className="font-mono whitespace-nowrap">
											↑ {formatTokenNumber(entry.tokensIn)} ↓ {formatTokenNumber(entry.tokensOut)}
										</span>
										<span className="whitespace-nowrap">
											{role}
											{detail ? ` · ${detail}` : ""}
										</span>
										{entryRate && <span className="font-mono whitespace-nowrap">{entryRate}</span>}
									</div>
								</div>
							)
						})}
					</div>
				)}
			</div>
		)
	},
)
TokenUsageDetails.displayName = "TokenUsageDetails"

/** One coloured slice of the bar, named and counted. */
const LegendRow = memo<{ color: string; label: string; tokens: number; detail?: string }>(({ color, label, tokens, detail }) => (
	<div className="flex justify-between gap-2">
		<span className="flex items-center gap-1.5 truncate">
			<span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />
			<span className="truncate">{label}</span>
			{detail && <span className="opacity-75 whitespace-nowrap">{detail}</span>}
		</span>
		<span className="font-mono whitespace-nowrap" title={tokens.toLocaleString()}>
			{formatTokenNumber(tokens)}
		</span>
	</div>
))
LegendRow.displayName = "LegendRow"

export const ContextWindowSummary: React.FC<TaskContextWindowButtonsProps> = ({
	contextWindow,
	tokenUsed,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
	byProvider,
	generateTokens,
	generateMs,
	percentage,
	autoCompactThreshold = 0,
	breakdown,
}) => {
	// Accordion state
	const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set())

	const toggleSection = useCallback((section: string, event?: React.MouseEvent) => {
		if (event) {
			event.preventDefault()
			event.stopPropagation()
		}
		setExpandedSections((prev) => {
			const newSet = new Set(prev)
			if (newSet.has(section)) {
				newSet.delete(section)
			} else {
				newSet.add(section)
			}
			return newSet
		})
	}, [])

	const totalTokens = (tokensIn || 0) + (tokensOut || 0) + (cacheWrites || 0) + (cacheReads || 0)

	return (
		<div className="context-window-tooltip-content flex flex-col gap-2 bg-menu rounded shadow-sm z-100 w-60 p-1">
			{autoCompactThreshold > 0 && (
				<AccordionItem
					isExpanded={expandedSections.has("threshold")}
					onToggle={(event) => toggleSection("threshold", event)}
					title="Auto Condense Threshold"
					value={<span className="text-muted-foreground">{`${(autoCompactThreshold * 100).toFixed(0)}%`}</span>}>
					<div className="space-y-1">
						<p className="text-xs leading-relaxed text-white">
							Click on the context window bar to set a new threshold.
						</p>
						<p className="text-xs leading-relaxed mt-0 mb-0">
							When the context window usage exceeds this threshold, the task will be automatically condensed.
						</p>
					</div>
				</AccordionItem>
			)}

			<AccordionItem
				isExpanded={expandedSections.has("context")}
				onToggle={(event) => toggleSection("context", event)}
				title="Context Window"
				value={percentage ? `${percentage.toFixed(1)}%` : formatTokenNumber(contextWindow)}>
				<div className="space-y-1">
					<div className="flex justify-between">
						<span>Used:</span>
						<span className="font-mono">{formatTokenNumber(tokenUsed)}</span>
					</div>
					<div className="flex justify-between">
						<span>Total:</span>
						<span className="font-mono">{formatTokenNumber(contextWindow)}</span>
					</div>
					<div className="flex justify-between">
						<span>Remaining:</span>
						<span className="font-mono">{formatTokenNumber(contextWindow - tokenUsed)}</span>
					</div>
				</div>
			</AccordionItem>

			{breakdown && (
				<AccordionItem
					isExpanded={expandedSections.has("fixed")}
					onToggle={(event) => toggleSection("fixed", event)}
					title="Before the first message"
					value={formatTokenNumber(
						breakdown.systemPromptTokens + breakdown.builtinToolSchemaTokens + breakdown.mcpToolSchemaTokens,
					)}>
					{/* The measured numbers, not the bar's: the bar scales the
					    fixed slices down if this fork's estimate came out above
					    the provider's count for the request, and a legend that
					    reported the scaled figures would be reporting the
					    drawing rather than the measurement. */}
					<div className="space-y-1">
						<LegendRow
							color={CONTEXT_SEGMENT_COLORS.systemPrompt}
							label="System prompt"
							tokens={breakdown.systemPromptTokens}
						/>
						<LegendRow
							color={CONTEXT_SEGMENT_COLORS.builtinTools}
							detail={`${breakdown.toolCount - breakdown.mcpToolCount} tools`}
							label="Tool schemas"
							tokens={breakdown.builtinToolSchemaTokens}
						/>
						{breakdown.mcpToolCount > 0 && (
							<LegendRow
								color={CONTEXT_SEGMENT_COLORS.mcpTools}
								detail={`${breakdown.mcpToolCount} tools`}
								label="MCP tool schemas"
								tokens={breakdown.mcpToolSchemaTokens}
							/>
						)}
					</div>
				</AccordionItem>
			)}

			{totalTokens > 0 && (
				<AccordionItem
					isExpanded={expandedSections.has("tokens")}
					onToggle={(event) => toggleSection("tokens", event)}
					title="Token Usage"
					value={`${formatTokenNumber(totalTokens)}`}>
					<TokenUsageDetails
						byProvider={byProvider}
						cacheReads={cacheReads}
						cacheWrites={cacheWrites}
						generateMs={generateMs}
						generateTokens={generateTokens}
						tokensIn={tokensIn}
						tokensOut={tokensOut}
					/>
				</AccordionItem>
			)}
		</div>
	)
}
