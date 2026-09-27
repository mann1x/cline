import type { SubagentStatusItem } from "@shared/ExtensionMessage"
import { useEffect, useRef, useState } from "react"

/**
 * Whether a running sub-agent is still producing anything (#77).
 *
 * The row kept whatever it was last told: a tok/s from the last output
 * report long after the deltas stopped, and nothing at all to tell an agent
 * waiting on a slow model call from one that had gone quiet. Staleness is
 * measured here, from when this view last saw the status change, rather than
 * from a timestamp the extension host stamps: the host can be a remote
 * machine whose clock is not this one's.
 */

/** A generation speed with no new output for this long is not current. */
export const SUBAGENT_TPS_IDLE_MS = 5_000

/** No change at all for this long is said on the row. */
export const SUBAGENT_SILENT_MS = 30_000

/** Everything that changes while an agent does anything. */
export function subagentActivityKey(agent: SubagentStatusItem): string {
	const lastActivity = agent.activity?.[agent.activity.length - 1]
	return JSON.stringify([
		agent.status,
		agent.toolCalls,
		agent.compactions ?? 0,
		agent.inputTokens,
		agent.outputTokens,
		agent.contextTokens,
		agent.latestToolCall ?? "",
		agent.latestOutput ?? "",
		agent.genTps ?? 0,
		agent.phase?.name ?? "",
		agent.phase?.detail ?? "",
		agent.activity?.length ?? 0,
		lastActivity?.at ?? 0,
	])
}

/** What changes only while it generates. */
export function subagentOutputKey(agent: SubagentStatusItem): string {
	return JSON.stringify([agent.latestOutput ?? "", agent.genTps ?? 0])
}

export interface SubagentLivenessSeen {
	activityAt: number
	outputAt: number
}

export interface SubagentLiveness {
	/** The last tok/s is older than SUBAGENT_TPS_IDLE_MS. */
	tpsIdle: boolean
	/** Whole seconds without any change, once past SUBAGENT_SILENT_MS. */
	silentForSec?: number
}

export function subagentLivenessAt(seen: SubagentLivenessSeen, now: number): SubagentLiveness {
	const silentMs = now - seen.activityAt
	return {
		tpsIdle: now - seen.outputAt >= SUBAGENT_TPS_IDLE_MS,
		...(silentMs >= SUBAGENT_SILENT_MS ? { silentForSec: Math.floor(silentMs / 1000) } : {}),
	}
}

/**
 * The liveness of one agent, re-evaluated every second while it runs.
 *
 * The first sighting counts as activity: a view opened on an agent that has
 * been quiet for a minute cannot know that, and saying nothing is better than
 * inventing a number.
 */
export function useSubagentLiveness(agent: SubagentStatusItem, now: () => number = Date.now): SubagentLiveness {
	const activity = subagentActivityKey(agent)
	const output = subagentOutputKey(agent)
	const seen = useRef<(SubagentLivenessSeen & { index: number; activity: string; output: string }) | undefined>(undefined)
	const at = now()
	const current = seen.current
	if (!current || current.index !== agent.index) {
		seen.current = { index: agent.index, activity, output, activityAt: at, outputAt: at }
	} else {
		if (current.activity !== activity) {
			current.activity = activity
			current.activityAt = at
		}
		if (current.output !== output) {
			current.output = output
			current.outputAt = at
		}
	}

	const running = agent.status === "running"
	const [, tick] = useState(0)
	useEffect(() => {
		if (!running) {
			return
		}
		const timer = setInterval(() => tick((n) => n + 1), 1_000)
		return () => clearInterval(timer)
	}, [running])

	return subagentLivenessAt(seen.current as SubagentLivenessSeen, at)
}

/**
 * What the agent is doing, in a few words, from the phase core reports.
 *
 * The row used to say "thinking" whenever no tool was running -- on a node
 * with thinking off, through a prefill, and while the model streamed a long
 * tool call alike -- which named the one thing it was often not doing.
 */
export function subagentPhaseLabel(phase: SubagentStatusItem["phase"]): string | undefined {
	if (!phase) {
		return undefined
	}
	const detail = phase.detail ? ` ${phase.detail}` : ""
	switch (phase.name) {
		case "requesting":
			return "waiting for the model"
		case "server_queued":
			return "queued on the server"
		case "prefill":
			return `prefilling${detail}`
		case "generating":
			return phase.detail ? `generating (${phase.detail})` : "generating"
		case "thinking":
			return "thinking"
		case "writing":
			return "writing"
		case "writing_tool_call":
			return `writing${detail} call`
		case "tool":
			return phase.detail ?? "running a tool"
		case "compacting":
			return "compacting its context"
		case "condensing_thinking":
			return "condensing its thinking"
		case "recovering":
			return "recovering a failed turn"
		case "waiting_room":
			return "waiting for room on the server"
		default:
			return undefined
	}
}

/**
 * Phases in which a silence is the work itself: the server is queuing,
 * prefilling or generating without streaming, or a compaction is running.
 * No output there is expected, and the row says which rather than warning.
 */
const BUSY_PHASES = new Set([
	"server_queued",
	"prefill",
	"generating",
	"compacting",
	"condensing_thinking",
	"recovering",
	"waiting_room",
])

export function isBusySilence(phase: SubagentStatusItem["phase"]): boolean {
	return phase !== undefined && BUSY_PHASES.has(phase.name)
}
