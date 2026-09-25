import type { SubagentCompactionCause, SubagentStatusItem } from "@shared/ExtensionMessage"

/**
 * How many times a sub-agent compacted, said beside its tool count.
 *
 * Nothing when it never has: a row that reads "0 compactions" on every agent
 * of every run says the same thing each time, and the row it sits on already
 * carries the count that matters. Once it has, the count is on the row and
 * why each one ran is in the tooltip.
 */
export function subagentCompactionText(entry: Pick<SubagentStatusItem, "compactions">): string {
	const count = entry.compactions ?? 0
	if (!Number.isFinite(count) || count <= 0) {
		return ""
	}
	return `${Intl.NumberFormat("en-US").format(count)} compaction${count === 1 ? "" : "s"}`
}

const CAUSE_LABEL: Record<SubagentCompactionCause, string> = {
	auto: "own context threshold",
	pressure: "server KV pressure",
	overflow: "overflow recovery",
	manual: "manual",
}

const CAUSE_ORDER: readonly SubagentCompactionCause[] = ["auto", "pressure", "overflow", "manual"]

/**
 * Why each compaction ran, and what the last one did to the context -- the
 * tooltip of the count. Empty when there is no count to explain.
 */
export function subagentCompactionDetail(
	entry: Pick<SubagentStatusItem, "compactions" | "compactionsByCause" | "lastCompaction">,
): string {
	if (!subagentCompactionText(entry)) {
		return ""
	}
	const format = (value: number) => Intl.NumberFormat("en-US").format(value)
	const lines: string[] = []
	const byCause = entry.compactionsByCause ?? {}
	const causes = CAUSE_ORDER.filter((cause) => (byCause[cause] ?? 0) > 0).map(
		(cause) => `${format(byCause[cause] ?? 0)} × ${CAUSE_LABEL[cause]}`,
	)
	if (causes.length > 0) {
		lines.push(`Compactions: ${causes.join(", ")}`)
	}
	const last = entry.lastCompaction
	if (last) {
		const tokens =
			last.tokensBefore !== undefined && last.tokensAfter !== undefined
				? `${format(last.tokensBefore)} → ${format(last.tokensAfter)} tokens`
				: ""
		lines.push(`Last: ${[CAUSE_LABEL[last.cause], tokens].filter(Boolean).join(", ")}`)
	}
	return lines.join("\n")
}
