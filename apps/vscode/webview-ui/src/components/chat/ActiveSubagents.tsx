import type { ClineMessage, ClineSaySubagentStatus, SubagentStatusItem } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import { ChevronDownIcon, LoaderCircleIcon, SquareIcon, XIcon } from "lucide-react"
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

function AgentDetail({ agent, onClose }: { agent: SubagentStatusItem; onClose: () => void }) {
	const identity = subagentIdentity(agent.index, agent.agentName)
	const stats = [
		`${agent.toolCalls} tool${agent.toolCalls === 1 ? "" : "s"}`,
		agent.contextTokens ? `${Intl.NumberFormat("en-US").format(agent.contextTokens)} tokens` : "",
		nodeNameOf(agent) ? `on ${nodeNameOf(agent)}` : "",
		agent.modelId ?? "",
	].filter(Boolean)

	return (
		<div className="mx-3 mb-2 rounded-xs border border-editor-group-border bg-code/70 px-2.5 py-2">
			<div className="flex items-start gap-2">
				<span
					className="mt-[1px] inline-block shrink-0 rounded-xs border px-1.5 py-[1px] text-[10px] font-medium text-foreground"
					style={identity.style}>
					{identity.label}
				</span>
				<div className="min-w-0 flex-1">
					{/* What it was asked to do. This is the thing a reader wants
					    when they click an agent, and it is the one field the
					    strip itself has no room for. */}
					<div className="whitespace-pre-wrap break-words text-[11px] text-foreground opacity-90">{agent.prompt}</div>
					{stats.length > 0 && <div className="mt-1 text-[10px] opacity-60">{stats.join(" · ")}</div>}
					{agent.latestToolCall?.trim() && (
						<div className="mt-1 truncate font-mono text-[10px] opacity-70">{agent.latestToolCall.trim()}</div>
					)}
				</div>
				<button
					aria-label="Close agent details"
					className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-foreground opacity-60 hover:opacity-100"
					onClick={onClose}
					type="button">
					<XIcon className="size-3" />
				</button>
			</div>
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

	// Which agents have been asked to stop. The row stays until the agent
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

	return (
		<div className="shrink-0">
			<div className="mx-3 mt-1.5 mb-2 rounded-xs border border-editor-group-border bg-code/70 px-2.5 py-2">
				<div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-description">
					<LoaderCircleIcon className="size-3 animate-spin text-link" />
					<span>{agents.length === 1 ? "1 agent working" : `${agents.length} agents working`}</span>
				</div>
				<div className="flex flex-col gap-1">
					{agents.map((agent) => {
						const identity = subagentIdentity(agent.index, agent.agentName)
						const isOpen = agent.index === openIndex
						// What it is doing, in the order of how much it says: the
						// tool it is running now, else that it has not started one.
						const doing = agent.latestToolCall?.trim() || (agent.status === "pending" ? "queued" : "thinking")
						const isStopping = agent.cancelId !== undefined && stopping.has(agent.cancelId)
						return (
							<div className="flex w-full items-center gap-1.5" key={agent.index}>
								<button
									aria-expanded={isOpen}
									aria-label={`${identity.label}: ${doing}`}
									className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left"
									onClick={() => toggle(agent.index)}
									type="button">
									{/* A spinner per agent, not one for the strip: a
								    queued agent and a working one look the same
								    otherwise, and telling them apart is the whole
								    reason this strip exists. */}
									{agent.status === "running" ? (
										<LoaderCircleIcon className="size-2 shrink-0 animate-spin text-link" />
									) : (
										<span className="size-2 shrink-0 rounded-full border border-description opacity-60" />
									)}
									<span
										className="inline-block shrink-0 rounded-xs border px-1.5 py-[1px] text-[10px] font-medium text-foreground"
										style={identity.style}>
										{identity.label}
									</span>
									{nodeNameOf(agent) && (
										<span className="shrink-0 text-[10px] opacity-60">{nodeNameOf(agent)}</span>
									)}
									<span className="min-w-0 flex-1 truncate font-mono text-[10px] opacity-70">{doing}</span>
									<ChevronDownIcon
										className={`size-2 shrink-0 opacity-60 transition-transform ${isOpen ? "" : "-rotate-90"}`}
									/>
								</button>
								{/* Its own control, outside the row's button: one
							    agent stops without touching the session or the
							    siblings that are working. Absent on a run
							    recorded before agents carried a stop id, rather
							    than shown and doing nothing. */}
								{agent.cancelId && (
									<button
										aria-label={`Stop ${identity.label}`}
										className="shrink-0 cursor-pointer border-0 bg-transparent p-0 opacity-50 hover:opacity-100 disabled:cursor-default disabled:opacity-30"
										disabled={isStopping}
										onClick={() => stop(agent.cancelId as string)}
										title={isStopping ? `Stopping ${identity.label}…` : `Stop ${identity.label}`}
										type="button">
										<SquareIcon className="size-2.5 fill-current" />
									</button>
								)}
							</div>
						)
					})}
				</div>
			</div>
			{open && <AgentDetail agent={open} onClose={() => setOpenIndex(undefined)} />}
		</div>
	)
}

export default ActiveSubagents
