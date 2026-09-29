import type { SubagentOutputChunk, SubagentOutputUpdate } from "@shared/proto/cline/task"

/**
 * How much of a step the Inspect view holds: the host keeps the same, so a
 * step that outgrows it loses its start here as it does there.
 */
export const INSPECT_MAX_CHARS = 64 * 1024

/** One stretch of the stream as the view renders it. */
export interface InspectChunk {
	kind: "reasoning" | "text" | "tool"
	text: string
	toolName?: string
	toolCallId?: string
}

function kindOf(value: string): InspectChunk["kind"] {
	return value === "reasoning" || value === "tool" ? value : "text"
}

function sameStretch(a: InspectChunk, b: SubagentOutputChunk): boolean {
	return a.kind === kindOf(b.kind) && (a.toolCallId ?? "") === (b.toolCallId ?? "")
}

/**
 * The view after one update from the host: cleared when it says so, each
 * chunk joined to the last when it continues it, and the start dropped past
 * the cap. Returns a new array; the chunks it keeps from before are copied
 * where they change.
 */
export function applySubagentOutputUpdate(
	current: readonly InspectChunk[],
	update: Pick<SubagentOutputUpdate, "reset" | "chunks">,
	maxChars: number = INSPECT_MAX_CHARS,
): InspectChunk[] {
	const next = update.reset ? [] : [...current]
	for (const chunk of update.chunks ?? []) {
		if (!chunk.text) {
			continue
		}
		const last = next[next.length - 1]
		if (last && sameStretch(last, chunk)) {
			next[next.length - 1] = { ...last, text: last.text + chunk.text }
		} else {
			next.push({
				kind: kindOf(chunk.kind),
				text: chunk.text,
				...(chunk.toolName ? { toolName: chunk.toolName } : {}),
				...(chunk.toolCallId ? { toolCallId: chunk.toolCallId } : {}),
			})
		}
	}
	let chars = next.reduce((sum, chunk) => sum + chunk.text.length, 0)
	while (chars > maxChars && next.length > 0) {
		const first = next[0] as InspectChunk
		const over = chars - maxChars
		if (first.text.length <= over) {
			next.shift()
			chars -= first.text.length
		} else {
			next[0] = { ...first, text: first.text.slice(over) }
			chars -= over
		}
	}
	return next
}

/** A tool call's heading in the view: which tool the arguments are for. */
export function inspectToolHeading(chunk: InspectChunk): string {
	return `${chunk.toolName ?? "tool"} call`
}
