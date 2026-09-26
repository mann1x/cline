import type { SubagentOracleResult, SubagentStatusItem } from "@shared/ExtensionMessage"

/**
 * The two controls the lead sets per agent -- its iteration cap and its check
 * -- as the agent's row states them.
 */

type CapFields = Pick<SubagentStatusItem, "awaitingLead" | "maxIterations" | "stopReason">

/**
 * What the cap did to it, when it did anything: waiting for the lead, or
 * stopped there. An agent that finished under its cap says nothing about it.
 */
export function subagentCapText(item: CapFields): { text: string; warn: boolean } | undefined {
	if (item.awaitingLead?.reason === "looping") {
		return { text: "looping: stopped by the loop guard, awaiting lead", warn: true }
	}
	if (item.awaitingLead) {
		return { text: `awaiting lead (iteration cap ${item.awaitingLead.maxIterations})`, warn: true }
	}
	if (item.stopReason === "loop_guard") {
		return { text: "stopped by the loop guard (looping)", warn: true }
	}
	if (item.stopReason === "iteration_cap") {
		return {
			text: item.maxIterations ? `stopped at iteration cap ${item.maxIterations}` : "stopped at its iteration cap",
			warn: true,
		}
	}
	return undefined
}

/** The check's verdict in a few words, for the row. */
export function subagentOracleText(oracle: SubagentOracleResult | undefined): string | undefined {
	if (!oracle) {
		return undefined
	}
	switch (oracle.status) {
		case "pass":
			return "check: pass"
		case "fail":
			return oracle.exitCode === null ? "check: FAIL (did not run to an exit)" : `check: FAIL (exit ${oracle.exitCode})`
		default:
			return `check: not run${oracle.reason ? ` (${oracle.reason})` : ""}`
	}
}

/** The check in full, for the tooltip: what ran, what it had to say, and what it said. */
export function subagentOracleTitle(oracle: SubagentOracleResult | undefined): string | undefined {
	if (!oracle) {
		return undefined
	}
	const lines: string[] = []
	if (oracle.command) {
		lines.push(`$ ${oracle.command}`)
	}
	if (oracle.expect !== undefined) {
		lines.push(`must exit 0; output ${oracle.must === "not_match" ? "must not match" : "must match"} /${oracle.expect}/`)
	}
	if (oracle.runs !== undefined) {
		lines.push(
			`${oracle.runs} run${oracle.runs === 1 ? "" : "s"}${oracle.exitCode !== null ? `, last exit ${oracle.exitCode}` : ""}`,
		)
	}
	if (oracle.reason) {
		lines.push(oracle.reason)
	}
	if (oracle.output) {
		lines.push("", oracle.output)
	}
	return lines.join("\n")
}
