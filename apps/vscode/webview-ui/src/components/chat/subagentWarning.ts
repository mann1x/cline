import type { SubagentStatusItem } from "@shared/ExtensionMessage"
import { useRef } from "react"

/**
 * Whether an agent's warning sign still means something now.
 *
 * The chip showed a warning for as long as any warning stayed in the agent's
 * activity -- so an agent refused once, then admitted and working, kept the
 * sign for the rest of its run. A warning is current until the agent makes
 * progress after it: new output or a tool call. The activity log keeps the
 * history either way.
 */
export interface WarningSeen {
	/** How many warnings the activity held when last looked at. */
	warnings: number
	/** The agent's progress when the newest of them arrived. */
	progressAtWarning: string
}

export function warningCount(agent: SubagentStatusItem): number {
	return agent.activity?.filter((entry) => entry.severity === "warn").length ?? 0
}

export function progressKey(agent: SubagentStatusItem): string {
	return `${agent.outputTokens}|${agent.toolCalls}`
}

/** The next remembered state, and whether the warning is current in it. */
export function currentWarning(
	agent: SubagentStatusItem,
	seen: WarningSeen | undefined,
): { seen: WarningSeen; current: boolean } {
	const warnings = warningCount(agent)
	const progress = progressKey(agent)
	if (warnings === 0) {
		return { seen: { warnings, progressAtWarning: progress }, current: false }
	}
	const next: WarningSeen =
		seen === undefined || warnings > seen.warnings
			? { warnings, progressAtWarning: progress }
			: { warnings, progressAtWarning: seen.progressAtWarning }
	return { seen: next, current: next.progressAtWarning === progress }
}

/** `currentWarning` for a list of agents, remembered across renders by index. */
export function useCurrentWarnings(agents: readonly SubagentStatusItem[]): (agent: SubagentStatusItem) => boolean {
	const memo = useRef(new Map<number, WarningSeen>())
	const current = new Map<number, boolean>()
	for (const agent of agents) {
		const result = currentWarning(agent, memo.current.get(agent.index))
		memo.current.set(agent.index, result.seen)
		current.set(agent.index, result.current)
	}
	return (agent) => current.get(agent.index) ?? false
}
