import type { ClineMessage, ClineSaySubagentStatus, SubagentActivityEntry, SubagentStatusItem } from "@shared/ExtensionMessage"
import { StringRequest } from "@shared/proto/cline/common"
import { StopSubagentRequest } from "@shared/proto/cline/task"
import {
	ClockIcon,
	LoaderCircleIcon,
	PauseIcon,
	RefreshCwIcon,
	SearchIcon,
	SquareIcon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { TaskServiceClient } from "@/services/grpc-client"
import { AgentInspect } from "./AgentInspect"
import { subagentTokenParts } from "./SubagentStatusRow"
import { subagentCompactionDetail, subagentCompactionText } from "./subagentCompactions"
import { subagentCapText, subagentOracleText, subagentOracleTitle } from "./subagentControls"
import { subagentIdentity, subagentModelLabel, subagentSamplingText, subagentSamplingTitle } from "./subagentIdentity"
import { isBusySilence, subagentPhaseLabel, useSubagentLiveness } from "./subagentLiveness"
import { useCurrentWarnings } from "./subagentWarning"

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
	// The sub-agents' most recent row and the teammates' most recent row, each
	// on its own: a teammate works across the turns sub-agents come and go in,
	// so neither kind's row may hide the other's.
	let agents: SubagentStatusItem[] | undefined
	let teammates: SubagentStatusItem[] | undefined
	for (let index = messages.length - 1; index >= 0 && (!agents || !teammates); index -= 1) {
		const message = messages[index]
		if (message?.say !== "subagent" || !message.text) {
			continue
		}
		let parsed: ClineSaySubagentStatus | undefined
		try {
			parsed = JSON.parse(message.text) as ClineSaySubagentStatus
		} catch {
			parsed = undefined
		}
		const live = Array.isArray(parsed?.items) ? parsed.items.filter(isLive) : []
		if (parsed?.kind === "team") {
			teammates ??= live
		} else {
			agents ??= live
		}
	}
	return [...(agents ?? []), ...(teammates ?? [])]
}

/**
 * How an agent is doing, as an icon: working, or waiting for a slot.
 *
 * Per agent and not one for the whole strip: a queued agent and a working one
 * looked the same under a single spinner, and telling them apart is the reason
 * this strip exists.
 */
function StatusIcon({ agent }: { agent: SubagentStatusItem }) {
	// Stopped at its iteration cap: not working, and not waiting for a slot.
	if (agent.awaitingLead) {
		return <PauseIcon aria-label="awaiting lead" className={`size-3 shrink-0 ${WARN_TEXT}`} />
	}
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
						data-copy-row
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

/** How an agent was asked to stop. */
type StopMode = "graceful" | "immediate"

/** What a stop dialog is for: one agent, or every agent that can be stopped. */
type StopTarget = { kind: "one"; cancelId: string; label: string } | { kind: "all" }

/** The dialog's two questions: how to stop, or whether to cut a graceful stop short. */
interface StopDialogView {
	phase: "choose" | "escalate"
	title: string
	body: string
	count: number
}

/**
 * Which question a press asks. The first press chooses graceful or
 * immediate; a press on agents that are all stopping gracefully asks
 * whether to end them at once.
 */
export function stopDialogView(
	target: StopTarget,
	stoppable: readonly SubagentStatusItem[],
	stopping: ReadonlyMap<string, StopMode>,
): StopDialogView {
	const graceful =
		target.kind === "one"
			? stopping.get(target.cancelId) === "graceful"
			: stoppable.length > 0 && stoppable.every((agent) => stopping.get(agent.cancelId as string) === "graceful")
	const count = target.kind === "one" ? 1 : stoppable.length
	if (graceful) {
		return {
			phase: "escalate",
			title:
				target.kind === "one"
					? `${target.label} is stopping gracefully`
					: `${count === 1 ? "1 agent is" : `${count} agents are`} stopping gracefully`,
			body: `${target.kind === "one" ? "It is" : "They are"} finishing the current step, then writing a report for the lead. Stop now ends ${target.kind === "one" ? "it" : "them"} at once: file changes are kept, but there is no report.`,
			count,
		}
	}
	return {
		phase: "choose",
		title: target.kind === "one" ? `Stop ${target.label}?` : "Stop all agents?",
		body: `${target.kind === "all" ? `${count === 1 ? "The agent that is" : `All ${count} agents that are`} running or queued will be stopped. ` : ""}Gracefully: ${target.kind === "one" ? "it finishes" : "each finishes"} the step it is in, then writes a report of what it changed, found and verified, which the lead gets as its result. On a slow node or with a looping model this can take a long time -- press Stop again to end it at once. Now: it ends immediately; its file changes are kept, but there is no report.`,
		count,
	}
}

function StopDialog({
	target,
	view,
	onChoose,
	onClose,
}: {
	target: StopTarget | undefined
	view: StopDialogView | undefined
	onChoose: (mode: StopMode) => void
	onClose: () => void
}) {
	const many = target?.kind === "all" && (view?.count ?? 0) > 1
	return (
		<Dialog onOpenChange={(open) => !open && onClose()} open={target !== undefined && view !== undefined}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle className="text-sm">{view?.title}</DialogTitle>
					<DialogDescription className="text-xs">{view?.body}</DialogDescription>
				</DialogHeader>
				<DialogFooter className="gap-2">
					<Button onClick={onClose} size="sm" variant="secondary">
						{view?.phase === "escalate" ? "Keep waiting" : "Keep running"}
					</Button>
					<Button onClick={() => onChoose("immediate")} size="sm" variant="danger">
						{many ? "Stop all now" : "Stop now"}
					</Button>
					{view?.phase === "choose" && (
						<Button onClick={() => onChoose("graceful")} size="sm">
							{many ? "Stop all gracefully" : "Stop gracefully"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function AgentDetail({
	agent,
	onClose,
	onStop,
	onRestart,
	stopping,
	restarting,
	inspecting,
	onInspect,
}: {
	agent: SubagentStatusItem
	onClose: () => void
	onStop?: () => void
	onRestart?: () => void
	/** How it was asked to stop, while it is stopping. */
	stopping: StopMode | undefined
	restarting: boolean
	/** Showing the live stream in place of its instructions, activity and output. */
	inspecting: boolean
	onInspect: (inspecting: boolean) => void
}) {
	const identity = subagentIdentity(agent.index, agent.agentName)
	const node = nodeNameOf(agent)
	const doing =
		agent.latestToolCall?.trim() ||
		(agent.status === "pending" ? "queued" : (subagentPhaseLabel(agent.phase) ?? "waiting for the model"))
	const tools = `${agent.toolCalls} tool${agent.toolCalls === 1 ? "" : "s"}`
	const compactions = subagentCompactionText(agent)
	// A speed is only shown while output is arriving; with the deltas stopped
	// the last figure is history, and the agent is idle (#77).
	const liveness = useSubagentLiveness(agent)
	// "idle" only where a stop is news: through a prefill or a compaction the
	// output is expected to stop, and the phase already says why.
	const tps =
		agent.status === "running" && agent.genTps
			? liveness.tpsIdle
				? isBusySilence(agent.phase)
					? ""
					: "idle"
				: `~${agent.genTps} tok/s`
			: ""
	const silent = agent.status === "running" ? liveness.silentForSec : undefined
	const model = subagentModelLabel(agent)
	const sampling = subagentSamplingText(agent.sampling)
	// What it spent, in and out -- priced apart -- and the window it holds now.
	const details = subagentTokenParts(agent).filter((part) => part !== "0 tokens")
	const tail = outputTail(agent)
	const cap = subagentCapText(agent)
	const oracle = subagentOracleText(agent.oracle)

	return (
		<div className="mt-2 rounded-xs border border-editor-group-border bg-code px-2.5 py-2">
			{/* Everything that changes while it runs, on one line: who it is,
			    the stop, how far it has got, what it is doing, where and how
			    fast. The stop is absent on a run recorded before agents carried
			    a stop id, rather than shown and doing nothing. */}
			<div className="flex items-center gap-2 text-[10px]" data-copy-row>
				<StatusIcon agent={agent} />
				<span
					className="inline-block min-w-0 shrink truncate rounded-xs border px-1.5 py-[1px] font-medium text-foreground"
					style={identity.style}>
					{identity.label}
				</span>
				{model && (
					<span className="max-w-[12rem] shrink truncate font-mono opacity-70" title={model}>
						{model}
					</span>
				)}
				{onStop && (
					<button
						aria-label={`Stop ${identity.label}`}
						className="flex shrink-0 cursor-pointer items-center gap-1 rounded-xs border border-editor-group-border bg-transparent px-1.5 py-[1px] text-foreground opacity-80 hover:opacity-100 disabled:cursor-default disabled:opacity-40"
						data-copy-skip
						disabled={stopping === "immediate"}
						onClick={onStop}
						title={
							stopping === "graceful"
								? `${identity.label} is finishing its step to report. Press to stop it at once.`
								: stopping
									? `Stopping ${identity.label}…`
									: `Stop ${identity.label}`
						}
						type="button">
						<SquareIcon className="size-2.5 fill-current" />
						<span>{stopping === "graceful" ? "Stopping gracefully…" : stopping ? "Stopping…" : "Stop"}</span>
					</button>
				)}
				{/* Start it again from its task, keeping its place in the round:
				    for an agent stuck on a stream the server dropped, or looping.
				    Stop loses the task; this keeps it. */}
				{onRestart && (
					<button
						aria-label={`Restart ${identity.label}`}
						className="flex shrink-0 cursor-pointer items-center gap-1 rounded-xs border border-editor-group-border bg-transparent px-1.5 py-[1px] text-foreground opacity-80 hover:opacity-100 disabled:cursor-default disabled:opacity-40"
						data-copy-skip
						disabled={stopping !== undefined || restarting}
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
				{compactions && (
					<span className="shrink-0 opacity-70" title={subagentCompactionDetail(agent)}>
						{compactions}
					</span>
				)}
				<span className="min-w-0 flex-1 truncate font-mono opacity-70">{doing}</span>
				{silent !== undefined &&
					(isBusySilence(agent.phase) ? (
						<span
							className="shrink-0 tabular-nums opacity-70"
							title="No output, and none expected: the server or a compaction is working">
							{silent}s
						</span>
					) : (
						<span
							className={`shrink-0 tabular-nums ${WARN_TEXT}`}
							title="Nothing has been reported by this agent for a while: no tokens, no tool call, no phase change">
							no activity for {silent}s
						</span>
					))}
				{node && <span className="max-w-[8rem] shrink-0 truncate opacity-70">on {node}</span>}
				{tps && <span className="shrink-0 tabular-nums opacity-70">{tps}</span>}
				<button
					aria-label="Close agent details"
					className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-foreground opacity-60 hover:opacity-100"
					data-copy-skip
					onClick={onClose}
					type="button">
					<XIcon className="size-3" />
				</button>
			</div>
			{details.length > 0 && <div className="mt-1 truncate text-[10px] opacity-60">{details.join(" · ")}</div>}
			{/* The lead's controls: at its iteration cap, waiting; its check. */}
			{cap && <div className={`mt-1 truncate text-[10px] ${WARN_TEXT}`}>{cap.text}</div>}
			{oracle && (
				<div className="mt-1 truncate font-mono text-[10px] opacity-80" title={subagentOracleTitle(agent.oracle)}>
					{oracle}
				</div>
			)}
			{/* The sampler the lead set on it, as drawn for "random". */}
			{sampling && (
				<div className="mt-1 truncate font-mono text-[10px] opacity-60" title={subagentSamplingTitle(agent.sampling)}>
					{sampling}
				</div>
			)}
			{/* The live stream, over what it was asked, what it did and its
			    output line: the stream needs the room. Needs the id the
			    host keeps the stream under, as the stop does. */}
			{inspecting && agent.cancelId ? (
				<AgentInspect agent={{ ...agent, cancelId: agent.cancelId }} onBack={() => onInspect(false)} />
			) : (
				<>
					{/* What it was asked to do. */}
					<div className="mt-1.5 max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-[11px] text-foreground opacity-90">
						{agent.prompt}
					</div>
					<AgentActivity activity={agent.activity ?? []} />
					{(tail || agent.cancelId) && (
						<div className="mt-1.5">
							<div className="flex items-center gap-2" data-copy-row>
								<div className="text-[10px] opacity-60">
									{agent.latestOutputKind === "reasoning" ? "Thinking" : "Output"}
								</div>
								{agent.cancelId && (
									<button
										aria-label={`Inspect ${identity.label}'s live output`}
										className="flex shrink-0 cursor-pointer items-center gap-1 rounded-xs border border-editor-group-border bg-transparent px-1.5 py-[1px] text-[10px] text-foreground opacity-80 hover:opacity-100"
										data-copy-skip
										onClick={() => onInspect(true)}
										title="Show what the model is generating, as it generates it: thinking, answer and tool calls"
										type="button">
										<SearchIcon className="size-2.5" />
										<span>Inspect</span>
									</button>
								)}
							</div>
							{tail && (
								<pre
									className={`m-0 max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] ${
										agent.latestOutputKind === "reasoning" ? "italic opacity-60" : "opacity-80"
									}`}>
									{tail}
								</pre>
							)}
						</div>
					)}
				</>
			)}
		</div>
	)
}

export function ActiveSubagents({ messages }: { messages: ClineMessage[] }) {
	const agents = useMemo(() => liveSubagentsFrom(messages), [messages])
	const hasWarning = useCurrentWarnings(agents)
	const [openIndex, setOpenIndex] = useState<number | undefined>(undefined)
	// Kept while moving from one agent's tag to the next, so several streams
	// can be looked at in turn; gone with the panel.
	const [inspecting, setInspecting] = useState(false)
	useEffect(() => {
		if (openIndex === undefined) {
			setInspecting(false)
		}
	}, [openIndex])

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

	// Which agents have been asked to stop, and how. The tag stays until the
	// agent actually ends -- a stop is a request, and a graceful one lasts a
	// whole step and a report -- so without it the button would look like it
	// had done nothing. A graceful stop can still be made immediate.
	const [stopping, setStopping] = useState<ReadonlyMap<string, StopMode>>(new Map())
	const stop = useCallback((cancelId: string, mode: StopMode) => {
		setStopping((previous) => new Map(previous).set(cancelId, mode))
		TaskServiceClient.stopSubagent(StopSubagentRequest.create({ id: cancelId, immediate: mode === "immediate" })).catch(
			(error) => {
				console.error("Failed to stop sub-agent:", error)
				setStopping((previous) => {
					const next = new Map(previous)
					next.delete(cancelId)
					return next
				})
			},
		)
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
	// A round of 75 has no other way out short of cancelling the task. Asked
	// how: gracefully, or at once -- and asked again, while agents stop
	// gracefully, whether to end them at once.
	const [confirming, setConfirming] = useState<StopTarget | undefined>(undefined)
	const stoppable = agents.filter((agent) => agent.cancelId !== undefined && stopping.get(agent.cancelId) !== "immediate")
	const confirm = useCallback(
		(mode: StopMode) => {
			const target = confirming
			setConfirming(undefined)
			if (!target) {
				return
			}
			const ids = target.kind === "one" ? [target.cancelId] : stoppable.map((agent) => agent.cancelId as string)
			for (const id of ids) {
				// Graceful leaves one already stopping gracefully as it is.
				if (mode === "immediate" || !stopping.has(id)) {
					stop(id, mode)
				}
			}
		},
		[confirming, stoppable, stopping, stop],
	)

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
			{/* Copied row by row (`compactCopyText`): the browser's own copy
			    puts every flex item on a line of its own. */}
			<div
				className="mx-3 mt-1.5 mb-2 max-h-[40vh] overflow-y-auto rounded-xs border border-editor-group-border bg-code/70 px-2.5 py-2"
				data-copy-compact>
				<div className="flex flex-wrap items-center gap-1" data-copy-row>
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
							data-copy-skip
							onClick={() => setConfirming({ kind: "all" })}
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
								aria-label={`${identity.label} (${agent.awaitingLead ? "awaiting lead" : agent.status === "running" ? "running" : "queued"})`}
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
				<StopDialog
					onChoose={confirm}
					onClose={() => setConfirming(undefined)}
					target={confirming}
					view={confirming ? stopDialogView(confirming, stoppable, stopping) : undefined}
				/>
				{open && (
					<AgentDetail
						agent={open}
						inspecting={inspecting}
						onClose={() => setOpenIndex(undefined)}
						onInspect={setInspecting}
						{...(open.cancelId
							? {
									onStop: () =>
										setConfirming({
											kind: "one",
											cancelId: open.cancelId as string,
											label: subagentIdentity(open.index, open.agentName).label,
										}),
									onRestart: () => restart(open.cancelId as string),
								}
							: {})}
						restarting={open.cancelId !== undefined && restarting.has(open.cancelId)}
						stopping={open.cancelId !== undefined ? stopping.get(open.cancelId) : undefined}
					/>
				)}
			</div>
		</div>
	)
}

export default ActiveSubagents
