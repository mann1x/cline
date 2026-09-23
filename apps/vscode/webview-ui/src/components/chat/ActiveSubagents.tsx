import type { ClineMessage, ClineSaySubagentStatus, SubagentStatusItem } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import { ClockIcon, LoaderCircleIcon, SquareIcon, XIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"
import { subagentIdentity } from "./subagentIdentity"

/**
 * The agents working right now, above the conversation rather than inside it.
 *
 * A sub-agent's row scrolls away with the message that started it, so the
 * moment the lead says anything the only sign that three agents are running is
 * off-screen. Measured on pandorum 2026-09-22: a fan-out of three took four
 * minutes, during which the chat showed the lead's last tool call and nothing
 * else -- there was no way to tell whether the agents were working, queued or
 * dead without opening the extension log.
 *
 * Derived from the conversation, not polled: the status the rich row renders
 * is already streamed into the chat as say:"subagent", so this reads the most
 * recent one. Nothing new crosses the wire, and the strip cannot disagree with
 * the row further down.
 */

/** Running or pending -- the ones there is still something to watch. */
/**
 * What to call the node an agent ran on.
 *
 * The label the settings panel uses (`Node1`, `Node2`), falling back to the
 * stored id for a run recorded before nodes were named. The id on its own --
 * `node-mucuczcm` -- is a storage key the panel never shows, so it named a
 * machine the reader had no way to look up.
 */
function nodeNameOf(item: SubagentStatusItem): string | undefined {
	return item.nodeLabel ?? item.nodeId
}

function isLive(item: SubagentStatusItem): boolean {
	return item.status === "running" || item.status === "pending"
}

/**
 * The live sub-agents, from the most recent status message.
 *
 * Only the last one is read. Each say:"subagent" message replaces the previous
 * one for the same batch -- they share a timestamp -- and a batch that has
 * finished says so in its own items, so scanning further back would resurrect
 * agents that are already done.
 */
export function liveSubagentsFrom(messages: ClineMessage[]): SubagentStatusItem[] {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (message?.say !== "subagent" || !message.text) {
			continue
		}
		try {
			const parsed = JSON.parse(message.text) as ClineSaySubagentStatus
			if (!Array.isArray(parsed.items)) {
				return []
			}
			return parsed.items.filter(isLive)
		} catch {
			return []
		}
	}
	return []
}

/**
 * How an agent is doing, as an icon: working, or waiting for a slot.
 *
 * Per agent and not one for the whole strip: a queued agent and a working one
 * looked the same under a single spinner, and telling them apart is the reason
 * this strip exists.
 */
function StatusIcon({ agent }: { agent: SubagentStatusItem }) {
	return agent.status === "running" ? (
		<LoaderCircleIcon aria-label="running" className="size-3 shrink-0 animate-spin text-link" />
	) : (
		<ClockIcon aria-label="queued" className="size-3 shrink-0 text-description" />
	)
}

/** The last few lines of what the agent is writing, newest last. */
function outputTail(agent: SubagentStatusItem): string | undefined {
	const text = agent.latestOutput?.trim()
	if (!text) {
		return undefined
	}
	return text.split("\n").slice(-6).join("\n")
}

function AgentDetail({
	agent,
	onClose,
	onStop,
	stopping,
}: {
	agent: SubagentStatusItem
	onClose: () => void
	onStop?: () => void
	stopping: boolean
}) {
	const identity = subagentIdentity(agent.index, agent.agentName)
	const node = nodeNameOf(agent)
	const doing = agent.latestToolCall?.trim() || (agent.status === "pending" ? "queued" : "thinking")
	const stats = [
		`${agent.toolCalls} tool${agent.toolCalls === 1 ? "" : "s"}`,
		agent.contextTokens ? `${Intl.NumberFormat("en-US").format(agent.contextTokens)} tokens` : "",
	].filter(Boolean)
	const tail = outputTail(agent)

	return (
		<div className="mt-2 rounded-xs border border-editor-group-border bg-code px-2.5 py-2">
			<div className="flex items-center gap-2">
				<StatusIcon agent={agent} />
				<span
					className="inline-block min-w-0 truncate rounded-xs border px-1.5 py-[1px] text-[10px] font-medium text-foreground"
					style={identity.style}>
					{identity.label}
				</span>
				<span className="min-w-0 flex-1 truncate font-mono text-[10px] opacity-70">{doing}</span>
				<button
					aria-label="Close agent details"
					className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-foreground opacity-60 hover:opacity-100"
					onClick={onClose}
					type="button">
					<XIcon className="size-3" />
				</button>
			</div>
			{/* Below the name, inside the box it belongs to: the stop is a
			    decision about one agent, taken after looking at it. Absent on a
			    run recorded before agents carried a stop id, rather than shown
			    and doing nothing. */}
			{onStop && (
				<button
					aria-label={`Stop ${identity.label}`}
					className="mt-1.5 flex cursor-pointer items-center gap-1 rounded-xs border border-editor-group-border bg-transparent px-1.5 py-[1px] text-[10px] text-foreground opacity-80 hover:opacity-100 disabled:cursor-default disabled:opacity-40"
					disabled={stopping}
					onClick={onStop}
					title={stopping ? `Stopping ${identity.label}…` : `Stop ${identity.label}`}
					type="button">
					<SquareIcon className="size-2.5 fill-current" />
					<span>{stopping ? "Stopping…" : "Stop"}</span>
				</button>
			)}
			<div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] opacity-70">
				{node && <span>on {node}</span>}
				{agent.modelId && <span className="min-w-0 truncate">{agent.modelId}</span>}
				{stats.length > 0 && <span>{stats.join(" · ")}</span>}
			</div>
			{/* What it was asked to do. */}
			<div className="mt-1.5 max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[11px] text-foreground opacity-90">
				{agent.prompt}
			</div>
			{tail && (
				<div className="mt-1.5">
					<div className="text-[10px] opacity-60">{agent.latestOutputKind === "reasoning" ? "Thinking" : "Output"}</div>
					<pre
						className={`m-0 max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] ${
							agent.latestOutputKind === "reasoning" ? "italic opacity-60" : "opacity-80"
						}`}>
						{tail}
					</pre>
				</div>
			)}
		</div>
	)
}

export function ActiveSubagents({ messages }: { messages: ClineMessage[] }) {
	const agents = useMemo(() => liveSubagentsFrom(messages), [messages])
	const [openIndex, setOpenIndex] = useState<number | undefined>(undefined)

	// An agent that finishes while its panel is open would otherwise leave the
	// panel showing a running agent that is not running any more.
	useEffect(() => {
		if (openIndex !== undefined && !agents.some((agent) => agent.index === openIndex)) {
			setOpenIndex(undefined)
		}
	}, [agents, openIndex])

	const toggle = useCallback((index: number) => {
		setOpenIndex((previous) => (previous === index ? undefined : index))
	}, [])

	// Which agents have been asked to stop. The tag stays until the agent
	// actually ends -- an abort is a request, and the run may be inside a
	// model call that has to come back first -- so without this the button
	// would look like it had done nothing and invite a second press.
	const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set())
	const stop = useCallback((cancelId: string) => {
		setStopping((previous) => new Set(previous).add(cancelId))
		TaskServiceClient.cancelSubagent(StringRequest.create({ value: cancelId })).catch((error) => {
			console.error("Failed to stop sub-agent:", error)
			setStopping((previous) => {
				const next = new Set(previous)
				next.delete(cancelId)
				return next
			})
		})
	}, [])

	if (agents.length === 0) {
		return null
	}

	const open = agents.find((agent) => agent.index === openIndex)
	const running = agents.filter((agent) => agent.status === "running").length
	const queued = agents.length - running

	return (
		<div className="shrink-0">
			{/* Bounded, and scrolling inside itself: fifty tags and an open
			    agent must not push the conversation off the screen. */}
			<div className="mx-3 mt-1.5 mb-2 max-h-[40vh] overflow-y-auto rounded-xs border border-editor-group-border bg-code/70 px-2.5 py-2">
				<div className="flex flex-wrap items-center gap-1">
					<span className="mr-1 text-xs font-medium text-description">
						{agents.length === 1 ? "1 agent working" : `${agents.length} agents working`}
						{queued > 0 && running > 0 && (
							<span className="ml-1 font-normal opacity-70">
								({running} running, {queued} queued)
							</span>
						)}
					</span>
					{agents.map((agent) => {
						const identity = subagentIdentity(agent.index, agent.agentName)
						const isOpen = agent.index === openIndex
						return (
							<button
								aria-expanded={isOpen}
								aria-label={`${identity.label} (${agent.status === "running" ? "running" : "queued"})`}
								className={`flex max-w-[12rem] cursor-pointer items-center gap-1 rounded-xs border px-1.5 py-[1px] text-left text-[10px] font-medium text-foreground ${
									isOpen ? "ring-1 ring-link" : ""
								}`}
								key={agent.index}
								onClick={() => toggle(agent.index)}
								style={identity.style}
								type="button">
								<StatusIcon agent={agent} />
								<span className="min-w-0 truncate">{identity.label}</span>
							</button>
						)
					})}
				</div>
				{open && (
					<AgentDetail
						agent={open}
						onClose={() => setOpenIndex(undefined)}
						{...(open.cancelId ? { onStop: () => stop(open.cancelId as string) } : {})}
						stopping={open.cancelId !== undefined && stopping.has(open.cancelId)}
					/>
				)}
			</div>
		</div>
	)
}

export default ActiveSubagents
