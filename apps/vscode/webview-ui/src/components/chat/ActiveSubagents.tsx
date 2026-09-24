import type { ClineMessage, ClineSaySubagentStatus, SubagentActivityEntry, SubagentStatusItem } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import { ClockIcon, LoaderCircleIcon, RefreshCwIcon, SquareIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
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

/** The warning colour: one orange, readable on the light and the dark themes alike. */
const WARN_TEXT = "text-[#e8912d]"

function hasWarning(agent: SubagentStatusItem): boolean {
	return agent.activity?.some((entry) => entry.severity === "warn") ?? false
}

function clockOf(at: number): string {
	return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

/**
 * What the agent has been doing, newest last, with what went wrong marked.
 *
 * The line at the top says only what it is doing now. A fault the turn
 * survives -- the pool that shared 4 of its 5,627 tokens on every turn, the
 * node that refused it a dozen times -- was otherwise only in the logs.
 */
export function AgentActivity({ activity }: { activity: readonly SubagentActivityEntry[] }) {
	if (activity.length === 0) {
		return null
	}
	return (
		<div className="mt-1.5">
			<div className="text-[10px] opacity-60">Activity</div>
			<ol className="m-0 max-h-28 list-none overflow-y-auto p-0 font-mono text-[10px]">
				{activity.map((entry, index) => (
					<li
						className={`flex gap-1.5 ${entry.severity === "warn" ? WARN_TEXT : "opacity-80"}`}
						key={`${entry.at}-${index}`}>
						<span className="shrink-0 tabular-nums opacity-70">{clockOf(entry.at)}</span>
						{entry.severity === "warn" && (
							<TriangleAlertIcon aria-label="warning" className="mt-[1px] size-3 shrink-0" />
						)}
						<span className="min-w-0 whitespace-pre-wrap break-words">{entry.text}</span>
					</li>
				))}
			</ol>
		</div>
	)
}

function AgentDetail({
	agent,
	onClose,
	onStop,
	onRestart,
	stopping,
	restarting,
}: {
	agent: SubagentStatusItem
	onClose: () => void
	onStop?: () => void
	onRestart?: () => void
	stopping: boolean
	restarting: boolean
}) {
	const identity = subagentIdentity(agent.index, agent.agentName)
	const node = nodeNameOf(agent)
	const doing = agent.latestToolCall?.trim() || (agent.status === "pending" ? "queued" : "thinking")
	const tools = `${agent.toolCalls} tool${agent.toolCalls === 1 ? "" : "s"}`
	const tps = agent.status === "running" && agent.genTps ? `~${agent.genTps} tok/s` : ""
	const details = [
		agent.modelId ?? "",
		agent.contextTokens ? `${Intl.NumberFormat("en-US").format(agent.contextTokens)} tokens` : "",
	].filter(Boolean)
	const tail = outputTail(agent)

	return (
		<div className="mt-2 rounded-xs border border-editor-group-border bg-code px-2.5 py-2">
			{/* Everything that changes while it runs, on one line: who it is,
			    the stop, how far it has got, what it is doing, where and how
			    fast. The stop is absent on a run recorded before agents carried
			    a stop id, rather than shown and doing nothing. */}
			<div className="flex items-center gap-2 text-[10px]">
				<StatusIcon agent={agent} />
				<span
					className="inline-block min-w-0 shrink truncate rounded-xs border px-1.5 py-[1px] font-medium text-foreground"
					style={identity.style}>
					{identity.label}
				</span>
				{onStop && (
					<button
						aria-label={`Stop ${identity.label}`}
						className="flex shrink-0 cursor-pointer items-center gap-1 rounded-xs border border-editor-group-border bg-transparent px-1.5 py-[1px] text-foreground opacity-80 hover:opacity-100 disabled:cursor-default disabled:opacity-40"
						disabled={stopping}
						onClick={onStop}
						title={stopping ? `Stopping ${identity.label}…` : `Stop ${identity.label}`}
						type="button">
						<SquareIcon className="size-2.5 fill-current" />
						<span>{stopping ? "Stopping…" : "Stop"}</span>
					</button>
				)}
				{/* Start it again from its task, keeping its place in the round:
				    for an agent stuck on a stream the server dropped, or looping.
				    Stop loses the task; this keeps it. */}
				{onRestart && (
					<button
						aria-label={`Restart ${identity.label}`}
						className="flex shrink-0 cursor-pointer items-center gap-1 rounded-xs border border-editor-group-border bg-transparent px-1.5 py-[1px] text-foreground opacity-80 hover:opacity-100 disabled:cursor-default disabled:opacity-40"
						disabled={stopping || restarting}
						onClick={onRestart}
						title={
							restarting
								? `Restarting ${identity.label}…`
								: `Restart ${identity.label}: abandon what it is doing and start it again from its task`
						}
						type="button">
						<RefreshCwIcon className={`size-2.5 ${restarting ? "animate-spin" : ""}`} />
						<span>{restarting ? "Restarting…" : "Restart"}</span>
					</button>
				)}
				<span className="shrink-0 opacity-70">{tools}</span>
				<span className="min-w-0 flex-1 truncate font-mono opacity-70">{doing}</span>
				{node && <span className="max-w-[8rem] shrink-0 truncate opacity-70">on {node}</span>}
				{tps && <span className="shrink-0 tabular-nums opacity-70">{tps}</span>}
				<button
					aria-label="Close agent details"
					className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-foreground opacity-60 hover:opacity-100"
					onClick={onClose}
					type="button">
					<XIcon className="size-3" />
				</button>
			</div>
			{details.length > 0 && <div className="mt-1 truncate text-[10px] opacity-60">{details.join(" · ")}</div>}
			{/* What it was asked to do. */}
			<div className="mt-1.5 max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[11px] text-foreground opacity-90">
				{agent.prompt}
			</div>
			<AgentActivity activity={agent.activity ?? []} />
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

	// Which agents were just asked to restart. Cleared after a few seconds: a
	// restart ends in the same agent running again, so there is no end state
	// to wait for, only a press to keep from being repeated.
	const [restarting, setRestarting] = useState<ReadonlySet<string>>(new Set())
	const restart = useCallback((cancelId: string) => {
		setRestarting((previous) => new Set(previous).add(cancelId))
		const clear = () =>
			setRestarting((previous) => {
				const next = new Set(previous)
				next.delete(cancelId)
				return next
			})
		setTimeout(clear, 4000)
		TaskServiceClient.restartSubagent(StringRequest.create({ value: cancelId })).catch((error) => {
			console.error("Failed to restart sub-agent:", error)
			clear()
		})
	}, [])

	// The safety stop: every agent that can be stopped, after a confirmation.
	// A round of 75 has no other way out short of cancelling the task.
	const [confirmingStopAll, setConfirmingStopAll] = useState(false)
	const stoppable = agents.filter((agent) => agent.cancelId !== undefined && !stopping.has(agent.cancelId))
	const stopAll = useCallback(() => {
		setConfirmingStopAll(false)
		for (const agent of stoppable) {
			stop(agent.cancelId as string)
		}
	}, [stoppable, stop])

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
					{stoppable.length > 0 && (
						<button
							aria-label="Stop all agents"
							className="mr-1 flex shrink-0 cursor-pointer items-center gap-1 rounded-xs border border-editor-group-border bg-transparent px-1.5 py-[1px] text-[10px] text-foreground opacity-80 hover:opacity-100"
							onClick={() => setConfirmingStopAll(true)}
							title="Stop every running and queued agent"
							type="button">
							<SquareIcon className="size-2.5 fill-current" />
							<span>Stop all</span>
						</button>
					)}
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
								{hasWarning(agent) && (
									<TriangleAlertIcon aria-label="has a warning" className={`size-3 shrink-0 ${WARN_TEXT}`} />
								)}
							</button>
						)
					})}
				</div>
				<Dialog onOpenChange={setConfirmingStopAll} open={confirmingStopAll}>
					<DialogContent>
						<DialogHeader>
							<DialogTitle className="text-sm">Stop all agents?</DialogTitle>
							<DialogDescription className="text-xs">
								{stoppable.length === 1
									? "The agent that is running or queued will be stopped."
									: `All ${stoppable.length} agents that are running or queued will be stopped.`}{" "}
								Work they have not reported yet is lost. The lead conversation keeps going and gets their results
								as stopped.
							</DialogDescription>
						</DialogHeader>
						<DialogFooter className="gap-2">
							<Button onClick={() => setConfirmingStopAll(false)} size="sm" variant="secondary">
								Keep running
							</Button>
							<Button onClick={stopAll} size="sm" variant="danger">
								Stop {stoppable.length === 1 ? "agent" : `${stoppable.length} agents`}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
				{open && (
					<AgentDetail
						agent={open}
						onClose={() => setOpenIndex(undefined)}
						{...(open.cancelId
							? {
									onStop: () => stop(open.cancelId as string),
									onRestart: () => restart(open.cancelId as string),
								}
							: {})}
						restarting={open.cancelId !== undefined && restarting.has(open.cancelId)}
						stopping={open.cancelId !== undefined && stopping.has(open.cancelId)}
					/>
				)}
			</div>
		</div>
	)
}

export default ActiveSubagents
