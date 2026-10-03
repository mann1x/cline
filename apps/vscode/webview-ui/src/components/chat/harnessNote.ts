/**
 * A note the harness queued for the model, as the chat shows it.
 *
 * The translator emits these as an info row carrying the note whole. A round's
 * report is JSON, up to 28,000 characters of it, and it was rendered as
 * markdown in the middle of the conversation: a 15-agent round was a wall of
 * text nobody could read past. The reader needs one line -- what happened --
 * and the rest on request.
 */

/** How the translator opens a harness note's row. */
export const HARNESS_NOTE_PREFIX = "Note from Cerebriline to the model:"

const HARNESS_TAG = "[SYSTEM MESSAGE]"

export interface HarnessNote {
	/** One line: what the note says. */
	headline: string
	/** Everything else, to unfold. A report is pretty-printed. */
	detail?: string
}

interface RoundSummary {
	total?: number
	completed?: number
	errored?: number
	cancelled?: number
	awaitingLead?: number
}

function countWords(summary: RoundSummary): string {
	const parts = [
		`${summary.total ?? 0} agent${summary.total === 1 ? "" : "s"}`,
		summary.completed ? `${summary.completed} completed` : "",
		summary.errored ? `${summary.errored} errored` : "",
		summary.cancelled ? `${summary.cancelled} cancelled` : "",
		summary.awaitingLead ? `${summary.awaitingLead} waiting for the lead` : "",
	]
	return parts.filter(Boolean).join(", ")
}

/** The note in `text`, or `undefined` when the row is not a harness note. */
export function readHarnessNote(text: string | undefined): HarnessNote | undefined {
	if (!text?.startsWith(HARNESS_NOTE_PREFIX)) {
		return undefined
	}
	let body = text.slice(HARNESS_NOTE_PREFIX.length).trim()
	if (body.startsWith(HARNESS_TAG)) {
		body = body.slice(HARNESS_TAG.length).trim()
	}
	const brace = body.indexOf("\n\n{")
	if (brace >= 0) {
		try {
			const report = JSON.parse(body.slice(brace + 2)) as { summary?: RoundSummary }
			const lead = body
				.slice(0, brace)
				.trim()
				.replace(/[.:]?\s*Report( so far)?:$/, "")
			return {
				headline: report.summary ? `${lead}: ${countWords(report.summary)}` : lead,
				detail: JSON.stringify(report, null, 2),
			}
		} catch {
			// Not a report after all: fold it as text.
		}
	}
	const newline = body.indexOf("\n")
	if (newline < 0) {
		return { headline: body }
	}
	return { headline: body.slice(0, newline).trim(), detail: body.slice(newline + 1).trim() }
}
