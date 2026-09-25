import {
	ClineAskUseSubagents,
	ClineMessage,
	ClineSaySubagentStatus,
	SubagentExecutionStatus,
	SubagentStatusItem,
} from "@shared/ExtensionMessage"
import {
	BotIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleSlashIcon,
	CircleXIcon,
	LoaderCircleIcon,
	NetworkIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import MarkdownBlock from "../common/MarkdownBlock"
import { subagentCompactionDetail, subagentCompactionText } from "./subagentCompactions"
import { subagentIdentity, subagentModelLabel, subagentSamplingText, subagentSamplingTitle } from "./subagentIdentity"

interface SubagentStatusRowProps {
	message: ClineMessage
	isLast: boolean
	lastModifiedMessage?: ClineMessage
}

type DisplayStatus = SubagentExecutionStatus | "cancelled"
type SubagentRowStatus = "pending" | "running" | "completed" | "failed"

interface SubagentRowData {
	status: SubagentRowStatus
	items: SubagentStatusItem[]
	/** The session's teammates rather than one call's sub-agents. */
	kind?: "team"
}

interface SubagentPromptTextProps {
	prompt: string
	isExpanded: boolean
	/** Expand when collapsed, collapse when expanded. */
	onToggle: () => void
}

const statusIcon = (status: DisplayStatus) => {
	switch (status) {
		case "running":
			return <LoaderCircleIcon className="size-2 animate-spin text-link shrink-0 mt-[1px]" />
		case "completed":
			return <CheckIcon className="size-2 text-success shrink-0 mt-[1px]" />
		case "failed":
			return <CircleXIcon className="size-2 text-error shrink-0 mt-[1px]" />
		case "cancelled":
			return <CircleSlashIcon className="size-2 text-foreground shrink-0 mt-[1px]" />
		default:
			return <BotIcon className="size-2 text-foreground/70 shrink-0 mt-[1px]" />
	}
}

const formatCount = (value: number | undefined): string => {
	if (!Number.isFinite(value)) {
		return "0"
	}

	return Intl.NumberFormat("en-US").format(value || 0)
}

/**
 * What a sub-agent's run cost, in the three figures worth stating.
 *
 * The price only when there is one. A local endpoint costs nothing and said so
 * on every row of every run -- "1 tools called · 0 tokens · $0.00" -- which is
 * eight characters saying the same thing every time. A real price is still
 * shown, including one below a cent, because a paid run reading as free is the
 * thing this must not start doing.
 *
 * Exported so it can be tested as the string it is, rather than through the
 * row that renders it.
 */
export function subagentStatsText(entry: {
	toolCalls?: number
	compactions?: number
	contextTokens?: number
	inputTokens?: number
	outputTokens?: number
	totalCost?: number
}): string {
	// The context it holds, when that was reported; otherwise what it spent.
	// A finished agent's report carries the second only, and read "0 tokens".
	const tokens = entry.contextTokens || (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0)
	return [
		`${formatCount(entry.toolCalls)} tools called`,
		// How many times it compacted, beside the tools -- only once it has.
		subagentCompactionText(entry),
		`${formatCount(tokens)} tokens`,
		entry.totalCost ? formatCost(entry.totalCost) : "",
	]
		.filter(Boolean)
		.join(" · ")
}

/**
 * A teammate's counts. Over its whole life on the first line; on the task it
 * is running, or last ran, on the second -- when it has had one. No tokens:
 * a teammate's spend is the lead's, and a "0 tokens" on every teammate would
 * say nothing.
 */
export function teammateStatsText(entry: SubagentStatusItem): { life: string; task: string } {
	const counts = (value: { toolCalls?: number; compactions?: number }) =>
		[`${formatCount(value.toolCalls)} tools called`, subagentCompactionText(value)].filter(Boolean).join(" · ")
	return {
		life: counts(entry),
		task: entry.lastTask ? `This task: ${counts(entry.lastTask)}` : "",
	}
}

const formatCost = (value: number | undefined): string => {
	const normalized = Number.isFinite(value) ? Math.max(0, value || 0) : 0
	const maximumFractionDigits = normalized >= 0.01 ? 2 : 4
	return Intl.NumberFormat("en-US", {
		style: "currency",
		currency: "USD",
		minimumFractionDigits: 2,
		maximumFractionDigits,
	}).format(normalized)
}

function parseSubagentRowData(message: ClineMessage): SubagentRowData | null {
	if (!message.text) {
		return null
	}

	try {
		if (message.ask === "use_subagents" || message.say === "use_subagents") {
			const parsed = JSON.parse(message.text) as ClineAskUseSubagents
			if (!Array.isArray(parsed.prompts)) {
				return null
			}
			const prompts = parsed.prompts.map((prompt) => prompt?.trim()).filter((prompt): prompt is string => !!prompt)
			if (prompts.length === 0) {
				return null
			}

			const names = Array.isArray(parsed.names) ? parsed.names : []
			return {
				status: "pending",
				items: prompts.map((prompt, index) => ({
					index: index + 1,
					...(names[index] ? { agentName: names[index] } : {}),
					prompt,
					status: "pending",
					toolCalls: 0,
					inputTokens: 0,
					outputTokens: 0,
					totalCost: 0,
					contextTokens: 0,
					contextWindow: 0,
					contextUsagePercentage: 0,
				})),
			}
		}

		const parsed = JSON.parse(message.text) as ClineSaySubagentStatus
		if (!Array.isArray(parsed.items)) {
			return null
		}

		return {
			status: parsed.status,
			items: parsed.items,
			...(parsed.kind === "team" ? { kind: "team" as const } : {}),
		}
	} catch {
		return null
	}
}

function SubagentPromptText({ prompt, isExpanded, onToggle }: SubagentPromptTextProps) {
	const promptRef = useRef<HTMLDivElement | null>(null)
	const [showMoreVisible, setShowMoreVisible] = useState(false)

	useEffect(() => {
		if (isExpanded) {
			setShowMoreVisible(false)
			return
		}

		const element = promptRef.current
		if (!element) {
			setShowMoreVisible(false)
			return
		}

		const checkOverflow = () => {
			setShowMoreVisible(element.scrollHeight - element.clientHeight > 1)
		}

		checkOverflow()

		if (typeof ResizeObserver === "undefined") {
			return
		}

		const observer = new ResizeObserver(() => checkOverflow())
		observer.observe(element)

		return () => observer.disconnect()
	}, [prompt, isExpanded])

	return (
		<div className="relative">
			<div
				className={`text-xs font-medium text-foreground whitespace-pre-wrap break-words ${!isExpanded ? "overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]" : ""}`}
				ref={promptRef}>
				"{prompt}"
			</div>
			{!isExpanded && showMoreVisible && (
				<button
					aria-label="Show full subagent prompt"
					className="absolute right-0 bottom-0 z-10 text-[11px] text-link border-0 px-1 py-[1px] cursor-pointer leading-none rounded-[2px]"
					onClick={onToggle}
					style={{ backgroundColor: "var(--vscode-editor-background)" }}
					type="button">
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-y-0 -left-[6px] w-[6px]"
						style={{ background: "linear-gradient(to left, var(--vscode-editor-background), transparent)" }}
					/>
					Show more
				</button>
			)}
			{/* The way back. Without it an expanded prompt stayed open for the
			    life of the row, however long it was. */}
			{isExpanded && (
				<div className="flex justify-end">
					<button
						aria-label="Collapse subagent prompt"
						className="text-[11px] text-link border-0 bg-transparent px-1 py-[1px] cursor-pointer leading-none"
						onClick={onToggle}
						type="button">
						Show less
					</button>
				</div>
			)}
		</div>
	)
}

export default function SubagentStatusRow({ message, isLast, lastModifiedMessage }: SubagentStatusRowProps) {
	const [expandedItems, setExpandedItems] = useState<Record<number, boolean>>({})
	const [expandedPrompts, setExpandedPrompts] = useState<Record<number, boolean>>({})
	const data = useMemo(() => parseSubagentRowData(message), [message])

	if (!data) {
		return <div className="text-foreground opacity-80">Subagent status update unavailable.</div>
	}

	const resumedBeforeNextVisibleMessage =
		isLast && lastModifiedMessage?.say === "api_req_started" && (lastModifiedMessage.ts ?? 0) > message.ts

	// A teammate outlives the conversation turn that started it: its row is
	// not over because the lead said something after it.
	const wasCancelled =
		data.kind !== "team" &&
		data.status === "running" &&
		(!isLast ||
			lastModifiedMessage?.ask === "resume_task" ||
			lastModifiedMessage?.ask === "resume_completed_task" ||
			resumedBeforeNextVisibleMessage)

	const singular = data.items.length === 1
	const title =
		data.kind === "team"
			? singular
				? "Teammate:"
				: "Teammates:"
			: singular
				? "Cerebriline wants to use a subagent:"
				: "Cerebriline wants to use subagents:"
	const isPromptConstructionRow = message.ask === "use_subagents" || message.say === "use_subagents"
	const toggleItem = (index: number) => {
		setExpandedItems((prev) => ({
			...prev,
			[index]: !prev[index],
		}))
	}
	const togglePrompt = (index: number) => {
		setExpandedPrompts((prev) => ({
			...prev,
			[index]: !prev[index],
		}))
	}

	return (
		<div className="mb-2">
			<div className="flex items-center gap-2.5 mb-3">
				<NetworkIcon className="size-2 text-foreground" />
				<span className="font-bold text-foreground">{title}</span>
			</div>
			<div className="space-y-2">
				{data.items.map((entry, index) => {
					const displayStatus: DisplayStatus =
						wasCancelled && (entry.status === "running" || entry.status === "pending") ? "cancelled" : entry.status
					const hasDetails = Boolean(
						(entry.result && entry.status === "completed") || (entry.error && entry.status === "failed"),
					)
					const isExpanded = expandedItems[entry.index] === true
					const identity = subagentIdentity(entry.index, entry.agentName)
					const isStreamingPromptUnderConstruction =
						isPromptConstructionRow && message.partial === true && index === data.items.length - 1
					const shouldShowStats = !isStreamingPromptUnderConstruction
					const statsText = subagentStatsText(entry)
					const teammateStats = data.kind === "team" ? teammateStatsText(entry) : undefined
					// Where it ran, when the session has nodes to choose between.
					// A fan-out that ran one at a time looks identical to one that
					// ran in parallel until you can see that every agent landed on
					// the same node.
					// The label the settings panel uses, falling back to the id
					// for a run recorded before nodes were named. The bare id is
					// a storage key shown nowhere in the UI, so on its own it
					// named a machine the reader could not look up.
					const nodeName = entry.nodeLabel ?? entry.nodeId
					const placementText = nodeName ? `on ${nodeName}` : ""
					// provider/model beside the tag, from the moment the agent is
					// placed rather than only once its result names it (#78).
					const modelLabel = subagentModelLabel(entry)
					// The seed and temperature it ran with, when the lead set a
					// sampler -- drawn per agent for "random" -- with how they were
					// drawn in the tooltip.
					const samplingText = subagentSamplingText(entry.sampling)
					const latestToolCallText = entry.latestToolCall?.trim() || ""
					return (
						<div
							className="rounded-xs border border-editor-group-border px-2 py-1.5"
							key={entry.index}
							style={{ backgroundColor: "var(--vscode-editor-background)" }}>
							<div className="flex items-start gap-2">
								{statusIcon(displayStatus)}
								<div className="min-w-0 flex-1">
									<span
										className="inline-block mb-1 px-1.5 py-[1px] rounded-xs border text-[10px] font-medium text-foreground align-middle"
										style={identity.style}
										title={`Sub-agent ${entry.index}`}>
										{identity.label}
									</span>
									{modelLabel && (
										<span
											className="ml-1.5 mb-1 inline-block max-w-[16rem] truncate align-middle font-mono text-[10px] opacity-60"
											title={modelLabel}>
											{modelLabel}
										</span>
									)}
									<SubagentPromptText
										isExpanded={expandedPrompts[entry.index] === true}
										onToggle={() => togglePrompt(entry.index)}
										prompt={entry.prompt}
									/>
								</div>
							</div>
							{shouldShowStats && (
								<div className="mt-1 text-[11px] opacity-70 min-w-0 whitespace-pre-wrap break-words">
									<span title={subagentCompactionDetail(entry) || undefined}>
										{teammateStats ? teammateStats.life : statsText}
									</span>
									{teammateStats?.task && (
										<div
											className="text-[10px] opacity-80"
											title={
												entry.lastTask ? subagentCompactionDetail(entry.lastTask) || undefined : undefined
											}>
											{teammateStats.task}
										</div>
									)}
								</div>
							)}
							{shouldShowStats && placementText && (
								<div className="mt-0.5 text-[10px] opacity-60 min-w-0 truncate">{placementText}</div>
							)}
							{shouldShowStats && samplingText && (
								<div
									className="mt-0.5 text-[10px] opacity-60 min-w-0 truncate font-mono"
									title={subagentSamplingTitle(entry.sampling)}>
									{samplingText}
								</div>
							)}
							{shouldShowStats && hasDetails && (
								<button
									aria-label={isExpanded ? "Hide subagent output" : "Show subagent output"}
									className="mt-1 text-[11px] opacity-80 flex items-center gap-1 bg-transparent border-0 p-0 cursor-pointer text-left text-foreground w-full"
									onClick={() => toggleItem(entry.index)}
									type="button">
									{isExpanded ? (
										<ChevronDownIcon className="size-2 shrink-0" />
									) : (
										<ChevronRightIcon className="size-2 shrink-0" />
									)}
									<span className="shrink-0">{isExpanded ? "Hide output" : "Show output"}</span>
								</button>
							)}
							{shouldShowStats && !hasDetails && latestToolCallText && (
								<div className="mt-1 text-[10px] opacity-70 min-w-0 truncate font-mono">{latestToolCallText}</div>
							)}
							{isExpanded && entry.result && entry.status === "completed" && (
								<div className="mt-2 text-xs opacity-80 wrap-anywhere overflow-hidden">
									<MarkdownBlock markdown={entry.result} />
								</div>
							)}
							{isExpanded && entry.error && entry.status === "failed" && (
								<div className="mt-2 text-xs text-error whitespace-pre-wrap break-words">{entry.error}</div>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}
